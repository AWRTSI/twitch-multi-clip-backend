require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 3000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

// Twitch refuse d'enregistrer une redirect URL qui n'est pas en HTTPS (le
// scheme mobile "twitchmulticlip://redirect" est rejeté à l'enregistrement).
// On enregistre donc CETTE route (HTTPS) comme redirect URL côté Twitch, et
// elle se contente de rebondir vers le scheme de l'app une fois le code reçu
// — c'est le pattern standard pour les apps mobiles avec un provider OAuth
// qui n'accepte que HTTPS. L'app mobile ouvre l'URL d'autorisation Twitch
// dans une session web, qui suit ce 302 en interne : dès qu'elle atteint le
// scheme "twitchmulticlip://", l'OS intercepte et referme la session.
const APP_REDIRECT_URL = process.env.APP_REDIRECT_URL || "twitchmulticlip://redirect";

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error(
    "TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET doivent être définis (variables d'environnement)."
  );
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Limite large mais réelle : ce backend ne fait que relayer des échanges
// de tokens déjà initiés par l'utilisateur dans l'app, pas un usage à volume
// élevé. Ça évite qu'un abus (bug côté client, ou script tiers) ne consomme
// le quota API de l'application Twitch enregistrée.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/oauth", limiter);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Redirect URL enregistrée côté Twitch (doit être HTTPS). Reçoit le code
// d'autorisation (ou une erreur) dans l'URL, puis rebondit vers l'app mobile
// via son scheme personnalisé, en conservant tous les paramètres tels quels.
app.get("/auth/callback", (req, res) => {
  const params = new URLSearchParams();
  for (const key of ["code", "state", "scope", "error", "error_description"]) {
    if (req.query[key] !== undefined) params.set(key, req.query[key]);
  }

  const target = `${APP_REDIRECT_URL}?${params.toString()}`;

  // Un simple 302 suffit : la session d'authentification native (iOS/Android)
  // suit la redirection en interne et l'intercepte dès qu'elle atteint le
  // scheme de l'app. Le lien texte ci-dessous n'est qu'un filet de sécurité
  // si jamais le navigateur ne redirige pas automatiquement.
  res.status(302).set("Location", target).send(
    `<!doctype html><html><body>Connexion en cours… <a href="${target}">Continuer</a></body></html>`
  );
});

// Échange le code d'autorisation OAuth contre un access token + refresh
// token. C'est la seule route qui a besoin du Client Secret Twitch — c'est
// pour ça qu'elle ne peut pas vivre directement dans l'app mobile.
app.post("/oauth/token", async (req, res) => {
  const { code, redirect_uri } = req.body ?? {};

  if (!code || !redirect_uri) {
    return res.status(400).json({ error: "invalid_request", error_description: "code et redirect_uri sont requis." });
  }

  try {
    const params = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri,
    });

    const twitchRes = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await twitchRes.json();

    if (!twitchRes.ok) {
      return res.status(twitchRes.status).json(data);
    }

    // On ne renvoie jamais le client_secret, seulement ce que Twitch a
    // renvoyé pour cet échange de tokens.
    return res.json(data);
  } catch (err) {
    console.error("Erreur /oauth/token :", err);
    return res.status(502).json({ error: "server_error", error_description: "Échange du token échoué." });
  }
});

// Rafraîchit un access token expiré à partir du refresh token.
app.post("/oauth/refresh", async (req, res) => {
  const { refresh_token } = req.body ?? {};

  if (!refresh_token) {
    return res.status(400).json({ error: "invalid_request", error_description: "refresh_token est requis." });
  }

  try {
    const params = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token,
    });

    const twitchRes = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await twitchRes.json();

    if (!twitchRes.ok) {
      return res.status(twitchRes.status).json(data);
    }

    return res.json(data);
  } catch (err) {
    console.error("Erreur /oauth/refresh :", err);
    return res.status(502).json({ error: "server_error", error_description: "Rafraîchissement du token échoué." });
  }
});

// Pages HTML minimales qui embarquent le lecteur officiel Twitch (live ou
// clip). Twitch exige que l'iframe précise un paramètre "parent" qui
// correspond au domaine EXACT de la page qui l'affiche : comme l'app mobile
// charge cette page directement depuis ce backend (via une WebView), le
// domaine du backend est le bon "parent" à déclarer.
function twitchEmbedPage(iframeSrc) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden;}iframe{border:0;width:100%;height:100%;display:block;}</style>
</head>
<body>
<iframe src="${iframeSrc}" allowfullscreen allow="autoplay; fullscreen"></iframe>
</body>
</html>`;
}

// Page du lecteur live basée sur l'API JS Twitch.Player. Expose
// window.__setMuted(bool) et window.__setVolume(0..1) : l'app mobile les
// appelle via injectJavaScript sur la WebView (jamais en changeant
// "source.uri") pour piloter le son et le volume en temps réel,
// indépendamment pour chaque live. Le player démarre coupé (muted: true) ;
// si __setMuted/__setVolume sont appelés avant que Twitch.Player.READY ne
// se déclenche, les valeurs sont mémorisées et appliquées dès que le
// lecteur est prêt.
function twitchLivePlayerPage(channel, parent) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden;}#twitch-embed,#twitch-embed iframe{border:0;width:100%;height:100%;display:block;}</style>
</head>
<body>
<div id="twitch-embed"></div>
<script src="https://player.twitch.tv/js/embed/v1.js"></script>
<script>
  var player = null;
  var pendingMuted = null;
  var pendingVolume = null;

  function applyMuted(muted) {
    if (player && typeof player.setMuted === "function") {
      try { player.setMuted(!!muted); } catch (e) {}
    } else {
      pendingMuted = !!muted;
    }
  }
  function applyVolume(volume) {
    if (player && typeof player.setVolume === "function") {
      try { player.setVolume(volume); } catch (e) {}
    } else {
      pendingVolume = volume;
    }
  }
  window.__setMuted = applyMuted;
  window.__setVolume = applyVolume;

  player = new Twitch.Player("twitch-embed", {
    channel: ${JSON.stringify(channel)},
    parent: [${JSON.stringify(parent)}],
    autoplay: true,
    muted: true,
  });
  player.addEventListener(Twitch.Player.READY, function () {
    if (pendingMuted !== null) applyMuted(pendingMuted);
    if (pendingVolume !== null) applyVolume(pendingVolume);
  });
</script>
</body>
</html>`;
}

// Lecteur live officiel Twitch pour un streamer, via l'API JS officielle
// (Twitch.Player) plutôt qu'un simple <iframe src="...">. Contrairement à
// l'iframe brute, l'API JS expose un objet "player" avec setMuted()/setVolume()
// : on peut donc couper/activer le son et régler le volume APRÈS le
// chargement, sans jamais changer l'URL de la WebView — un changement d'URL
// relancerait le lecteur (et donc une nouvelle pub), exactement le bug
// qu'on a corrigé ailleurs. Démarre coupé par défaut (pour éviter un mur de
// son au chargement quand plusieurs lives démarrent en même temps), mais
// chaque live est ensuite indépendant : l'utilisateur peut en activer
// plusieurs à la fois et régler le volume de chacun séparément côté app.
app.get("/embed/player", (req, res) => {
  const channel = (req.query.channel ?? "").toString().trim().toLowerCase();
  if (!channel) return res.status(400).send("Paramètre 'channel' requis.");

  const parent = req.hostname;
  res.set("Content-Type", "text/html").send(twitchLivePlayerPage(channel, parent));
});

// Lecteur officiel Twitch pour un clip déjà créé.
app.get("/embed/clip", (req, res) => {
  const clipId = (req.query.id ?? "").toString().trim();
  if (!clipId) return res.status(400).send("Paramètre 'id' requis.");

  const parent = req.hostname;
  const src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clipId)}&parent=${encodeURIComponent(parent)}&autoplay=false`;
  res.set("Content-Type", "text/html").send(twitchEmbedPage(src));
});

app.listen(PORT, () => {
  console.log(`Backend OAuth Twitch Multi-Clip démarré sur le port ${PORT}`);
});
