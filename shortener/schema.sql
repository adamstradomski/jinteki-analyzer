CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,      -- 8-char base62
  hash       TEXT NOT NULL UNIQUE,  -- SHA-256 of payload, for dedupe
  payload    TEXT NOT NULL,         -- "gz.<base64url>" or "raw.<base64url>"
  created_at INTEGER NOT NULL,      -- ms since epoch
  last_hit   INTEGER NOT NULL       -- ms since epoch, refreshed at most daily
);
CREATE INDEX IF NOT EXISTS idx_links_last_hit ON links(last_hit);
