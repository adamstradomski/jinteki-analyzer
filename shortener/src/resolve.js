import { ID_RE } from './ids.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Kept much shorter than RETENTION_DAYS so popular links still miss the
// cache roughly daily and refresh last_hit before the cron could prune them.
const CACHE_SECONDS = 24 * 60 * 60;

async function notFound(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.MISS_LIMITER.limit({ key: 'miss:' + ip });
  return new Response(success ? 'Link not found' : 'Too many requests', {
    status: success ? 404 : 429,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

// GET /s/:id -> 302 to https://jinteki.win/#log=<payload>
export async function handleResolve(request, env, ctx, id) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!ID_RE.test(id)) return notFound(request, env); // no D1 read for junk IDs

  const url = new URL(request.url);
  const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const row = await env.DB.prepare('SELECT payload FROM links WHERE id = ?').bind(id).first();
  if (!row) return notFound(request, env);

  const res = new Response(null, {
    status: 302,
    headers: {
      Location: `${env.SITE_URL}#log=${row.payload}`,
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'Referrer-Policy': 'no-referrer',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  const now = Date.now();
  // Write at most once a day per link to spare D1's write quota.
  ctx.waitUntil(
    env.DB.prepare('UPDATE links SET last_hit = ? WHERE id = ? AND last_hit < ?')
      .bind(now, id, now - DAY_MS).run()
  );
  return res;
}
