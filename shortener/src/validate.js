// Only jinteki.win share payloads are accepted, never arbitrary URLs, so the
// shortener can't be used as an open redirect or for phishing links.
export const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_DECODED_BYTES = 2 * 1024 * 1024; // zip-bomb guard
const PAYLOAD_RE = /^(gz|raw)\.[A-Za-z0-9_-]+$/;
const LOG_MARKER = /started their turn/i;

export class ValidationError extends Error {}

export function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !!origin && allowed.includes(origin);
}

function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gunzipCapped(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DECODED_BYTES) {
      await reader.cancel();
      throw new ValidationError('decoded log too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Mirrors decodeLogFromUrl() in index.html: the payload must decode to text
// that actually looks like a jinteki.net game log.
export async function validatePayload(payload) {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS || !PAYLOAD_RE.test(payload)) {
    throw new ValidationError('invalid payload format');
  }
  const dot = payload.indexOf('.');
  const method = payload.slice(0, dot);
  let bytes;
  try {
    bytes = base64UrlToBytes(payload.slice(dot + 1));
  } catch {
    throw new ValidationError('invalid base64');
  }
  if (method === 'gz') {
    try {
      bytes = await gunzipCapped(bytes);
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError('invalid gzip data');
    }
  } else if (bytes.length > MAX_DECODED_BYTES) {
    throw new ValidationError('decoded log too large');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError('log is not valid text');
  }
  if (!LOG_MARKER.test(text)) throw new ValidationError('not a jinteki.net game log');
}
