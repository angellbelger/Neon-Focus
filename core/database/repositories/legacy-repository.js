'use strict';

const { cleanId } = require('./tasks-repository');
const { weeksInYear } = require('../../dates');

const KINDS = ['pomodoros', 'tag_hours'];
const MAX_POMODOROS = 5000;          // per week
const MAX_SECONDS = 7 * 24 * 3600;   // a week has 168 hours

function cleanInt(value, label, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

/**
 * Legacy data: weekly totals copied by hand from paper planners (before
 * Focus Neon). One row = one figure for one calendar week: the week's TTP, or
 * the hours spent on one tag. Rows live in their own table and never touch
 * sessions, tasks, notes or goals; statistics add them on top.
 */
class LegacyRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() { return new Date(this.clock()).toISOString(); }

  /** Rows with the tag's current name and colour (or the saved name if the tag was deleted). */
  list({ year } = {}) {
    const where = year === undefined || year === null ? '' : 'WHERE l.year = ?';
    const params = where ? [cleanInt(year, 'Year', 1970, 2200)] : [];
    return this.db.all(
      `SELECT l.id, l.year, l.week, l.kind, l.tag_id, COALESCE(t.name, l.tag_name) AS tag_name, t.color AS tag_color,
              l.value, l.created_at, l.updated_at
         FROM legacy_records l LEFT JOIN tags t ON t.id = l.tag_id
         ${where}
        ORDER BY l.year DESC, l.week DESC, l.kind DESC, COALESCE(t.name, l.tag_name) COLLATE NOCASE`,
      params,
    );
  }

  get(id) {
    return this.db.get(
      `SELECT l.id, l.year, l.week, l.kind, l.tag_id, COALESCE(t.name, l.tag_name) AS tag_name, t.color AS tag_color, l.value
         FROM legacy_records l LEFT JOIN tags t ON t.id = l.tag_id WHERE l.id = ?`,
      [cleanId(id)],
    );
  }

  /** The record for this year/week/metric(/tag), if there is one. */
  find({ year, week, kind, tagId }) {
    if (kind === 'pomodoros') {
      return this.db.get("SELECT id FROM legacy_records WHERE year = ? AND week = ? AND kind = 'pomodoros'", [year, week]);
    }
    return this.db.get("SELECT id FROM legacy_records WHERE year = ? AND week = ? AND kind = 'tag_hours' AND tag_id = ?",
      [year, week, tagId]);
  }

  /** Years that have legacy records. */
  years() {
    return this.db.all('SELECT DISTINCT year FROM legacy_records ORDER BY year').map((r) => r.year);
  }

  /**
   * Creates (no id) or updates (id) one record. Refuses a second record for
   * the same year, week and metric/tag. `weekStart` is Settings → "Weeks
   * start on" (decides whether the year has 52 or 53 weeks).
   */
  save(input = {}, weekStart = 1) {
    const id = input.id === undefined || input.id === null ? null : cleanId(input.id);
    const year = cleanInt(input.year, 'Year', 1970, 2200);
    const weeks = weeksInYear(year, weekStart);
    const week = cleanInt(input.week, 'Week', 1, weeks);
    if (!KINDS.includes(input.kind)) throw new Error('Choose Pomodoros (TTP) or hours on a tag.');
    const kind = input.kind;
    let tagId = null;
    let tagName = null;
    let value;
    if (kind === 'pomodoros') {
      value = cleanInt(input.value, 'Pomodoros', 1, MAX_POMODOROS);
    } else {
      tagId = cleanId(input.tagId);
      const tag = this.db.get('SELECT id, name FROM tags WHERE id = ?', [tagId]);
      if (!tag) throw new Error('Choose an existing tag.');
      tagName = tag.name;
      value = cleanInt(input.value, 'Hours', 60, MAX_SECONDS);
    }

    const clash = this.find({ year, week, kind, tagId });
    if (clash && clash.id !== id) {
      const what = kind === 'pomodoros' ? 'a Pomodoro (TTP) total' : `hours for "${tagName}"`;
      const err = new Error(`Week ${week} of ${year} already has ${what}. Edit that record instead of adding another.`);
      err.code = 'DUPLICATE';
      err.existingId = clash.id;
      throw err;
    }

    const now = this.nowIso();
    if (id) {
      if (!this.get(id)) throw new Error('That legacy record no longer exists.');
      this.db.run(
        'UPDATE legacy_records SET year = ?, week = ?, kind = ?, tag_id = ?, tag_name = ?, value = ?, updated_at = ? WHERE id = ?',
        [year, week, kind, tagId, tagName, value, now, id],
      );
      return this.get(id);
    }
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO legacy_records (year, week, kind, tag_id, tag_name, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [year, week, kind, tagId, tagName, value, now, now],
    );
    return this.get(lastInsertRowid);
  }

  delete(id) {
    return this.db.run('DELETE FROM legacy_records WHERE id = ?', [cleanId(id)]).changes > 0;
  }
}

module.exports = { LegacyRepository, MAX_POMODOROS, MAX_SECONDS };
