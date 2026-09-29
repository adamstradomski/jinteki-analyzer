// Unit tests for the link shortener Worker (src/), run with: node --test test/worker/
// D1, the rate limiters, the cache and the assets binding are small in-memory fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import worker from '../../src/index.js';
import { validatePayload, ValidationError, MAX_PAYLOAD_CHARS } from '../../src/validate.js';

const ORIGIN = 'https://jinteki.win';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const gz = (text) => 'gz.' + b64url(gzipSync(text));
const realLog = readFileSync(new URL('../jinteki-agenda-win.log', import.meta.url), 'utf8');

// `calls` records every statement run. `onInsert(args, rows)` runs before each INSERT and may
// throw to act out a failed insert (an ID collision, or another request storing the same log).
function fakeDb({ onInsert = () => {} } = {}) {
  const rows = [];
  const calls = [];
  const exec = (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id FROM links WHERE hash')) return rows.find((r) => r.hash === args[0]) || null;
    if (sql.startsWith('SELECT COUNT(*)')) return { n: rows.filter((r) => r.created_at > args[0]).length };
    if (sql.startsWith('SELECT payload FROM links WHERE id')) return rows.find((r) => r.id === args[0]) || null;
    if (sql.startsWith('INSERT INTO links')) {
      onInsert(args, rows);
      const [id, hash, payload, created_at, last_hit] = args;
      rows.push({ id, hash, payload, created_at, last_hit });
      return null;
    }
    if (sql.startsWith('UPDATE links') || sql.startsWith('DELETE FROM links')) return null;
    throw new Error('unexpected SQL: ' + sql);
  };
  return {
    rows,
    calls,
    prepare(sql) {
      return {
        bind: (...args) => ({ first: async () => exec(sql, args), run: async () => exec(sql, args) }),
      };
    },
  };
}

function makeEnv(extra = {}) {
  return {
    DB: fakeDb(),
    CREATE_LIMITER: { limit: async () => ({ success: true }) },
    MISS_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response('asset') },
    ...extra,
  };
}

const ctx = { waitUntil() {} };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const shorten = (env, payload, origin = ORIGIN) =>
  worker.fetch(new Request(`${ORIGIN}/api/shorten`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ payload }),
  }), env, ctx);

test('accepts a real game log', async () => {
  await validatePayload(gz(realLog));
  await validatePayload('raw.' + b64url(realLog.slice(0, 20000)));
});

test('rejects text that is not a game log', async () => {
  await assert.rejects(validatePayload(gz('hello world')), ValidationError);
});

test('rejects a payload over the size cap', async () => {
  const payload = 'raw.' + 'A'.repeat(MAX_PAYLOAD_CHARS);
  await assert.rejects(validatePayload(payload), /invalid payload format/);
});

test('rejects a gzip bomb', async () => {
  const bomb = 'Corp started their turn 1 with 5 and 5 cards in HQ.\n' + 'x'.repeat(3 * 1024 * 1024);
  await assert.rejects(validatePayload(gz(bomb)), /decoded log too large/);
});

test('creates a link, reuses it for the same log, and sets security headers', async () => {
  const env = makeEnv();
  const r1 = await shorten(env, gz(realLog));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(r1.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const { url } = await r1.json();
  assert.match(url, /^https:\/\/jinteki\.win\/s\/[0-9A-Za-z]{8}$/);
  const r2 = await shorten(env, gz(realLog));
  assert.equal((await r2.json()).url, url);
  assert.equal(env.DB.rows.length, 1);
});

test('refuses cross-origin and origin-less requests', async () => {
  const env = makeEnv();
  assert.equal((await shorten(env, gz(realLog), 'https://evil.example')).status, 403);
  assert.equal((await shorten(env, gz(realLog), null)).status, 403);
});

test('stops creating links once the daily cap is reached', async () => {
  const env = makeEnv({ DAILY_CREATE_LIMIT: '1' });
  assert.equal((await shorten(env, gz(realLog))).status, 200);
  const r = await shorten(env, gz(realLog + '\nanother game'));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /daily short link limit/);
  // An existing link is still returned after the cap.
  assert.equal((await shorten(env, gz(realLog))).status, 200);
});

test('resolves a short link with security headers and 404s unknown ones', async () => {
  const env = makeEnv();
  const { url } = await (await shorten(env, gz(realLog))).json();
  const hit = await worker.fetch(new Request(url), env, ctx);
  assert.equal(hit.status, 302);
  assert.match(hit.headers.get('Location'), /^https:\/\/jinteki\.win\/trace\/#log=gz\./);
  assert.equal(hit.headers.get('X-Frame-Options'), 'DENY');
  const miss = await worker.fetch(new Request(`${ORIGIN}/s/AAAAAAAA`), env, ctx);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('X-Content-Type-Options'), 'nosniff');
});

// The pronoun list in one of the two files' turn-start patterns, read from its source.
function pronounsIn(file, pattern) {
  const m = readFileSync(new URL(file, import.meta.url), 'utf8').match(pattern);
  assert.ok(m, `no turn-start pronoun list found in ${file}`);
  return m[1].split('|').sort();
}

test('accepts exactly the turn-start pronouns the page parser knows', async () => {
  // validate.js must accept exactly the logs public/trace/parser.js can read.
  const parser = pronounsIn('../../public/trace/parser.js', /const PRONOUN = '\(\?:([a-z|]+)\)'/);
  const validator = pronounsIn('../../src/validate.js', /const LOG_MARKER = \/started \(\?:([a-z|]+)\) turn /);
  assert.deepEqual(validator, parser);
  assert.ok(parser.length >= 12);
  for (const p of parser) await validatePayload(gz(`Corp started ${p} turn 1 with 5 and 5 cards in HQ.`));
});

test('rejects payloads that are not base64, gzip or UTF-8 text', async () => {
  await assert.rejects(validatePayload(42), /invalid payload format/);
  await assert.rejects(validatePayload('zip.' + b64url('x')), /invalid payload format/);
  await assert.rejects(validatePayload('raw.A'), /invalid base64/); // one leftover character
  await assert.rejects(validatePayload('gz.' + b64url('not gzip at all')), /invalid gzip data/);
  await assert.rejects(validatePayload('raw.' + b64url(Buffer.from([0xff, 0xfe, 0xfd]))), /not valid text/);
});

const post = (env, body, headers = {}) =>
  worker.fetch(new Request(`${ORIGIN}/api/shorten`, {
    method: 'POST', headers: { Origin: ORIGIN, ...headers }, body,
  }), env, ctx);

test('refuses to create with the wrong method, too many requests or too big a body', async () => {
  const get = await worker.fetch(new Request(`${ORIGIN}/api/shorten`), makeEnv(), ctx);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('X-Frame-Options'), 'DENY');

  const limited = makeEnv({ CREATE_LIMITER: { limit: async ({ key }) => ({ success: key !== 'create:203.0.113.9' }) } });
  const r = await post(limited, JSON.stringify({ payload: gz(realLog) }), { 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal(r.status, 429);
  assert.equal(limited.DB.calls.length, 0);

  const env = makeEnv();
  const declared = await post(env, '{}', { 'Content-Length': String(MAX_PAYLOAD_CHARS + 2000) });
  assert.equal(declared.status, 413);
  const oversized = await post(env, JSON.stringify({ payload: 'raw.' + 'A'.repeat(MAX_PAYLOAD_CHARS + 2000) }));
  assert.equal(oversized.status, 413);
  assert.equal(env.DB.calls.length, 0);
});

test('answers 400 with the reason for a body it cannot use', async () => {
  const env = makeEnv();
  const notJson = await post(env, 'payload=gz.abc');
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: 'invalid request body' });
  const notLog = await post(env, JSON.stringify({ payload: gz('hello world') }));
  assert.equal(notLog.status, 400);
  assert.deepEqual(await notLog.json(), { error: 'not a jinteki.net game log' });
  assert.equal(env.DB.rows.length, 0);
});

test('retries with a new ID when an insert collides', async () => {
  let failures = 1;
  const env = makeEnv({ DB: fakeDb({ onInsert: () => { if (failures-- > 0) throw new Error('UNIQUE constraint failed: links.id'); } }) });
  const r = await shorten(env, gz(realLog));
  assert.equal(r.status, 200);
  assert.equal(env.DB.rows.length, 1);
  assert.equal(env.DB.calls.filter((c) => c.sql.startsWith('INSERT')).length, 2);
  assert.equal((await r.json()).url, `${ORIGIN}/s/${env.DB.rows[0].id}`);
});

test('returns the link another request stored for the same log meanwhile', async () => {
  const env = makeEnv({
    DB: fakeDb({
      onInsert: ([, hash], rows) => {
        rows.push({ id: 'Raced123', hash, payload: 'x', created_at: 0, last_hit: 0 });
        throw new Error('UNIQUE constraint failed: links.hash');
      },
    }),
  });
  const r = await shorten(env, gz(realLog));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, `${ORIGIN}/s/Raced123`);
});

test('gives up after three colliding IDs', async () => {
  const env = makeEnv({ DB: fakeDb({ onInsert: () => { throw new Error('UNIQUE constraint failed: links.id'); } }) });
  const r = await shorten(env, gz(realLog));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'could not allocate id' });
  assert.equal(env.DB.calls.filter((c) => c.sql.startsWith('INSERT')).length, 3);
});

test('a hit refreshes last_hit at most once a day, in the background', async (t) => {
  const NOW = Date.UTC(2026, 8, 29, 12);
  t.mock.method(Date, 'now', () => NOW);
  const env = makeEnv();
  const { url } = await (await shorten(env, gz(realLog))).json();
  const id = url.slice(-8);
  const pending = [];
  const hit = await worker.fetch(new Request(url, { method: 'HEAD' }), env, { waitUntil: (p) => pending.push(p) });
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=86400');
  await Promise.all(pending);
  const update = env.DB.calls.find((c) => c.sql.startsWith('UPDATE links'));
  assert.deepEqual(update.args, [NOW, id, NOW - 24 * 60 * 60 * 1000]);
});

test('serves a cached redirect without reading D1', async () => {
  const cached = new Response(null, { status: 302, headers: { Location: `${ORIGIN}/trace/#log=gz.cached` } });
  const keys = [];
  const saved = globalThis.caches;
  globalThis.caches = { default: { match: async (req) => { keys.push(req.url); return cached; }, put: async () => {} } };
  try {
    const env = makeEnv();
    const r = await worker.fetch(new Request(`${ORIGIN}/s/Ab3xK9pQ?utm=x`), env, ctx);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('Location'), `${ORIGIN}/trace/#log=gz.cached`);
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(keys, [`${ORIGIN}/s/Ab3xK9pQ`]); // the query string is not part of the cache key
    assert.equal(env.DB.calls.length, 0);
  } finally {
    globalThis.caches = saved;
  }
});

test('refuses non-GET resolves, and 404s malformed IDs without reading D1', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(`${ORIGIN}/s/Ab3xK9pQ`, { method: 'POST' }), env, ctx);
  assert.equal(r.status, 405);
  for (const junk of ['short', 'Ab3xK9pQ9', 'Ab3x-9pQ']) {
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/s/${junk}`), env, ctx)).status, 404, junk);
  }
  assert.equal(env.DB.calls.length, 0);
});

test('rate-limits repeated misses per IP', async () => {
  const env = makeEnv({ MISS_LIMITER: { limit: async ({ key }) => ({ success: key !== 'miss:198.51.100.7' }) } });
  const req = (ip) => new Request(`${ORIGIN}/s/AAAAAAAA`, { headers: { 'CF-Connecting-IP': ip } });
  assert.equal((await worker.fetch(req('198.51.100.1'), env, ctx)).status, 404);
  const limited = await worker.fetch(req('198.51.100.7'), env, ctx);
  assert.equal(limited.status, 429);
  assert.equal(await limited.text(), 'Too many requests');
});

test('other paths fall through to the static site', async () => {
  const seen = [];
  const env = makeEnv({ ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset'); } } });
  const r = await worker.fetch(new Request(`${ORIGIN}/api/other`), env, ctx);
  assert.equal(await r.text(), 'asset');
  assert.deepEqual(seen, ['/api/other']);
});

test('a failing binding answers 503 with security headers', async (t) => {
  t.mock.method(console, 'error', () => {});
  const env = makeEnv({ CREATE_LIMITER: { limit: async () => { throw new Error('daily limit exceeded'); } } });
  const r = await shorten(env, gz(realLog));
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'service unavailable' });
  assert.equal(r.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('the daily cron deletes links not opened within RETENTION_DAYS', async (t) => {
  const NOW = Date.UTC(2026, 8, 29, 3, 17);
  const DAY = 24 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => NOW);
  for (const [days, expected] of [['30', 30], [undefined, 180]]) {
    const env = makeEnv({ RETENTION_DAYS: days });
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.deepEqual(env.DB.calls, [{ sql: 'DELETE FROM links WHERE last_hit < ?', args: [NOW - expected * DAY] }]);
  }
});

test('the daily cron deletes nothing when RETENTION_DAYS is not a positive whole number', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const days of ['0', '-1', '1.5', 'six months']) {
    const env = makeEnv({ RETENTION_DAYS: days });
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.deepEqual(env.DB.calls, [], days);
  }
  assert.equal(errors.mock.callCount(), 4);
});
