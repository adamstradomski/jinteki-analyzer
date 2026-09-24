import { randomId, sha256Hex } from './ids.js';
import { isAllowedOrigin, validatePayload, ValidationError, MAX_PAYLOAD_CHARS } from './validate.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// POST /api/shorten  body: {"payload": "gz.xxxx"}  ->  {"url": "https://jinteki.win/s/Ab3xK9pQ"}
export async function handleCreate(request, env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!isAllowedOrigin(request, env)) return json({ error: 'forbidden origin' }, 403);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.CREATE_LIMITER.limit({ key: 'create:' + ip });
  if (!success) return json({ error: 'too many requests' }, 429);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_PAYLOAD_CHARS + 1024) return json({ error: 'payload too large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_PAYLOAD_CHARS + 1024) return json({ error: 'payload too large' }, 413);

  let payload;
  try {
    payload = JSON.parse(raw).payload;
    await validatePayload(payload);
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : 'invalid request body';
    return json({ error: msg }, 400);
  }

  const hash = await sha256Hex(payload);
  const base = env.SITE_URL.replace(/\/$/, '');

  // Same log -> same ID, so repeated submits never grow storage.
  const existing = await env.DB.prepare('SELECT id FROM links WHERE hash = ?').bind(hash).first();
  if (existing) return json({ url: `${base}/s/${existing.id}` });

  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomId();
    try {
      await env.DB.prepare(
        'INSERT INTO links (id, hash, payload, created_at, last_hit) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, hash, payload, now, now).run();
      return json({ url: `${base}/s/${id}` });
    } catch (e) {
      // Either an ID collision (retry) or a concurrent insert of the same hash.
      const raced = await env.DB.prepare('SELECT id FROM links WHERE hash = ?').bind(hash).first();
      if (raced) return json({ url: `${base}/s/${raced.id}` });
    }
  }
  return json({ error: 'could not allocate id' }, 500);
}
