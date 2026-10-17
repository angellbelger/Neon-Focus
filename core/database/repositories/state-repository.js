'use strict';

/** Persistence for the in-flight session and the Pomodoro cycle position. */
class StateRepository {
  constructor(db) {
    this.db = db;
  }

  getActive() {
    return this.db.get('SELECT * FROM active_session WHERE id = 1');
  }

  insertActive(a) {
    this.db.run(
      `INSERT INTO active_session
        (id, run_id, task_id, session_type, planned_duration_seconds, started_at, state,
         elapsed_ms, segment_started_at, last_heartbeat_at)
       VALUES (1, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
      [a.runId, a.taskId ?? null, a.sessionType, a.plannedSeconds, a.startedAt, a.startedAt, a.startedAt],
    );
  }

  setRunning(segmentStartedAt) {
    this.db.run(
      `UPDATE active_session SET state = 'running', segment_started_at = ?, last_heartbeat_at = ? WHERE id = 1`,
      [segmentStartedAt, segmentStartedAt],
    );
  }

  setPaused(elapsedMs, at) {
    this.db.run(
      `UPDATE active_session SET state = 'paused', elapsed_ms = ?, segment_started_at = NULL, last_heartbeat_at = ? WHERE id = 1`,
      [Math.max(0, Math.round(elapsedMs)), at],
    );
  }

  setTask(taskId) {
    this.db.run('UPDATE active_session SET task_id = ? WHERE id = 1', [taskId ?? null]);
  }

  heartbeat(at) {
    this.db.run('UPDATE active_session SET last_heartbeat_at = ? WHERE id = 1', [at]);
  }

  /** Deletes the active row only if it still belongs to runId. Returns true if deleted. */
  clearActive(runId) {
    const { changes } = this.db.run('DELETE FROM active_session WHERE id = 1 AND run_id = ?', [runId]);
    return changes > 0;
  }

  getValue(key, fallback) {
    const row = this.db.get('SELECT state_value FROM app_state WHERE state_key = ?', [key]);
    if (!row) return fallback;
    try { return JSON.parse(row.state_value); } catch (_) { return fallback; }
  }

  setValue(key, value) {
    this.db.run(
      `INSERT INTO app_state (state_key, state_value) VALUES (?, ?)
       ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value`,
      [key, JSON.stringify(value)],
    );
  }
}

module.exports = { StateRepository };
