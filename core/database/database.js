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

const SCHEMA_VERSION = 1;

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

  migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
    const row = this.get('SELECT MAX(version) AS v FROM schema_version');
    const current = row && row.v ? row.v : 0;
    if (current < 1) {
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      this.transaction(() => {
        this.db.exec(schema);
        this.db.run('INSERT INTO schema_version (version) VALUES (?)', [1]);
      });
    }
    // Future migrations: if (current < 2) { ... }
    if (current > SCHEMA_VERSION) {
      throw new Error(`Database was created by a newer version of the app (schema ${current}).`);
    }
    this.persist();
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

module.exports = { Database, SCHEMA_VERSION };
