// Build step: stamps the footer's "Build:" line in public/index.html with
// the build time (Warsaw local time, with its current UTC offset) and the
// short commit hash. Runs in Workers Builds on a fresh checkout, so the
// stamped file is deployed but never committed; the repo copy says "dev".
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const file = new URL('../public/index.html', import.meta.url);
const now = new Date();

const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).formatToParts(now).map((p) => [p.type, p.value])
);
const offset = parts.timeZoneName.replace('GMT', 'UTC'); // e.g. UTC+2
const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${offset}`;

let commit = process.env.WORKERS_CI_COMMIT_SHA || '';
if (!commit) {
  try { commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch {}
}
const label = commit ? `${stamp} · ${commit.slice(0, 7)}` : stamp;

const html = readFileSync(file, 'utf8');
const re = /Build: [^<]*/;
if (!re.test(html)) {
  console.error('Footer "Build:" text not found in public/index.html');
  process.exit(1);
}
writeFileSync(file, html.replace(re, `Build: ${label}`));
console.log(`Footer stamped: Build: ${label}`);
