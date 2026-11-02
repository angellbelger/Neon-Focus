'use strict';

const { cleanId } = require('./tasks-repository');

const MAX_TRACKS = 50;

/** References to stored media copies (the files live in the media folder). */
class MediaRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() { return new Date(this.clock()).toISOString(); }

  list(kind) {
    return this.db.all(
      `SELECT id, kind, stored_name, original_name, mime, bytes, position, selected, created_at
         FROM media_files WHERE kind = ? ORDER BY position, id`,
      [kind],
    ).map((r) => ({ ...r, selected: r.selected === 1 }));
  }

  get(id) {
    const r = this.db.get(
      'SELECT id, kind, stored_name, original_name, mime, bytes, position, selected FROM media_files WHERE id = ?',
      [cleanId(id)],
    );
    return r ? { ...r, selected: r.selected === 1 } : null;
  }

  count(kind) {
    return this.db.get('SELECT COUNT(*) AS n FROM media_files WHERE kind = ?', [kind]).n;
  }

  /** Appends a track at the end of the playlist (selected for startup by default). */
  addTrack({ storedName, originalName, mime, bytes }) {
    if (this.count('startup_sound') >= MAX_TRACKS) throw new Error(`The playlist can hold up to ${MAX_TRACKS} tracks.`);
    const pos = this.db.get("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM media_files WHERE kind = 'startup_sound'").p;
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO media_files (kind, stored_name, original_name, mime, bytes, position, selected, created_at)
       VALUES ('startup_sound', ?, ?, ?, ?, ?, 1, ?)`,
      [storedName, originalName, mime, bytes, pos, this.nowIso()],
    );
    return this.get(lastInsertRowid);
  }

  setSelected(id, selected) {
    const r = this.get(id);
    if (!r) throw new Error('That track is no longer in the playlist.');
    this.db.run('UPDATE media_files SET selected = ? WHERE id = ?', [selected ? 1 : 0, r.id]);
    return this.get(r.id);
  }

  /** Moves a track one place up (-1) or down (+1) in the playlist. */
  move(id, direction) {
    const r = this.get(id);
    if (!r) throw new Error('That track is no longer in the playlist.');
    const list = this.list(r.kind);
    const i = list.findIndex((x) => x.id === r.id);
    const j = i + (direction < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return this.list(r.kind);
    [list[i], list[j]] = [list[j], list[i]];
    this.db.transaction(() => {
      list.forEach((x, k) => this.db.run('UPDATE media_files SET position = ? WHERE id = ?', [k, x.id]));
    });
    return this.list(r.kind);
  }

  /** Replaces the wallpaper reference; returns the previous row (its file is the caller's to delete). */
  setWallpaper({ storedName, originalName, mime, bytes }) {
    const previous = this.list('wallpaper')[0] || null;
    this.db.transaction(() => {
      this.db.run("DELETE FROM media_files WHERE kind = 'wallpaper'");
      this.db.run(
        `INSERT INTO media_files (kind, stored_name, original_name, mime, bytes, position, selected, created_at)
         VALUES ('wallpaper', ?, ?, ?, ?, 0, 1, ?)`,
        [storedName, originalName, mime, bytes, this.nowIso()],
      );
    });
    return previous;
  }

  delete(id) {
    return this.db.run('DELETE FROM media_files WHERE id = ?', [cleanId(id)]).changes > 0;
  }
}

module.exports = { MediaRepository, MAX_TRACKS };
