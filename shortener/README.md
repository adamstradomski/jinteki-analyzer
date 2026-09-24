# jinteki-shortener

Cloudflare Worker that serves short share links for jinteki.win, on the free tier.

- `POST /api/shorten` with `{"payload": "gz.…"}` (the `#log=` value built by `index.html`) returns `{"url": "<SITE_URL>s/<id>"}`.
- `GET /s/<id>` redirects (302) to `<SITE_URL>#log=<payload>`.

Only jinteki.win log payloads are accepted — never arbitrary URLs — and each is decoded and checked to look like a real game log. Creation is limited per IP and to the allowed origins; unknown IDs are rate-limited too. Identical logs reuse the same ID. Links not opened for `RETENTION_DAYS` are deleted by a daily cron.

## Configuration

The repo is public, so account details are not committed. `wrangler.toml` is generated at build time from `wrangler.template.toml` by `scripts/render-config.mjs`, using build variables set on each Worker in the Cloudflare dashboard (Settings → Build → Variables and secrets). The build fails if any are missing.

| Variable | Meaning |
|---|---|
| `WORKER_NAME` | Worker name (production and test are separate Workers) |
| `WORKERS_DEV` | `true` or `false`: serve on the workers.dev subdomain |
| `ROUTES` | TOML array of routes, e.g. `[{ pattern = "example.com/s/*", zone_name = "example.com" }]`, or `[]` |
| `SITE_URL` | Site that short links redirect to, with trailing slash |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to create links |
| `RETENTION_DAYS` | Delete links not opened for this many days |
| `D1_NAME`, `D1_ID` | D1 database for this instance |
| `RL_CREATE_NS`, `RL_MISS_NS` | Rate-limit namespace IDs (unique per instance) |

Workers Builds settings for each Worker: root directory `shortener`, build command `node scripts/render-config.mjs`, deploy command `npx wrangler deploy`.

## Database setup

Create one D1 database per instance and run `schema.sql` against it.

Stay on the Workers Free plan: if a daily limit is reached, requests fail until the reset instead of being billed, and the site falls back to the long share link.
