'use strict';

/**
 * SQLite access layer.
 *
 * Uses sql.js (the official SQLite engine compiled to WebAssembly) so the app
 * needs no native compilation on install. The database lives in a real SQLite
 * file on disk: every committed write is exported and written atomically
 * (write temp file -> fsync -> rename), so a crash never leaves a half-written
 * database. The file can be opened with any SQLite tool.
 *
 * Only the Electron main process uses this module; the renderer never sees SQL.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const { localDate } = require('../dates');

const SCHEMA_VERSION = 3;

/**
 * Ordered schema migrations. Each runs once, inside a transaction.
 * `after` runs in the same transaction for data back-fills that need JS
 * (e.g. converting UTC timestamps to local dates).
 */
const MIGRATIONS = [
  { version: 1, file: 'schema.sql' },
  { version: 2, file: path.join('migrations', '002-task-steps.sql') },
  {
    version: 3,
    file: path.join('migrations', '003-agenda-tags-goals.sql'),
    after(db) {
      // Existing tasks appear in the Agenda on the day they were created.
      const rows = db.all('SELECT id, created_at FROM tasks WHERE scheduled_date IS NULL');
      for (const r of rows) {
        const ms = Date.parse(r.created_at);
        if (Number.isFinite(ms)) db.db.run('UPDATE tasks SET scheduled_date = ? WHERE id = ?', [localDate(ms), r.id]);
      }
    },
  },
];

/** Error with a message meant for the user (bad or incompatible import file). */
class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

let sqlPromise = null;
function loadSqlJs() {
  if (!sqlPromise) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  }
  return sqlPromise;
}

class Database {
  /**
   * @param {string|null} filePath  Path of the .sqlite file, or null for in-memory (tests).
   * @returns {Promise<Database>}
   */
  static async open(filePath) {
    const SQL = await loadSqlJs();
    let raw = null;
    let recoveredFrom = null;

    if (filePath && fs.existsSync(filePath)) {
      raw = fs.readFileSync(filePath);
    }

    let db;
    try {
      db = raw ? new SQL.Database(raw) : new SQL.Database();
      if (raw) {
        const check = db.exec('PRAGMA quick_check');
        const ok = check[0] && check[0].values[0][0] === 'ok';
        if (!ok) throw new Error('SQLite integrity check failed');
      }
    } catch (err) {
      // Keep the damaged file for manual recovery and start fresh.
      if (db) db.close();
      recoveredFrom = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, recoveredFrom);
      db = new SQL.Database();
    }

    const instance = new Database(db, filePath);
    instance.SQL = SQL;
    instance.recoveredFrom = recoveredFrom;
    instance.migrate();
    return instance;
  }

  constructor(db, filePath) {
    this.db = db;
    this.filePath = filePath;
    this.txDepth = 0;
    this.applyPragmas();
  }

  applyPragmas() {
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  schemaVersion() {
    const exists = this.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'");
    if (!exists) return 0;
    const row = this.get('SELECT MAX(version) AS v FROM schema_version');
    return row && row.v ? row.v : 0;
  }

  /** Brings the schema up to SCHEMA_VERSION, one migration at a time. */
  migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
    const current = this.schemaVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(`Database was created by a newer version of the app (schema ${current}).`);
    }
    for (const m of MIGRATIONS) {
      if (current >= m.version) continue;
      const sql = fs.readFileSync(path.join(__dirname, m.file), 'utf8');
      this.transaction(() => {
        this.db.exec(sql);
        if (m.after) m.after(this);
        this.db.run('INSERT INTO schema_version (version) VALUES (?)', [m.version]);
      });
    }
    this.persist();
  }

  /**
   * Validates a backup file before it is imported. The file is opened in
   * memory only (never on top of the live database), checked for integrity
   * and for the tables this app needs, upgraded to the current schema, and
   * exported again. Throws ImportError with a readable message if anything
   * is wrong.
   *
   * @param {Buffer} bytes
   * @returns {Promise<{bytes: Uint8Array, summary: object}>}
   */
  static async prepareImport(bytes) {
    const SQL = await loadSqlJs();
    if (!bytes || bytes.length === 0) throw new ImportError('The selected file is empty.');
    if (bytes.length > MAX_IMPORT_BYTES) throw new ImportError('The selected file is too large to be a Focus Neon backup.');
    if (bytes.length < 512 || !Buffer.from(bytes.subarray(0, 16)).equals(SQLITE_HEADER)) {
      throw new ImportError('The selected file is not a SQLite database. Choose a backup created with "Back up database".');
    }

    let raw;
    try {
      raw = new SQL.Database(bytes);
    } catch (_) {
      throw new ImportError('The selected file could not be opened as a database. It may be damaged.');
    }

    const candidate = new Database(raw, null);
    try {
      let ok = false;
      try {
        const check = raw.exec('PRAGMA integrity_check');
        ok = Boolean(check[0] && check[0].values[0][0] === 'ok');
      } catch (_) { ok = false; }
      if (!ok) throw new ImportError('The backup file is damaged (integrity check failed) and was not imported.');

      const tables = new Set(candidate.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
      for (const t of ['schema_version', 'tasks', 'sessions', 'settings']) {
        if (!tables.has(t)) {
          throw new ImportError('This database is not a Focus Neon backup (required tables are missing).');
        }
      }
      const version = candidate.schemaVersion();
      if (version < 1) throw new ImportError('This database is not a Focus Neon backup (unknown format).');
      if (version > SCHEMA_VERSION) {
        throw new ImportError('This backup was created by a newer version of Focus Neon. Update the app, then import it again.');
      }

      // Structure check: the columns the app relies on must exist.
      try {
        candidate.all('SELECT id, title, description, estimated_pomodoros, status, created_at, updated_at, completed_at FROM tasks LIMIT 1');
        candidate.all(`SELECT id, run_id, task_id, task_title, session_type, planned_duration_seconds, actual_duration_seconds,
                              started_at, ended_at, status, completed FROM sessions LIMIT 1`);
        candidate.all('SELECT setting_key, setting_value, updated_at FROM settings LIMIT 1');
      } catch (_) {
        throw new ImportError('This database has an incompatible structure and cannot be imported.');
      }

      try {
        candidate.migrate();
      } catch (_) {
        throw new ImportError('This backup could not be upgraded to the current format. Nothing was changed.');
      }

      const fk = candidate.all('PRAGMA foreign_key_check');
      if (fk.length) throw new ImportError('The backup contains broken links between records and was not imported.');

      const one = (sql) => Object.values(candidate.get(sql))[0];
      const summary = {
        schemaVersion: version,
        tasks: one('SELECT COUNT(*) FROM tasks'),
        steps: one('SELECT COUNT(*) FROM task_steps'),
        tags: one('SELECT COUNT(*) FROM tags'),
        notes: one('SELECT COUNT(*) FROM daily_notes'),
        goals: one('SELECT COUNT(*) FROM goals'),
        sessions: one('SELECT COUNT(*) FROM sessions'),
        pomodoros: one("SELECT COUNT(*) FROM sessions WHERE session_type = 'focus' AND completed = 1"),
        firstSessionAt: one('SELECT MIN(started_at) FROM sessions'),
        lastSessionAt: one('SELECT MAX(ended_at) FROM sessions'),
      };
      return { bytes: raw.export(), summary };
    } finally {
      raw.close();
    }
  }

  /**
   * Replaces the whole live database with an already-validated image.
   * The file on disk is swapped atomically (temp file + rename); if writing
   * fails, the previous database stays in memory and on disk unchanged.
   */
  replaceWith(bytes) {
    if (this.txDepth > 0) throw new Error('Cannot replace the database during a transaction.');
    const next = new this.SQL.Database(bytes);
    const prev = this.db;
    this.db = next;
    this.applyPragmas();
    try {
      this.persist();
    } catch (err) {
      this.db = prev;
      next.close();
      this.applyPragmas();
      throw err;
    }
    prev.close();
  }

  /** Returns all rows as plain objects. Always parameterised. */
  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** Executes a write statement. Persists immediately unless inside a transaction. */
  run(sql, params = []) {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const idRow = this.db.exec('SELECT last_insert_rowid()');
    const lastInsertRowid = idRow[0] ? idRow[0].values[0][0] : null;
    if (this.txDepth === 0) this.persist();
    return { changes, lastInsertRowid };
  }

  /** Runs fn atomically. Nested calls join the outer transaction. */
  transaction(fn) {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.run('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.txDepth = 0;
      this.persist();
      return result;
    } catch (err) {
      try { this.db.run('ROLLBACK'); } catch (_) { /* already rolled back */ }
      this.txDepth = 0;
      throw err;
    }
  }

  /** Atomically writes the database file to disk. */
  persist() {
    if (!this.filePath || this.txDepth > 0) return;
    const data = this.db.export();
    // sql.js re-opens the connection during export(); restore connection pragmas.
    this.applyPragmas();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }

  /** Writes a consistent copy of the database to another path. */
  backupTo(targetPath) {
    const data = this.db.export();
    this.applyPragmas();
    fs.writeFileSync(targetPath, data);
  }

  close() {
    this.persist();
    this.db.close();
  }
}

module.exports = { Database, SCHEMA_VERSION, ImportError };
