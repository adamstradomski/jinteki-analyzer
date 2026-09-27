# jinteki.win

Netrunner tools on [jinteki.win](https://jinteki.win/). The landing page at `/` links to both apps:

- **Trace** (`/trace/`): a single-page, client-side log analyzer for [jinteki.net](https://jinteki.net) games, described below.
- **Market Research** (`/market-research/`): card meta from NSG Netrunner Standard tournaments. See [docs/market-research/](docs/market-research/).

Trace: Paste (or bookmarklet-import) a finished game's chat log and get parsed stats, per-turn charts, and a per-card credit/cost breakdown — no server, no accounts, nothing leaves your browser unless you explicitly opt in.

**Live site:** [jinteki.win](https://jinteki.win/), Trace at [jinteki.win/trace/](https://jinteki.win/trace/)

## Features

- **Log parsing** — paste the log text from the jinteki.net chat panel and parse it into structured turn-by-turn data.
- **Browser bookmarklet** — drag a bookmarklet into your bookmarks bar; on any finished jinteki.net game, one click extracts the log and opens it here already parsed, no copy/paste.
- **Game summary & stats** — turns played, credits, draws, runs, installs, and other per-player totals.
- **Achievements** — per-player Corp/Runner achievements for the game (e.g. won without clicking for credits, flatline and mill wins, comebacks from 0–6), shown as tags next to the chat badges in the game summary with the description on hover. Defined in one `ACHIEVEMENTS` list in `public/trace/index.html`.
- **Charts** — agenda points, net credits gained per turn, credit pool over time, cards in hand, and cumulative cards drawn, plotted both by each player's own turn number and on a shared/interleaved turn-order axis.
- **Per-card tables** — credits gained/spent and net value attributed to each installed card, plus operations/events, with a flagged-lines list for anything the parser couldn't confidently resolve.
- **Share link** — compresses the pasted log and encodes it into a URL fragment (`/trace/#log=...`) so a whole game can be shared as a link. The log never touches a server; only whoever has the link can decode it in their own browser.
- **Report a bug** — opens a prefilled GitHub issue, including an auto-generated share link to the log that triggered the problem.
- **Optional short links** — opt-in only; unlike the plain share link, this stores the encoded log on jinteki.win's own shortener (`src/`, run by the site's Cloudflare Worker) and returns a `jinteki.win/s/<id>` link.

## Privacy

Everything runs client-side. Nothing about a pasted log is uploaded anywhere unless you explicitly click "Shorten link", which is called out in the UI and in the page footer.

## Development

Trace is a single static file, `public/trace/index.html`, with no build step, no dependencies, and no package manager. To work on it locally, open it in a browser, or serve `public/` with any static file server. The landing page (`public/index.html`) and Market Research load their files from site-root paths or as ES modules, so serve `public/` for those.

Trace used to live at `/`. Old share links and installed bookmarklets still point at `https://jinteki.win/#log=…`, so `public/home.js` forwards any `#log=` hash on the landing page to `/trace/` before it paints. Keep that forwarding in place.

The pages' look comes from the jinteki.win design system, copied into `public/shared/jw/` (shared with the Market Research page): `tokens.css` (colours per theme, generated from `tokens.json` by `build-tokens.mjs`; don't edit it by hand), `bundle.css` (fonts, shapes and components) and `bundle.js` (`window.JW`: theme switching and resolved chart colours). The header offers four theme families (Beanstalk, Ice Wall, Console, Night City) and a separate Dark | Light toggle; the choices are saved in `localStorage['jw-theme']` and `localStorage['jw-mode']`, and with no saved mode the page follows the system's light/dark setting. Style new UI with the tokens (`var(--panel)`, `var(--accent)` …) and the `.btn` / `.btn.secondary` classes rather than hex values, so it follows the theme.

Real and synthetic game logs with their expected results are in `test/` (see `test/README.md`). To test a change, paste one of those or one of the two built-in example logs (via the "Log example 1/2" buttons) and confirm the parsed output looks right, or use `/code-review` / `/simplify` if you're using Claude Code against this repo.

## Deployment

The site runs on one Cloudflare Worker per environment, built from this repo with Workers Builds:

- `public/` holds the static site, served directly as Worker static assets.
- `src/` is the Worker code for the link shortener: `POST /api/shorten` creates a short link, `GET /s/<id>` redirects to `/trace/#log=<payload>`. Only these paths run code.
- `schema.sql` is the D1 schema; each environment has its own database.

Production (`jinteki-analyzer`, from `main`) serves jinteki.win; the test Worker (`jinteki-analyzer-test`) is an identical copy with its own database on its workers.dev URL.

The repo is public, so account details aren't committed. `wrangler.toml` is generated at build time from `wrangler.template.toml` by `scripts/render-config.mjs`, using each Worker's build variables (Settings → Build → Variables and secrets). The build fails if any are missing. The same build step stamps the footer's build time and commit (`scripts/stamp-build.mjs`); the committed page just says `Build: dev`.

| Variable | Meaning |
|---|---|
| `WORKER_NAME` | Worker name; must match the Worker being built |
| `WORKERS_DEV` | `true` or `false`: serve on the workers.dev subdomain |
| `ROUTES` | TOML array of routes or custom domains, or `[]` |
| `RETENTION_DAYS` | Delete short links not opened for this many days |
| `D1_NAME`, `D1_ID` | D1 database for this environment |
| `RL_CREATE_NS`, `RL_MISS_NS` | Rate-limit namespace IDs (unique per environment) |

Build settings: root directory `/`, build command `node scripts/render-config.mjs`, deploy command `npx wrangler deploy`.

Short links accept only this site's log payloads (never arbitrary URLs), are created only from the site's own origin, are rate-limited per IP, and identical logs reuse the same link. Stay on the Workers Free plan: if a daily limit is reached, requests fail until the reset instead of being billed, and the site falls back to the long share link.

## Market Research

`/market-research/` is a second page: tournament card meta (most played cards, trends, winrates, top-cut conversion) for NSG Netrunner Standard, built from [AlwaysBeRunning.net](https://alwaysberunning.net), NSG Cobra and NetrunnerDB data. The page lives in `public/market-research/` and reads precomputed snapshots from `data.jinteki.win`; the batch pipeline that builds them is in [`market-research/`](market-research/README.md), with docs in [`docs/market-research/`](docs/market-research/architecture.md).

## Support

If this tool is useful to you, consider [supporting it on Ko-fi](https://ko-fi.com/inermis2020).

## Reporting issues

Use the in-app "Report a bug" button (it auto-fills a template and a share link to the log in question), or open an issue directly at [github.com/adamstradomski/jinteki-analyzer/issues](https://github.com/adamstradomski/jinteki-analyzer/issues/new).
