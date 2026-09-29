// Build step: renders wrangler.toml from wrangler.template.toml using build
// variables and stamps the footer build number (scripts/stamp-build.mjs),
// so database IDs, Worker names and URLs stay out of the public repo.
// Fails the build if anything is missing, so a half-configured Worker is
// never deployed.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('..', import.meta.url); // repo root
const template = readFileSync(new URL('wrangler.template.toml', dir), 'utf8');

// Values inserted as raw TOML rather than inside a string.
const RAW = {
  WORKERS_DEV: (v) => v === 'true' || v === 'false',
  ROUTES: (v) => /^\[.*\]$/s.test(v.trim()),
};
// Further checks on values inserted inside a string. The daily cron deletes links not opened
// within RETENTION_DAYS, so 0 would delete every link.
const STRING = {
  RETENTION_DAYS: (v) => /^[1-9][0-9]{0,4}$/.test(v),
};

const missing = [];
const invalid = [];
const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
  const value = process.env[key];
  if (value === undefined || value === '') { missing.push(key); return ''; }
  const ok = RAW[key] ? RAW[key](value) : !/["\\\n\r]/.test(value) && (!STRING[key] || STRING[key](value));
  if (!ok) invalid.push(key);
  return value;
});

if (missing.length || invalid.length) {
  if (missing.length) console.error('Missing build variables: ' + [...new Set(missing)].join(', '));
  if (invalid.length) console.error('Invalid build variables: ' + [...new Set(invalid)].join(', '));
  process.exit(1);
}

writeFileSync(new URL('wrangler.toml', dir), rendered);
console.log('wrangler.toml rendered for Worker "' + process.env.WORKER_NAME + '"');

// Same build step also stamps the footer build number, so the dashboard
// build command stays a single script.
await import('./stamp-build.mjs');
