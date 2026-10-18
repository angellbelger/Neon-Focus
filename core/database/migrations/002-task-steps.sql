-- Focus Neon — schema version 2: steps (sub-tasks) inside a task.
-- Steps belong to exactly one task and are deleted with it (ON DELETE CASCADE).
-- position keeps the order the user added them in.

CREATE TABLE IF NOT EXISTS task_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  title        TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  completed    INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  completed_at TEXT,
  CHECK ((completed = 1) = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps (task_id, position);
