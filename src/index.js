import { handleCreate } from './create.js';
import { handleResolve } from './resolve.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/shorten') return await handleCreate(request, env);
      const m = pathname.match(/^\/s\/([^/]+)\/?$/);
      if (m) return await handleResolve(request, env, ctx, m[1]);
      // Anything else routed here falls back to the static site.
      return env.ASSETS.fetch(request);
    } catch (e) {
      // Typically a free-tier limit being hit; the site falls back to the long link.
      console.error(e);
      return new Response(JSON.stringify({ error: 'service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  },

  // Daily: drop links nobody has opened within RETENTION_DAYS.
  async scheduled(event, env, ctx) {
    const days = Number(env.RETENTION_DAYS || 180);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    ctx.waitUntil(env.DB.prepare('DELETE FROM links WHERE last_hit < ?').bind(cutoff).run());
  },
};
