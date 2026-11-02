-- Focus Neon — schema version 5: personal media.
-- Startup-sound tracks and the Focus wallpaper. The files themselves are
-- copied into the app's media folder (next to the database); this table only
-- keeps a reference to each stored copy and its metadata. Additive only.
CREATE TABLE IF NOT EXISTS media_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL CHECK (kind IN ('startup_sound', 'wallpaper')),
  -- name of the copy inside the media folder: <uuid>.<ext> (never a user path)
  stored_name    TEXT    NOT NULL UNIQUE CHECK (stored_name GLOB '[0-9a-f]*.*' AND stored_name NOT LIKE '%/%' AND stored_name NOT LIKE '%\%'),
  original_name  TEXT    NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime           TEXT    NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes > 0),
  position       INTEGER NOT NULL DEFAULT 0,
  selected       INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_files (kind, position);
-- Only one Focus wallpaper at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_one_wallpaper ON media_files (kind) WHERE kind = 'wallpaper';
