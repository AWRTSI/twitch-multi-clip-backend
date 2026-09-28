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
// window.__setMuted(bool) : l'app mobile l'appelle via injectJavaScript sur
// la WebView (jamais en changeant "source.uri") pour piloter le son en
// temps réel. Le player démarre coupé (muted: true) ; si __setMuted est
// appelé avant que Twitch.Player.READY ne se déclenche, la valeur est
// mémorisée et appliquée dès que le lecteur est prêt.
//
// Pas de contrôle de volume ici : sur iOS, la propriété "volume" d'une
// vidéo HTML n'est pas modifiable en JavaScript (confirmé par la doc Apple
// — elle reste toujours à 1, seuls les boutons physiques du téléphone
// changent le volume). player.setVolume() serait donc un no-op silencieux
// sur iPhone ; inutile de l'exposer.
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
  var resumeTimer = null;

  function applyMuted(muted) {
    if (player && typeof player.setMuted === "function") {
      try { player.setMuted(!!muted); } catch (e) {}
      // Filet de sécurité minimal : seulement quand CE live est celui que
      // l'utilisateur vient d'activer explicitement, on relance sa lecture
      // au cas où elle se serait arrêtée. On NE le fait PAS quand ce live
      // est simplement coupé (parce qu'un autre prend le relais) : forcer
      // play() sur un live qu'on vient de couper s'est avéré déclencher une
      // nouvelle pub chez Twitch, ce qui est pire que le risque de pause.
      if (!muted && typeof player.play === "function") {
        try { player.play(); } catch (e) {}
      }
    } else {
      pendingMuted = !!muted;
    }
  }
  window.__setMuted = applyMuted;

  function applyQuality() {
    // Force la meilleure qualité disponible ("chunked" = flux source, donc
    // 1080p60 quand le streamer diffuse à cette qualité) plutôt que l'auto
    // par défaut, qui peut descendre en résolution selon le réseau.
    if (player && typeof player.setQuality === "function") {
      try { player.setQuality("chunked"); } catch (e) {}
    }
  }

  // Prévient l'app mobile (via postMessage, lu côté RN dans onMessage) de
  // l'état pause/lecture réel du lecteur, pour qu'elle puisse masquer
  // brièvement ce live avec une vignette pendant la coupure — voir plus bas
  // pourquoi on relance quand même automatiquement la lecture.
  function notifyPlaybackState(isPaused) {
    if (
      typeof window !== "undefined" &&
      window.ReactNativeWebView &&
      typeof window.ReactNativeWebView.postMessage === "function"
    ) {
      try {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: "playbackState", paused: !!isPaused })
        );
      } catch (e) {}
    }
  }

  player = new Twitch.Player("twitch-embed", {
    channel: ${JSON.stringify(channel)},
    parent: [${JSON.stringify(parent)}],
    autoplay: true,
    muted: true,
  });
  applyQuality();
  player.addEventListener(Twitch.Player.READY, function () {
    if (pendingMuted !== null) applyMuted(pendingMuted);
    applyQuality();
  });
  player.addEventListener(Twitch.Player.PAUSE, function () {
    notifyPlaybackState(true);
    // iOS force en pause la WebView qui perd le focus audio dès qu'une
    // autre réclame le son — un comportement système qu'on ne peut pas
    // empêcher (voir la doc Apple sur les sessions audio concurrentes). Le
    // but de l'app étant que TOUS les lives sélectionnés restent en direct
    // en permanence (le son mis à part), on relance nous-mêmes la lecture
    // ici plutôt que de la laisser figée en attendant une action de
    // l'utilisateur. Un léger délai laisse la coupure système se terminer
    // avant de retenter. Le compromis assumé : cette relance peut parfois
    // déclencher une nouvelle pub sur CE live précis, le temps d'un
    // instant — la vignette (voir notifyPlaybackState) masque cet instant
    // pendant qu'il se produit.
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () {
      resumeTimer = null;
      if (player && typeof player.play === "function") {
        try { player.play(); } catch (e) {}
      }
    }, 400);
  });
  player.addEventListener(Twitch.Player.PLAYING, function () {
    notifyPlaybackState(false);
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  });
</script>
</body>
</html>`;
}

// Lecteur live officiel Twitch pour un streamer, via l'API JS officielle
// (Twitch.Player) plutôt qu'un simple <iframe src="...">. Contrairement à
// l'iframe brute, l'API JS expose un objet "player" avec setMuted() : on
// peut donc couper/activer le son APRÈS le chargement, sans jamais changer
// l'URL de la WebView — un changement d'URL relancerait le lecteur (et donc
// une nouvelle pub), exactement le bug qu'on a corrigé ailleurs. Démarre
// coupé par défaut ; un seul live est audible à la fois côté app (iOS gère
// le son de chaque WebView dans un processus séparé et coupe les autres
// dès qu'une nouvelle réclame le son — impossible à éviter depuis ce code,
// donc on ne combat pas ce comportement, on le pilote explicitement).
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
