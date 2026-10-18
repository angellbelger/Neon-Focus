'use strict';

const SESSION_TYPES = ['focus', 'short_break', 'long_break'];
const STATUSES = ['completed', 'interrupted', 'abandoned'];

class SessionsRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Inserts a finished session. INSERT OR IGNORE + UNIQUE(run_id) guarantees a
   * run is recorded at most once. Returns true if a row was written.
   */
  record(s) {
    if (!SESSION_TYPES.includes(s.sessionType)) throw new Error(`Invalid session type ${s.sessionType}`);
    if (!STATUSES.includes(s.status)) throw new Error(`Invalid status ${s.status}`);
    const { changes, lastInsertRowid } = this.db.run(
      `INSERT OR IGNORE INTO sessions
        (run_id, task_id, task_title, session_type, planned_duration_seconds, actual_duration_seconds,
         started_at, ended_at, status, completed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.runId,
        s.taskId ?? null,
        s.taskTitle ?? null,
        s.sessionType,
        s.plannedSeconds,
        s.actualSeconds,
        s.startedAt,
        s.endedAt,
        s.status,
        s.status === 'completed' ? 1 : 0,
      ],
    );
    // Snapshot the task's tags so this session keeps its activity
    // classification even if the task's tags change later.
    if (changes > 0 && s.taskId) {
      this.db.run(
        `INSERT OR IGNORE INTO session_tags (session_id, tag_id, tag_name)
         SELECT ?, t.id, t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.task_id = ?`,
        [lastInsertRowid, s.taskId],
      );
    }
    return changes > 0;
  }

  /** Sessions overlapping [startIso, endIso). */
  overlapping(startIso, endIso) {
    return this.db.all(
      `SELECT id, task_id, session_type, actual_duration_seconds, planned_duration_seconds,
              started_at, ended_at, status, completed
         FROM sessions
        WHERE ended_at >= ? AND started_at < ?
        ORDER BY started_at`,
      [startIso, endIso],
    );
  }

  /** Filtered, paginated history. */
  history({ fromIso, toIso, type = 'all', status = 'all', limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (fromIso) { where.push('s.started_at >= ?'); params.push(fromIso); }
    if (toIso) { where.push('s.started_at < ?'); params.push(toIso); }
    if (type !== 'all') {
      if (!SESSION_TYPES.includes(type)) throw new Error('Invalid session type filter.');
      where.push('s.session_type = ?'); params.push(type);
    }
    if (status !== 'all') {
      if (!STATUSES.includes(status)) throw new Error('Invalid status filter.');
      where.push('s.status = ?'); params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = this.db.all(
      `SELECT s.*, COALESCE(t.title, s.task_title) AS display_task_title, t.id IS NOT NULL AS task_exists
         FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id
         ${clause}
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    const total = this.db.get(`SELECT COUNT(*) AS n FROM sessions s ${clause}`, params).n;
    return { rows, total };
  }

  all() {
    return this.db.all(
      `SELECT s.*, COALESCE(t.title, s.task_title) AS display_task_title
         FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.started_at`,
    );
  }

  /** Earliest session start (for knowing how far back history goes). */
  firstStartedAt() {
    const row = this.db.get('SELECT MIN(started_at) AS first FROM sessions');
    return row ? row.first : null;
  }
}

module.exports = { SessionsRepository, SESSION_TYPES, STATUSES };
