-- Neon Pomodoro — schema version 1
-- All timestamps are ISO-8601 UTC strings with millisecond precision
-- (e.g. 2026-10-12T17:04:05.123Z), which sort lexicographically.

CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description         TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  estimated_pomodoros INTEGER CHECK (estimated_pomodoros IS NULL OR estimated_pomodoros BETWEEN 1 AND 99),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  completed_at        TEXT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks (completed_at);

-- One row per finished session (completed, interrupted or abandoned).
-- run_id is generated when a session starts; the UNIQUE constraint makes it
-- impossible to record the same run twice, even if completion fires again.
-- task_title is a snapshot so history survives task deletion (task_id -> NULL).
CREATE TABLE IF NOT EXISTS sessions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                    TEXT    NOT NULL UNIQUE,
  task_id                   INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
  task_title                TEXT,
  session_type              TEXT    NOT NULL CHECK (session_type IN ('focus', 'short_break', 'long_break')),
  planned_duration_seconds  INTEGER NOT NULL CHECK (planned_duration_seconds > 0),
  actual_duration_seconds   INTEGER NOT NULL CHECK (actual_duration_seconds >= 0),
  started_at                TEXT    NOT NULL,
  ended_at                  TEXT    NOT NULL,
  status                    TEXT    NOT NULL CHECK (status IN ('completed', 'interrupted', 'abandoned')),
  completed                 INTEGER NOT NULL CHECK (completed IN (0, 1)),
  CHECK ((status = 'completed') = (completed = 1)),
  CHECK (ended_at >= started_at),
  CHECK (completed = 0 OR actual_duration_seconds = planned_duration_seconds)
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at   ON sessions (ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_task       ON sessions (task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_type_end   ON sessions (session_type, status, ended_at);

CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key   TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The single in-flight session (if any). Persisted so it survives restarts.
-- elapsed_ms holds time accumulated in previous running segments;
-- segment_started_at is set only while running.
CREATE TABLE IF NOT EXISTS active_session (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  run_id                    TEXT    NOT NULL,
  task_id                   INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
  session_type              TEXT    NOT NULL CHECK (session_type IN ('focus', 'short_break', 'long_break')),
  planned_duration_seconds  INTEGER NOT NULL CHECK (planned_duration_seconds > 0),
  started_at                TEXT    NOT NULL,
  state                     TEXT    NOT NULL CHECK (state IN ('running', 'paused')),
  elapsed_ms                INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  segment_started_at        TEXT,
  last_heartbeat_at         TEXT,
  CHECK ((state = 'running') = (segment_started_at IS NOT NULL))
);

-- Small key/value store for timer cycle state (not user settings).
CREATE TABLE IF NOT EXISTS app_state (
  state_key   TEXT PRIMARY KEY,
  state_value TEXT NOT NULL
);
