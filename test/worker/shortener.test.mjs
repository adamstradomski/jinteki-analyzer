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

function fakeDb() {
  const rows = [];
  const exec = (sql, args) => {
    if (sql.startsWith('SELECT id FROM links WHERE hash')) return rows.find((r) => r.hash === args[0]) || null;
    if (sql.startsWith('SELECT COUNT(*)')) return { n: rows.filter((r) => r.created_at > args[0]).length };
    if (sql.startsWith('SELECT payload FROM links WHERE id')) return rows.find((r) => r.id === args[0]) || null;
    if (sql.startsWith('INSERT INTO links')) {
      const [id, hash, payload, created_at, last_hit] = args;
      rows.push({ id, hash, payload, created_at, last_hit });
      return null;
    }
    if (sql.startsWith('UPDATE links')) return null;
    throw new Error('unexpected SQL: ' + sql);
  };
  return {
    rows,
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
