-- Focus Neon — schema version 6: reminders.
-- Two kinds, kept apart by `kind`:
--   'once'   : a meeting, appointment, deadline... on one date (time and link optional);
--              never repeats. done_at marks it completed.
--   'annual' : a birthday, anniversary... stored as month + day only, so it comes
--              back every year without new rows (29 Feb shows on 28 Feb in
--              non-leap years). The Agenda reads these for any year it shows.
-- Additive only: no existing table is changed.
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('once', 'annual')),
  title       TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  notes       TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- once
  event_date  TEXT    CHECK (event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  event_time  TEXT    CHECK (event_time IS NULL OR event_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  link        TEXT    CHECK (link IS NULL OR (length(link) <= 2000 AND (link LIKE 'http://%' OR link LIKE 'https://%'))),
  done_at     TEXT,
  -- annual
  month       INTEGER CHECK (month IS NULL OR month BETWEEN 1 AND 12),
  day         INTEGER CHECK (day IS NULL OR day BETWEEN 1 AND 31),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK ((kind = 'once'   AND event_date IS NOT NULL AND month IS NULL AND day IS NULL)
      OR (kind = 'annual' AND month IS NOT NULL AND day IS NOT NULL
                          AND event_date IS NULL AND event_time IS NULL AND link IS NULL AND done_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_reminders_once ON reminders (kind, event_date, event_time);
CREATE INDEX IF NOT EXISTS idx_reminders_annual ON reminders (kind, month, day);
