'use strict';

const { cleanId } = require('./tasks-repository');
const { cleanDate, localDate } = require('../../dates');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // February allows 29 (leap-day occasions)

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function cleanTitle(v) {
  if (typeof v !== 'string' || !v.trim()) throw new Error('Give the reminder a title.');
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > 200) throw new Error('Titles can be up to 200 characters.');
  return t;
}

function cleanNotes(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error('Notes must be text.');
  const n = v.replace(/\s+$/, '');
  if (n.length > 2000) throw new Error('Notes can be up to 2000 characters.');
  return n;
}

function cleanTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw new Error('Time must look like 14:30.');
  return v;
}

/** Only web links (http/https) are kept, so a reminder can never open a local file or app. */
function cleanLink(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  let s = String(v).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`; // "meet.google.com/abc" -> https://...
  let u;
  try { u = new URL(s); } catch (_) { throw new Error('That link is not a valid web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Links must start with http:// or https://.');
  if (u.href.length > 2000) throw new Error('That link is too long.');
  return u.href;
}

function cleanMonthDay(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('Choose a month.');
  if (!Number.isInteger(d) || d < 1 || d > DAYS_IN_MONTH[m - 1]) throw new Error('That day does not exist in that month.');
  return [m, d];
}

/** The date an annual reminder falls on in `year` (29 Feb -> 28 Feb in non-leap years). */
function annualDate(month, day, year) {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Reminders: one-time events (meetings, appointments, deadlines) and annual
 * occasions (birthdays, anniversaries). Annual ones keep only month and day:
 * every year's date is worked out when it is needed, never stored.
 */
class RemindersRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() { return new Date(this.clock()).toISOString(); }

  row(r) {
    if (!r) return null;
    return r.kind === 'once'
      ? { id: r.id, kind: 'once', title: r.title, notes: r.notes, date: r.event_date, time: r.event_time, link: r.link, done: Boolean(r.done_at), doneAt: r.done_at }
      : { id: r.id, kind: 'annual', title: r.title, notes: r.notes, month: r.month, day: r.day };
  }

  get(id) {
    return this.row(this.db.get('SELECT * FROM reminders WHERE id = ?', [cleanId(id)]));
  }

  /** One-time reminders, by date and time (all-day first on a date). */
  listOnce() {
    return this.db.all(
      "SELECT * FROM reminders WHERE kind = 'once' ORDER BY event_date, event_time IS NOT NULL, event_time, id",
    ).map((r) => this.row(r));
  }

  /** Annual reminders in calendar order (January to December). */
  listAnnual() {
    return this.db.all("SELECT * FROM reminders WHERE kind = 'annual' ORDER BY month, day, title COLLATE NOCASE")
      .map((r) => this.row(r));
  }

  /**
   * Annual reminders for each date in [fromDate, toDate] (inclusive, any
   * years): { 'YYYY-MM-DD': [reminder, ...] }. Computed, never stored.
   */
  annualBetween(fromDate, toDate) {
    const from = cleanDate(fromDate);
    const to = cleanDate(toDate);
    const out = {};
    const all = this.listAnnual();
    if (!all.length) return out;
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
      for (const r of all) {
        const date = annualDate(r.month, r.day, y);
        if (date < from || date > to) continue;
        (out[date] ||= []).push(r);
      }
    }
    return out;
  }

  save(input = {}) {
    const id = input.id === undefined || input.id === null ? null : cleanId(input.id);
    const existing = id ? this.get(id) : null;
    if (id && !existing) throw new Error('That reminder no longer exists.');
    const kind = existing ? existing.kind : input.kind;
    if (kind !== 'once' && kind !== 'annual') throw new Error('Choose a one-time or an annual reminder.');
    const title = cleanTitle(input.title);
    const notes = cleanNotes(input.notes);
    const now = this.nowIso();
    let fields;
    if (kind === 'once') {
      fields = {
        event_date: cleanDate(input.date, 'Date'),
        event_time: cleanTime(input.time),
        link: cleanLink(input.link),
        month: null,
        day: null,
      };
    } else {
      const [month, day] = cleanMonthDay(input.month, input.day);
      fields = { event_date: null, event_time: null, link: null, month, day };
    }
    if (existing) {
      this.db.run(
        `UPDATE reminders SET title = ?, notes = ?, event_date = ?, event_time = ?, link = ?, month = ?, day = ?, updated_at = ?
          WHERE id = ?`,
        [title, notes, fields.event_date, fields.event_time, fields.link, fields.month, fields.day, now, id],
      );
      return this.get(id);
    }
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO reminders (kind, title, notes, event_date, event_time, link, month, day, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, title, notes, fields.event_date, fields.event_time, fields.link, fields.month, fields.day, now, now],
    );
    return this.get(lastInsertRowid);
  }

  /** Marks a one-time reminder completed (or not). */
  setDone(id, done) {
    const r = this.get(id);
    if (!r) throw new Error('That reminder no longer exists.');
    if (r.kind !== 'once') throw new Error('Annual reminders come back every year and cannot be completed.');
    this.db.run('UPDATE reminders SET done_at = ?, updated_at = ? WHERE id = ?', [done ? this.nowIso() : null, this.nowIso(), r.id]);
    return this.get(r.id);
  }

  delete(id) {
    return this.db.run('DELETE FROM reminders WHERE id = ?', [cleanId(id)]).changes > 0;
  }
}

/** Status of a one-time reminder at `nowMs`: 'completed', 'past' or 'upcoming' (a date without time lasts all day). */
function onceStatus(r, nowMs) {
  if (r.done) return 'completed';
  const today = localDate(nowMs);
  if (r.date > today) return 'upcoming';
  if (r.date < today) return 'past';
  if (!r.time) return 'upcoming';
  const d = new Date(nowMs);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return r.time >= hhmm ? 'upcoming' : 'past';
}

module.exports = { RemindersRepository, annualDate, onceStatus, isLeap, cleanLink };
