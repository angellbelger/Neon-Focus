'use strict';

const { cleanDate, localDate } = require('../../dates');

/** undefined -> keep/default, null or '' -> no date, otherwise a validated YYYY-MM-DD. */
function cleanScheduled(value) {
  if (value === null || value === '') return null;
  return cleanDate(value, 'Task date');
}

function cleanGoalId(value) {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('Invalid goal.');
  return n;
}

function cleanTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Give the task a title.');
  const t = title.trim();
  if (t.length > 200) throw new Error('Task titles can be up to 200 characters.');
  return t;
}

function cleanDescription(desc) {
  if (desc === undefined || desc === null) return '';
  if (typeof desc !== 'string') throw new Error('Description must be text.');
  if (desc.length > 2000) throw new Error('Descriptions can be up to 2000 characters.');
  return desc.trim();
}

function cleanEstimate(est) {
  if (est === undefined || est === null || est === '') return null;
  const n = Number(est);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('Estimate must be between 1 and 99 Pomodoros.');
  return n;
}

function cleanId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('Invalid task id.');
  return n;
}

/**
 * Task queries. Pomodoro counts and time spent are always derived from the
 * sessions table, never stored as counters on the task.
 */
class TasksRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() {
    return new Date(this.clock()).toISOString();
  }

  /** @param {{status?: 'active'|'completed'|'all'}} opts */
  list({ status = 'all' } = {}) {
    const where = status === 'all' ? '' : 'WHERE t.status = ?';
    const params = status === 'all' ? [] : [status];
    return this.db.all(
      `SELECT t.*,
              COALESCE(SUM(CASE WHEN s.session_type = 'focus' AND s.completed = 1 THEN 1 ELSE 0 END), 0) AS completed_pomodoros,
              COALESCE(SUM(CASE WHEN s.session_type = 'focus' THEN s.actual_duration_seconds ELSE 0 END), 0) AS focus_seconds,
              MAX(s.ended_at) AS last_worked_at
         FROM tasks t
         LEFT JOIN sessions s ON s.task_id = t.id
         ${where}
        GROUP BY t.id
        ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END, COALESCE(t.completed_at, t.created_at) DESC`,
      params,
    );
  }

  getById(id) {
    return this.db.get(
      `SELECT t.*,
              COALESCE(SUM(CASE WHEN s.session_type = 'focus' AND s.completed = 1 THEN 1 ELSE 0 END), 0) AS completed_pomodoros,
              COALESCE(SUM(CASE WHEN s.session_type = 'focus' THEN s.actual_duration_seconds ELSE 0 END), 0) AS focus_seconds,
              MAX(s.ended_at) AS last_worked_at
         FROM tasks t LEFT JOIN sessions s ON s.task_id = t.id
        WHERE t.id = ? GROUP BY t.id`,
      [cleanId(id)],
    );
  }

  assertGoal(goalId) {
    if (goalId && !this.db.get('SELECT id FROM goals WHERE id = ?', [goalId])) throw new Error('That goal no longer exists.');
  }

  /** New tasks are dated today unless a date (or null for "no date") is given. */
  create({ title, description, estimatedPomodoros, scheduledDate, goalId }) {
    const now = this.nowIso();
    const date = scheduledDate === undefined ? localDate(this.clock()) : cleanScheduled(scheduledDate);
    const goal = cleanGoalId(goalId);
    this.assertGoal(goal);
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO tasks (title, description, estimated_pomodoros, status, created_at, updated_at, scheduled_date, goal_id)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      [cleanTitle(title), cleanDescription(description), cleanEstimate(estimatedPomodoros), now, now, date, goal],
    );
    return this.getById(lastInsertRowid);
  }

  update(id, { title, description, estimatedPomodoros, scheduledDate, goalId }) {
    const taskId = cleanId(id);
    const existing = this.getById(taskId);
    if (!existing) throw new Error('That task no longer exists.');
    const goal = goalId === undefined ? existing.goal_id : cleanGoalId(goalId);
    this.assertGoal(goal);
    this.db.run(
      `UPDATE tasks SET title = ?, description = ?, estimated_pomodoros = ?, scheduled_date = ?, goal_id = ?, updated_at = ?
        WHERE id = ?`,
      [
        title === undefined ? existing.title : cleanTitle(title),
        description === undefined ? existing.description : cleanDescription(description),
        estimatedPomodoros === undefined ? existing.estimated_pomodoros : cleanEstimate(estimatedPomodoros),
        scheduledDate === undefined ? existing.scheduled_date : cleanScheduled(scheduledDate),
        goal,
        this.nowIso(),
        taskId,
      ],
    );
    return this.getById(taskId);
  }

  /** Tasks scheduled between two local dates (inclusive), with Pomodoro counts. */
  scheduledBetween(fromDate, toDate) {
    return this.db.all(
      `SELECT t.*,
              COALESCE(SUM(CASE WHEN s.session_type = 'focus' AND s.completed = 1 THEN 1 ELSE 0 END), 0) AS completed_pomodoros
         FROM tasks t LEFT JOIN sessions s ON s.task_id = t.id
        WHERE t.scheduled_date >= ? AND t.scheduled_date <= ?
        GROUP BY t.id
        ORDER BY t.scheduled_date, t.created_at, t.id`,
      [cleanDate(fromDate), cleanDate(toDate)],
    );
  }

  setStatus(id, status) {
    if (status !== 'active' && status !== 'completed') throw new Error('Status must be active or completed.');
    const taskId = cleanId(id);
    const now = this.nowIso();
    const { changes } = this.db.run(
      `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [status, status === 'completed' ? now : null, now, taskId],
    );
    if (!changes) throw new Error('That task no longer exists.');
    return this.getById(taskId);
  }

  /** Deletes the task. Its sessions remain (task_id -> NULL, title snapshot kept). */
  delete(id) {
    const { changes } = this.db.run('DELETE FROM tasks WHERE id = ?', [cleanId(id)]);
    return changes > 0;
  }

  sessionsFor(id, limit = 200) {
    return this.db.all(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
      [cleanId(id), Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    );
  }

  /** Tasks completed in [startIso, endIso). */
  completedBetween(startIso, endIso) {
    return this.db.all(
      `SELECT id, title, completed_at FROM tasks WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`,
      [startIso, endIso],
    );
  }
}

module.exports = { TasksRepository, cleanId, cleanGoalId };
