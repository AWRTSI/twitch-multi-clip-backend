# Twitch Multi-Clip — backend OAuth

Petit serveur Node/Express dont le seul rôle est de garder le **Client
Secret** de l'application Twitch en sécurité, côté serveur, puisqu'un
secret ne doit jamais être embarqué dans une app mobile (il serait
extractible par n'importe qui).

Il expose deux routes :

- `POST /oauth/token` : échange un code d'autorisation OAuth contre un
  access token + refresh token.
- `POST /oauth/refresh` : rafraîchit un access token expiré.

Aucune donnée utilisateur n'est stockée par ce serveur : chaque requête
est relayée à Twitch puis oubliée.

## Lancer en local

```bash
npm install
cp .env.example .env   # puis renseigne TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET
npm start
```

Le serveur écoute par défaut sur le port 3000 (`GET /health` pour
vérifier qu'il tourne).

## Déployer (Render, gratuit pour ce volume d'usage)

1. Pousse ce dossier dans un dépôt Git (GitHub, GitLab...).
2. Sur https://render.com : **New +** → **Web Service**, connecte le
   dépôt (le fichier `render.yaml` fourni pré-remplit la configuration).
3. Renseigne les variables d'environnement `TWITCH_CLIENT_ID` et
   `TWITCH_CLIENT_SECRET` dans l'onglet *Environment* de Render (jamais
   dans le code ni dans Git).
4. Une fois déployé, note l'URL fournie par Render (ex.
   `https://twitch-multi-clip-backend.onrender.com`) — c'est la valeur à
   mettre dans `app.json` → `extra.BACKEND_URL` côté app mobile.

Railway et Fly.io fonctionnent tout aussi bien si tu préfères ; le code
ne dépend d'aucune spécificité Render en dehors du fichier `render.yaml`
(optionnel).

## Sécurité

- Ne commite jamais `.env` (déjà exclu via `.gitignore`).
- Le `TWITCH_CLIENT_SECRET` ne doit exister que dans les variables
  d'environnement du serveur déployé.
- Un rate-limit basique (100 requêtes/15 min/IP) protège les routes
  `/oauth/*` contre un usage abusif.
