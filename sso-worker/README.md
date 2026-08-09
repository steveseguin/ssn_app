# Social Stream SSO Worker

Cloudflare Worker source for `sso.socialstream.ninja`. Local Wrangler state and secrets are ignored, and the folder is excluded from Electron Builder packaging.

## Velora Endpoints

- `GET /auth/velora/start`
- `GET /auth/velora/callback`
- `POST /auth/velora/exchange`
- `POST /auth/velora/refresh`

## Twitch Endpoints

- `GET /auth/twitch/start`
- `GET /auth/twitch/callback`
- `POST /auth/twitch/refresh`
- `POST /auth/twitch/chat/messages` (official bot send with source-only Shared Chat delivery)

Use `purpose=bot` on the Twitch start endpoint to request the bot-only scopes (`user:write:chat` and `user:bot`) and force Twitch to show the authorization prompt. SSApp opens this flow in an isolated sign-in window so it cannot silently reuse the main browser account. Normal Twitch sign-in keeps the regular source scopes.

## YouTube Endpoints

Compatibility bridge:

- `GET /youtube/auth`
- `POST /youtube/token`
- `POST /youtube/refresh`

Legacy-root aliases are also supported for old `ytauth` compatibility:

- `GET /auth`
- `POST /token`
- `POST /refresh`

Callback flow:

- `GET /auth/youtube/start`
- `GET /auth/youtube/callback`
- `POST /auth/youtube/refresh`

## Facebook Endpoints

- `GET /auth/facebook/start`
- `GET /auth/facebook/callback`
- `POST /auth/facebook/exchange`
- `POST /auth/facebook/deauthorize`
- `POST /auth/facebook/data-deletion`
- `GET /auth/facebook/data-deletion/status`

Register this redirect URI in the Twitch developer console:

```text
https://sso.socialstream.ninja/auth/twitch/callback
```

Register this redirect URI in the Google Auth Platform:

```text
https://sso.socialstream.ninja/auth/youtube/callback
```

Register this redirect URI in the Meta developer console:

```text
https://sso.socialstream.ninja/auth/facebook/callback
```

The matching app-side auth base will be:

```text
https://sso.socialstream.ninja/auth/velora
https://sso.socialstream.ninja/auth/twitch
https://sso.socialstream.ninja/youtube
https://sso.socialstream.ninja/auth/facebook
```

## Local Setup

```powershell
cd C:\Users\steve\Code\ssapp\sso-worker
npm install
Copy-Item .dev.vars.example .dev.vars
```

Set these values in `.dev.vars`:

```text
STATE_ENCRYPTION_SECRET=...
VELORA_CLIENT_SECRET=...
TWITCH_CLIENT_SECRET=...
YOUTUBE_CLIENT_SECRET=...
FACEBOOK_CLIENT_SECRET=...
```

`STATE_ENCRYPTION_SECRET` should be a random long string. `VELORA_CLIENT_SECRET` can be omitted only if Velora allows public PKCE token exchange for this client. `TWITCH_CLIENT_SECRET` must match the Twitch client ID configured in `wrangler.toml`. `YOUTUBE_CLIENT_SECRET` should match the Google web OAuth client ID configured in `wrangler.toml`; beta clients can temporarily fall back to the legacy `ytauth` bridge until this secret is set. `FACEBOOK_CLIENT_SECRET` must match the Meta app configured for Facebook sign-in.

## Cloudflare Setup

The `TWITCH_APP_TOKEN_CACHE` KV binding stores the encrypted Twitch App Access Token used by the bot-send endpoint. Wrangler can provision this binding when the Worker is deployed.

When ready:

```powershell
npx wrangler login
npx wrangler secret put STATE_ENCRYPTION_SECRET
npx wrangler secret put VELORA_CLIENT_SECRET
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put YOUTUBE_CLIENT_SECRET
npx wrangler secret put FACEBOOK_CLIENT_SECRET
npx wrangler deploy
```

After deployment, `wrangler.toml` attaches the Worker to the existing proxied DNS hostname with the route `sso.socialstream.ninja/*`.

Then update the Velora auth base in:

```text
C:\Users\steve\Code\social_stream\sources\websocket\velora.js
C:\Users\steve\Code\ssapp\resources\electron-velora-handler.js
C:\Users\steve\Code\social_stream\sources\websocket\twitch.js
C:\Users\steve\Code\social_stream\sources\websocket\youtube.html
C:\Users\steve\Code\social_stream\sources\websocket\facebook.js
C:\Users\steve\Code\ssapp\resources\electron-facebook-handler.js
```
