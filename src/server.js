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

app.listen(PORT, () => {
  console.log(`Backend OAuth Twitch Multi-Clip démarré sur le port ${PORT}`);
});
