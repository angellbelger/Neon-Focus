'use strict';

const { cleanId } = require('./tasks-repository');

const MAX_STEPS_PER_TASK = 100;

function cleanTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Give the step a name.');
  const t = title.trim();
  if (t.length > 200) throw new Error('Step names can be up to 200 characters.');
  return t;
}

/**
 * Steps (sub-tasks) inside a task. Every write returns the task's full,
 * ordered step list so the UI can redraw just that task.
 */
class StepsRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() {
    return new Date(this.clock()).toISOString();
  }

  forTask(taskId) {
    return this.db.all(
      'SELECT id, task_id, title, completed, position, created_at, updated_at, completed_at FROM task_steps WHERE task_id = ? ORDER BY position, id',
      [cleanId(taskId)],
    );
  }

  /** Steps for many tasks at once, grouped by task id. */
  forTasks(taskIds) {
    const map = new Map();
    const ids = taskIds.map(cleanId);
    if (!ids.length) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.all(
      `SELECT id, task_id, title, completed, position, created_at, updated_at, completed_at
         FROM task_steps WHERE task_id IN (${placeholders}) ORDER BY task_id, position, id`,
      ids,
    );
    for (const r of rows) {
      if (!map.has(r.task_id)) map.set(r.task_id, []);
      map.get(r.task_id).push(r);
    }
    return map;
  }

  stepOrThrow(stepId) {
    const step = this.db.get('SELECT * FROM task_steps WHERE id = ?', [cleanId(stepId)]);
    if (!step) throw new Error('That step no longer exists.');
    return step;
  }

  create(taskId, title) {
    const id = cleanId(taskId);
    const name = cleanTitle(title);
    return this.db.transaction(() => {
      const task = this.db.get('SELECT id FROM tasks WHERE id = ?', [id]);
      if (!task) throw new Error('That task no longer exists.');
      const { n, maxPos } = this.db.get(
        'SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM task_steps WHERE task_id = ?', [id],
      );
      if (n >= MAX_STEPS_PER_TASK) throw new Error(`A task can have up to ${MAX_STEPS_PER_TASK} steps.`);
      const now = this.nowIso();
      this.db.run(
        `INSERT INTO task_steps (task_id, title, completed, position, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
        [id, name, maxPos + 1, now, now],
      );
      return this.forTask(id);
    });
  }

  rename(stepId, title) {
    const step = this.stepOrThrow(stepId);
    this.db.run('UPDATE task_steps SET title = ?, updated_at = ? WHERE id = ?', [cleanTitle(title), this.nowIso(), step.id]);
    return this.forTask(step.task_id);
  }

  setCompleted(stepId, completed) {
    if (typeof completed !== 'boolean') throw new Error('Completed must be true or false.');
    const step = this.stepOrThrow(stepId);
    const now = this.nowIso();
    this.db.run(
      'UPDATE task_steps SET completed = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      [completed ? 1 : 0, completed ? now : null, now, step.id],
    );
    return this.forTask(step.task_id);
  }

  delete(stepId) {
    const step = this.stepOrThrow(stepId);
    this.db.run('DELETE FROM task_steps WHERE id = ?', [step.id]);
    return this.forTask(step.task_id);
  }
}

module.exports = { StepsRepository, MAX_STEPS_PER_TASK };
