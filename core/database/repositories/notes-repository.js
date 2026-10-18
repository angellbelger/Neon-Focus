'use strict';

const { cleanDate } = require('../../dates');

/** One free-text personal note per calendar day. */
class NotesRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  between(fromDate, toDate) {
    return this.db.all(
      'SELECT note_date, body, updated_at FROM daily_notes WHERE note_date >= ? AND note_date <= ? ORDER BY note_date',
      [cleanDate(fromDate), cleanDate(toDate)],
    );
  }

  get(date) {
    return this.db.get('SELECT note_date, body, updated_at FROM daily_notes WHERE note_date = ?', [cleanDate(date)]);
  }

  /** Saves the note for a day. An empty body deletes it. Returns the note or null. */
  save(date, body) {
    const day = cleanDate(date);
    if (body !== null && body !== undefined && typeof body !== 'string') throw new Error('A note must be text.');
    const text = (body || '').replace(/\s+$/, '');
    if (!text.trim()) {
      this.delete(day);
      return null;
    }
    if (text.length > 2000) throw new Error('A daily note can be up to 2000 characters.');
    const now = new Date(this.clock()).toISOString();
    this.db.run(
      `INSERT INTO daily_notes (note_date, body, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(note_date) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      [day, text, now, now],
    );
    return this.get(day);
  }

  delete(date) {
    const { changes } = this.db.run('DELETE FROM daily_notes WHERE note_date = ?', [cleanDate(date)]);
    return changes > 0;
  }
}

module.exports = { NotesRepository };
