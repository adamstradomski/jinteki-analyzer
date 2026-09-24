const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ID_LENGTH = 8;
export const ID_RE = /^[0-9A-Za-z]{8}$/;

// Random base62 ID. Rejection sampling (bytes >= 248 are discarded) keeps
// every character uniformly likely, so IDs can't be guessed faster than
// brute force over the full 62^8 space.
export function randomId(length = ID_LENGTH) {
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < 248 && out.length < length) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
