# ssapp Error Logger — Cloudflare Setup

One-time setup using [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

## Prerequisites

```bash
npm install -g wrangler
wrangler login          # opens browser to authenticate with your Cloudflare account
```

---

## 1. Create the D1 database

```bash
cd cloudflare
wrangler d1 create ssapp-logs
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
database_id = "PASTE_ID_HERE"
```

---

## 2. Create the table

```bash
wrangler d1 execute ssapp-logs --file=schema.sql
```

---

## 3. Set the auth token secret

Pick any random string (e.g. `openssl rand -hex 32`) and run:

```bash
wrangler secret put REPORT_TOKEN
# paste your token when prompted
```

Then put the **same token** into `error-reporter.js` in the app:

```js
const WORKER_TOKEN = 'your-token-here';
```

---

## 4. Deploy the Worker

```bash
wrangler deploy
```

The output will show your Worker URL, e.g.:
```
https://ssapp-error-logger.YOUR_SUBDOMAIN.workers.dev
```

Put that URL into `error-reporter.js`:

```js
const WORKER_URL = 'https://ssapp-error-logger.YOUR_SUBDOMAIN.workers.dev/log';
```

---

## 5. Test it

```bash
curl -X POST https://ssapp-error-logger.YOUR_SUBDOMAIN.workers.dev/log \
  -H "Content-Type: application/json" \
  -H "X-Report-Token: your-token-here" \
  -d '{"install_id":"test-1","version":"0.0.0","type":"test","message":"hello"}'
```

Should return `ok`.

---

## Querying logs

From the Cloudflare dashboard → Workers & Pages → D1 → ssapp-logs → Console, or via Wrangler:

```bash
# All errors for a specific install
wrangler d1 execute ssapp-logs \
  --command "SELECT * FROM error_logs WHERE install_id='<id>' ORDER BY created_at DESC LIMIT 50"

# Most common error types across all users
wrangler d1 execute ssapp-logs \
  --command "SELECT type, count(*) as n FROM error_logs GROUP BY type ORDER BY n DESC"

# All TikTok WS errors in the last 7 days
wrangler d1 execute ssapp-logs \
  --command "SELECT install_id, version, context_json, created_at FROM error_logs WHERE type='tiktok_ws_close' AND created_at > datetime('now','-7 days') ORDER BY created_at DESC"

# All errors for a specific version
wrangler d1 execute ssapp-logs \
  --command "SELECT * FROM error_logs WHERE version='0.3.106' ORDER BY created_at DESC"
```

---

## Notes

- `settings_json` contains the full electron-store contents for the session, including credentials — treat the D1 database as sensitive.
- The Worker rejects requests without the correct `X-Report-Token` header (401).
- The app rate-limits to one report per error type per minute per session, so volume should stay low.
