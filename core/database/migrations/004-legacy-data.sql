-- Focus Neon — schema version 4: legacy data.
-- Weekly productivity totals copied by hand from paper planners, from before
-- Focus Neon was used. Additive only: sessions, tasks, notes and goals are
-- never touched. Each row is one figure for one calendar week:
--   kind 'pomodoros' : total Pomodoros (TTP) that week          -> value = count
--   kind 'tag_hours' : time spent on one tag that week          -> value = seconds
-- (year, week) follow Settings → "Weeks start on", like the Agenda.
-- tag_name keeps a readable label if the tag is deleted later (tag_id then
-- becomes NULL and the hours stop counting under any tag).
CREATE TABLE IF NOT EXISTS legacy_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  year        INTEGER NOT NULL CHECK (year BETWEEN 1970 AND 2200),
  week        INTEGER NOT NULL CHECK (week BETWEEN 1 AND 53),
  kind        TEXT    NOT NULL CHECK (kind IN ('pomodoros', 'tag_hours')),
  tag_id      INTEGER REFERENCES tags (id) ON DELETE SET NULL,
  tag_name    TEXT    CHECK (tag_name IS NULL OR length(tag_name) <= 40),
  value       INTEGER NOT NULL CHECK (value > 0),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK ((kind = 'pomodoros' AND tag_name IS NULL AND tag_id IS NULL)
      OR (kind = 'tag_hours' AND tag_name IS NOT NULL))
);

-- No duplicates: one TTP figure per week, one hours figure per week and tag.
-- Rows whose tag was deleted (tag_id NULL) never clash with each other.
CREATE UNIQUE INDEX IF NOT EXISTS ux_legacy_week_metric ON legacy_records (
  year, week, kind,
  CASE WHEN kind = 'pomodoros' THEN 0 WHEN tag_id IS NULL THEN -id ELSE tag_id END
);
CREATE INDEX IF NOT EXISTS idx_legacy_tag ON legacy_records (tag_id);
