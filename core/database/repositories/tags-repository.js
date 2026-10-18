'use strict';

const { cleanId } = require('./tasks-repository');

const TAG_COLORS = ['cyan', 'violet', 'amber', 'green', 'pink', 'blue', 'red', 'gray'];

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Give the tag a name.');
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length > 40) throw new Error('Tag names can be up to 40 characters.');
  return n;
}

function cleanColor(color) {
  if (color === undefined || color === null) return null;
  if (!TAG_COLORS.includes(color)) throw new Error('Unknown tag colour.');
  return color;
}

/**
 * Reusable activity tags. Tasks link to tags (task_tags). When a session is
 * recorded, the task's tags are copied into session_tags so later changes to
 * the task's tags never rewrite history.
 */
class TagsRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() { return new Date(this.clock()).toISOString(); }

  list() {
    return this.db.all(
      `SELECT t.id, t.name, t.color, t.created_at,
              (SELECT COUNT(*) FROM task_tags tt WHERE tt.tag_id = t.id) AS task_count,
              (SELECT COUNT(*) FROM session_tags st JOIN sessions s ON s.id = st.session_id
                WHERE st.tag_id = t.id AND s.session_type = 'focus' AND s.completed = 1) AS pomodoro_count
         FROM tags t ORDER BY t.name COLLATE NOCASE`,
    );
  }

  get(id) {
    return this.db.get('SELECT id, name, color FROM tags WHERE id = ?', [cleanId(id)]);
  }

  findByName(name) {
    return this.db.get('SELECT id, name, color FROM tags WHERE name = ? COLLATE NOCASE', [String(name).trim()]);
  }

  nextColor() {
    const n = this.db.get('SELECT COUNT(*) AS n FROM tags').n;
    return TAG_COLORS[n % (TAG_COLORS.length - 1)];
  }

  create({ name, color }) {
    const clean = cleanName(name);
    if (this.findByName(clean)) throw new Error(`A tag called "${clean}" already exists.`);
    const now = this.nowIso();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO tags (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [clean, cleanColor(color) || this.nextColor(), now, now],
    );
    return this.get(lastInsertRowid);
  }

  update(id, { name, color }) {
    const tag = this.get(id);
    if (!tag) throw new Error('That tag no longer exists.');
    const newName = name === undefined ? tag.name : cleanName(name);
    const clash = this.findByName(newName);
    if (clash && clash.id !== tag.id) throw new Error(`A tag called "${newName}" already exists.`);
    this.db.run('UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?',
      [newName, cleanColor(color) || tag.color, this.nowIso(), tag.id]);
    return this.get(tag.id);
  }

  /** Removes the tag from all tasks. Past sessions keep their label (tag_name) but no longer count under any tag. */
  delete(id) {
    const { changes } = this.db.run('DELETE FROM tags WHERE id = ?', [cleanId(id)]);
    return changes > 0;
  }

  /** Map taskId -> [{id,name,color}] for the given tasks. */
  forTasks(taskIds) {
    const map = new Map();
    const ids = taskIds.map(cleanId);
    if (!ids.length) return map;
    const rows = this.db.all(
      `SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name COLLATE NOCASE`,
      ids,
    );
    for (const r of rows) {
      if (!map.has(r.task_id)) map.set(r.task_id, []);
      map.get(r.task_id).push({ id: r.id, name: r.name, color: r.color });
    }
    return map;
  }

  /**
   * Sets a task's tags. Future sessions use the new tags. Past sessions keep
   * their original classification unless applyToPast is true (an explicit
   * historical correction), in which case all of this task's recorded
   * sessions are re-classified with the new tags.
   */
  setTaskTags(taskId, tagIds, { applyToPast = false } = {}) {
    const id = cleanId(taskId);
    const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(cleanId))];
    if (ids.length > 20) throw new Error('A task can have up to 20 tags.');
    return this.db.transaction(() => {
      if (!this.db.get('SELECT id FROM tasks WHERE id = ?', [id])) throw new Error('That task no longer exists.');
      for (const tagId of ids) {
        if (!this.get(tagId)) throw new Error('One of the selected tags no longer exists.');
      }
      this.db.run('DELETE FROM task_tags WHERE task_id = ?', [id]);
      for (const tagId of ids) this.db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)', [id, tagId]);
      let reclassified = 0;
      if (applyToPast) {
        const sessions = this.db.all('SELECT id FROM sessions WHERE task_id = ?', [id]);
        for (const s of sessions) {
          this.db.run('DELETE FROM session_tags WHERE session_id = ?', [s.id]);
          this.copyTaskTagsToSession(s.id, id);
        }
        reclassified = sessions.length;
      }
      return { tags: this.forTasks([id]).get(id) || [], reclassified };
    });
  }

  /** Snapshot a task's current tags onto a session. */
  copyTaskTagsToSession(sessionId, taskId) {
    this.db.run(
      `INSERT OR IGNORE INTO session_tags (session_id, tag_id, tag_name)
       SELECT ?, t.id, t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.task_id = ?`,
      [sessionId, taskId],
    );
  }

  /** Number of recorded sessions for a task (for the "apply to past" prompt). */
  pastSessionCount(taskId) {
    return this.db.get(
      "SELECT COUNT(*) AS n FROM sessions WHERE task_id = ? AND session_type = 'focus' AND completed = 1", [cleanId(taskId)],
    ).n;
  }
}

module.exports = { TagsRepository, TAG_COLORS };
