// Tests for the build scripts: scripts/*.mjs and public/shared/jw/build-tokens.mjs. Each script
// reads and writes files relative to its own location, so every test runs copies of the files it
// needs in a temporary directory laid out like the repo.   node --test test/scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url);
const BUILD_VARS = ['WORKER_NAME', 'WORKERS_DEV', 'ROUTES', 'RETENTION_DAYS', 'D1_NAME', 'D1_ID', 'RL_CREATE_NS', 'RL_MISS_NS'];
const GOOD_VARS = {
  WORKER_NAME: 'jinteki-analyzer-test',
  WORKERS_DEV: 'true',
  ROUTES: '[{ pattern = "jinteki.win", custom_domain = true }]',
  RETENTION_DAYS: '180',
  D1_NAME: 'jinteki-links-test',
  D1_ID: '00000000-0000-4000-8000-000000000000',
  RL_CREATE_NS: '1001',
  RL_MISS_NS: '1002',
};
const SHA = '0123456789abcdef0123456789abcdef01234567';

function sandbox(t, files){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinteki-scripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of files){
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(new URL(f, ROOT), path.join(dir, f));
  }
  return dir;
}

// Runs a script with the build variables replaced by `vars` (none set unless given).
function run(dir, script, vars = {}, args = []){
  const env = { ...process.env, WORKERS_CI_COMMIT_SHA: SHA };
  for (const k of BUILD_VARS) delete env[k];
  return spawnSync(process.execPath, [path.join(dir, script), ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...vars } });
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const RENDER = ['scripts/render-config.mjs', 'scripts/stamp-build.mjs', 'wrangler.template.toml', 'public/trace/index.html'];

test('render-config fills in every build variable and stamps the footer', (t) => {
  const dir = sandbox(t, RENDER);
  const r = run(dir, 'scripts/render-config.mjs', GOOD_VARS);
  assert.equal(r.status, 0, r.stderr);
  const toml = read(dir, 'wrangler.toml');
  assert.doesNotMatch(toml, /\$\{/);
  assert.match(toml, /^name = "jinteki-analyzer-test"$/m);
  assert.match(toml, /^workers_dev = true$/m);
  assert.match(toml, /^routes = \[\{ pattern = "jinteki.win", custom_domain = true \}\]$/m);
  assert.match(toml, /^database_id = "00000000-0000-4000-8000-000000000000"$/m);
  assert.match(toml, /^namespace_id = "1002"$/m);
  // Warsaw local time with its UTC offset, then the short commit.
  assert.match(read(dir, 'public/trace/index.html'), /Build: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\+[12] · 0123456<\/footer>/);
});

test('render-config fails on missing build variables and writes nothing', (t) => {
  const dir = sandbox(t, RENDER);
  const { D1_ID, RL_MISS_NS, ...some } = GOOD_VARS;
  const r = run(dir, 'scripts/render-config.mjs', { ...some, RL_CREATE_NS: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Missing build variables: D1_ID, RL_CREATE_NS, RL_MISS_NS$/m);
  assert.equal(fs.existsSync(path.join(dir, 'wrangler.toml')), false);
  assert.match(read(dir, 'public/trace/index.html'), /Build: dev</);
});

test('render-config refuses values that would break the TOML', (t) => {
  const dir = sandbox(t, RENDER);
  const r = run(dir, 'scripts/render-config.mjs', {
    ...GOOD_VARS, WORKERS_DEV: 'yes', ROUTES: 'jinteki.win', D1_NAME: 'db" = 1', RETENTION_DAYS: '180\n',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Invalid build variables: WORKERS_DEV, ROUTES, RETENTION_DAYS, D1_NAME$/m);
  assert.equal(fs.existsSync(path.join(dir, 'wrangler.toml')), false);
});

test('stamp-build fails when the footer has no Build: text', (t) => {
  const dir = sandbox(t, ['scripts/stamp-build.mjs', 'public/trace/index.html']);
  fs.writeFileSync(path.join(dir, 'public/trace/index.html'), '<footer>no stamp here</footer>');
  const r = run(dir, 'scripts/stamp-build.mjs');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer "Build:" text not found/);
});

test('build-bookmarklet --check catches an out-of-date href, and a build fixes it', (t) => {
  const dir = sandbox(t, ['scripts/build-bookmarklet.mjs', 'public/trace/bookmarklet.src.js', 'public/trace/index.html']);
  assert.equal(run(dir, 'scripts/build-bookmarklet.mjs', {}, ['--check']).status, 0);
  const src = path.join(dir, 'public/trace/bookmarklet.src.js');
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace('Preparing your Trace link...', 'Preparing your link...'));
  const stale = run(dir, 'scripts/build-bookmarklet.mjs', {}, ['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /out of date/);
  assert.equal(run(dir, 'scripts/build-bookmarklet.mjs').status, 0);
  assert.equal(run(dir, 'scripts/build-bookmarklet.mjs', {}, ['--check']).status, 0);
  assert.match(read(dir, 'public/trace/index.html'), /Preparing%20your%20link/);
});

test('tokens.css is what build-tokens.mjs generates from tokens.json', (t) => {
  const dir = sandbox(t, ['public/shared/jw/build-tokens.mjs', 'public/shared/jw/tokens.json']);
  const r = run(dir, 'public/shared/jw/build-tokens.mjs');
  assert.equal(r.status, 0, r.stderr);
  const committed = fs.readFileSync(new URL('public/shared/jw/tokens.css', ROOT), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, read(dir, 'public/shared/jw/tokens.css'), 'tokens.css is stale: run node public/shared/jw/build-tokens.mjs');
});
