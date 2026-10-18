-- Focus Neon — schema version 3: agenda dates, tags, daily notes, goals.
-- Additive only: no existing column or row is changed except the new
-- tasks.scheduled_date, which is back-filled from each task's creation date.

-- ---------------------------------------------------------------- goals
-- One "Metas e objetivos" entry: title, year, start, completion, action plan,
-- milestones (etapas) and progress (evolução).
CREATE TABLE IF NOT EXISTS goals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  year             INTEGER NOT NULL CHECK (year BETWEEN 1970 AND 2200),
  title            TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  action_plan      TEXT    NOT NULL DEFAULT '' CHECK (length(action_plan) <= 4000),
  start_month      TEXT    CHECK (start_month IS NULL OR start_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  target_date      TEXT    CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  progress_mode    TEXT    NOT NULL DEFAULT 'milestones' CHECK (progress_mode IN ('milestones', 'tasks', 'activity', 'manual')),
  manual_progress  INTEGER NOT NULL DEFAULT 0 CHECK (manual_progress BETWEEN 0 AND 100),
  tag_id           INTEGER REFERENCES tags (id) ON DELETE SET NULL,
  target_minutes   INTEGER CHECK (target_minutes IS NULL OR target_minutes > 0),
  completed_at     TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_year ON goals (year);

CREATE TABLE IF NOT EXISTS goal_milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  title       TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dropped')),
  done_on     TEXT    CHECK (done_on IS NULL OR done_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal ON goal_milestones (goal_id, position);

-- ---------------------------------------------------------------- tags
-- Reusable activity categories (English, Programming, ...). Names are unique,
-- ignoring case.
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 40),
  color       TEXT    NOT NULL DEFAULT 'cyan' CHECK (color IN ('cyan', 'violet', 'amber', 'green', 'pink', 'blue', 'red', 'gray')),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id  INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags (tag_id);

-- The tags a session counted towards, copied from its task when the session
-- was recorded. Changing a task's tags later never rewrites history.
-- tag_name keeps a readable label even if the tag is deleted later.
CREATE TABLE IF NOT EXISTS session_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  tag_id      INTEGER REFERENCES tags (id) ON DELETE SET NULL,
  tag_name    TEXT    NOT NULL,
  UNIQUE (session_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags (tag_id, session_id);
CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags (session_id);

-- ---------------------------------------------------------------- daily notes
-- One free-text note per calendar day (local date, YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS daily_notes (
  note_date   TEXT PRIMARY KEY CHECK (note_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  body        TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------- tasks
-- The day a task belongs to in the Agenda (local date), and an optional goal.
ALTER TABLE tasks ADD COLUMN scheduled_date TEXT
  CHECK (scheduled_date IS NULL OR scheduled_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE tasks ADD COLUMN goal_id INTEGER REFERENCES goals (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks (scheduled_date);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks (goal_id);
