export const historySchema = {
  table: "CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, ts TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','ask')), reason TEXT NOT NULL CHECK(reason IN ('judged','unavailable','empty','explicit-ask')), command TEXT NOT NULL, model TEXT, latency_ms REAL CHECK(latency_ms IS NULL OR latency_ms >= 0), detail_json TEXT NOT NULL CHECK(json_valid(detail_json)), event_bytes INTEGER NOT NULL CHECK(event_bytes BETWEEN 1 AND 65536))",
  index: "CREATE INDEX events_ts ON events(ts, id)",
}
