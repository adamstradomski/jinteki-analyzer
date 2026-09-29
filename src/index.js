import { handleCreate } from './create.js';
import { handleResolve } from './resolve.js';

// public/_headers only covers static assets, so the shortener's responses get the same
// security headers here.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
};

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === '/api/shorten') return withSecurityHeaders(await handleCreate(request, env));
    const m = pathname.match(/^\/s\/([^/]+)\/?$/);
    if (m) return withSecurityHeaders(await handleResolve(request, env, ctx, m[1]));
    // Anything else routed here falls back to the static site (headers from public/_headers).
    return env.ASSETS.fetch(request);
  } catch (e) {
    // Typically a free-tier limit being hit; the site falls back to the long link.
    console.error(e);
    return withSecurityHeaders(new Response(JSON.stringify({ error: 'service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }));
  }
}

export default {
  fetch: route,

  // Daily: drop links nobody has opened within RETENTION_DAYS. The build refuses anything but a
  // positive whole number; a bad value that gets here anyway deletes nothing (0 would delete all).
  async scheduled(event, env, ctx) {
    const days = Number(env.RETENTION_DAYS || 180);
    if (!Number.isInteger(days) || days < 1) {
      console.error(`RETENTION_DAYS is not a positive whole number: ${JSON.stringify(env.RETENTION_DAYS)}`);
      return;
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    ctx.waitUntil(env.DB.prepare('DELETE FROM links WHERE last_hit < ?').bind(cutoff).run());
  },
};
