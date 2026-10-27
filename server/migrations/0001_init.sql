-- FitRoom gateway state on D1.
--
-- `costs`: one metering line per served request (time, session, route,
-- model, source, input/cached-input/output tokens, images, usd). The
-- global budget is the sum of `upstream` usd.
-- `cache`: gateway cache entries by (route, model, key).
-- `counters`: session caps (`session` rows: generations + usd) and the
-- per-IP rate limit (`rate` rows: recent hit timestamps, pruned to the
-- 60-second window on every check; old rows are ignored after it).

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  session TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_costs_source ON costs (source);

CREATE TABLE IF NOT EXISTS cache (
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  key TEXT NOT NULL,
  key_input TEXT NOT NULL,
  data TEXT NOT NULL,
  time TEXT NOT NULL,
  PRIMARY KEY (route, model, key)
);

CREATE TABLE IF NOT EXISTS counters (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
