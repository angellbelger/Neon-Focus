'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { createServices } = require('../../core/services');
const { Database, SCHEMA_VERSION } = require('../../core/database/database');
const { carryOverLegacyDatabase } = require('../../electron/legacy-data');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fn-'));

/** Builds a database exactly as version 1 of the app wrote it (no steps table). */
async function makeV1Backup(file) {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  db.run('CREATE TABLE schema_version (version INTEGER NOT NULL);');
  db.exec(fs.readFileSync(path.join(__dirname, '../../core/database/schema.sql'), 'utf8'));
  db.run('INSERT INTO schema_version VALUES (1)');
  const now = '2026-10-01T10:00:00.000Z';
  db.run("INSERT INTO tasks (title, description, status, created_at, updated_at) VALUES ('Old task', '', 'active', ?, ?)", [now, now]);
  db.run(`INSERT INTO sessions (run_id, task_id, task_title, session_type, planned_duration_seconds, actual_duration_seconds,
          started_at, ended_at, status, completed) VALUES ('r-old', 1, 'Old task', 'focus', 1500, 1500,
          '2026-10-01T10:00:00.000Z', '2026-10-01T10:25:00.000Z', 'completed', 1)`);
  db.run("INSERT INTO settings (setting_key, setting_value, updated_at) VALUES ('dailyGoal', '5', ?)", [now]);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

// ------------------------------------------------------------------ steps

test('steps: add, rename, complete, delete, keep order', async () => {
  const svc = await createServices({ dbPath: null });
  const t = svc.tasksRepo.create({ title: 'English 17/10/2026' });
  svc.stepsRepo.create(t.id, 'Speaking - at least 10 minutes');
  svc.stepsRepo.create(t.id, 'Writing - 2 pages');
  let steps = svc.stepsRepo.create(t.id, 'Reading - anything');
  assert.deepEqual(steps.map((s) => s.title), ['Speaking - at least 10 minutes', 'Writing - 2 pages', 'Reading - anything']);

  steps = svc.stepsRepo.setCompleted(steps[0].id, true);
  assert.equal(steps[0].completed, 1);
  assert.ok(steps[0].completed_at);
  steps = svc.stepsRepo.setCompleted(steps[0].id, false);
  assert.equal(steps[0].completed, 0);
  assert.equal(steps[0].completed_at, null);

  steps = svc.stepsRepo.rename(steps[1].id, '  Writing - 3 pages ');
  assert.equal(steps[1].title, 'Writing - 3 pages');

  steps = svc.stepsRepo.delete(steps[2].id);
  assert.equal(steps.length, 2);

  const [listed] = svc.listTasks('all');
  assert.equal(listed.steps_total, 2);
  assert.equal(listed.steps_done, 0);
});

test('steps: validation and parent checks', async () => {
  const svc = await createServices({ dbPath: null });
  const t = svc.tasksRepo.create({ title: 'Task' });
  assert.throws(() => svc.stepsRepo.create(t.id, '   '), /name/);
  assert.throws(() => svc.stepsRepo.create(t.id, 'x'.repeat(201)), /200/);
  assert.throws(() => svc.stepsRepo.create(9999, 'Orphan'), /no longer exists/);
  assert.throws(() => svc.stepsRepo.rename(9999, 'x'), /no longer exists/);
  assert.throws(() => svc.stepsRepo.setCompleted(1, 'yes'));
});

test('steps belong to their task, are deleted with it, and never count as Pomodoros', async () => {
  const svc = await createServices({ dbPath: null });
  const a = svc.tasksRepo.create({ title: 'A' });
  const b = svc.tasksRepo.create({ title: 'B' });
  svc.stepsRepo.create(a.id, 'a1');
  svc.stepsRepo.create(b.id, 'b1');
  svc.stepsRepo.create(b.id, 'b2');
  const byTitle = Object.fromEntries(svc.listTasks('all').map((t) => [t.title, t]));
  assert.deepEqual(byTitle.A.steps.map((s) => s.title), ['a1']);
  assert.deepEqual(byTitle.B.steps.map((s) => s.title), ['b1', 'b2']);
  assert.equal(byTitle.B.completed_pomodoros, 0);

  svc.tasksRepo.delete(b.id);
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM task_steps').n, 1);
});

test('steps persist across reopening the database', async () => {
  const dbPath = path.join(tmpDir(), 'focus-neon.sqlite');
  let svc = await createServices({ dbPath });
  const t = svc.tasksRepo.create({ title: 'Persist' });
  const steps = svc.stepsRepo.create(t.id, 'Step one');
  svc.stepsRepo.setCompleted(steps[0].id, true);
  svc.stepsRepo.create(t.id, 'Step two');
  svc.db.close();

  svc = await createServices({ dbPath });
  const [task] = svc.listTasks('all');
  assert.deepEqual(task.steps.map((s) => [s.title, s.completed]), [['Step one', 1], ['Step two', 0]]);
});

test('an existing version-1 database is upgraded in place without losing data', async () => {
  const dbPath = path.join(tmpDir(), 'focus-neon.sqlite');
  await makeV1Backup(dbPath);
  const svc = await createServices({ dbPath });
  assert.equal(svc.db.schemaVersion(), SCHEMA_VERSION);
  const [task] = svc.listTasks('all');
  assert.equal(task.title, 'Old task');
  assert.equal(task.completed_pomodoros, 1);
  assert.equal(task.steps_total, 0);
  assert.equal(svc.settingsRepo.getAll().dailyGoal, 5);
});

// ------------------------------------------------------------------ import

test('import: a backup made by "Back up database" restores tasks, steps and sessions', async () => {
  const dir = tmpDir();
  // Source app with data, backed up the same way the Settings button does.
  const src = await createServices({ dbPath: path.join(dir, 'source.sqlite') });
  const t = src.tasksRepo.create({ title: 'English', estimatedPomodoros: 12 });
  const s = src.stepsRepo.create(t.id, 'Speaking');
  src.stepsRepo.setCompleted(s[0].id, true);
  src.stepsRepo.create(t.id, 'Reading');
  src.tasksRepo.setStatus(src.tasksRepo.create({ title: 'Done task' }).id, 'completed');
  src.sessionsRepo.record({
    runId: 'r1', taskId: t.id, taskTitle: 'English', sessionType: 'focus', plannedSeconds: 1500, actualSeconds: 1500,
    startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:25:00.000Z', status: 'completed',
  });
  src.settingsRepo.update({ dailyGoal: 12, theme: 'violet' });
  const backupFile = path.join(dir, 'focus-neon-backup.sqlite');
  src.db.backupTo(backupFile);

  // Fresh install with different data.
  const dst = await createServices({ dbPath: path.join(dir, 'fresh', 'focus-neon.sqlite') });
  dst.engine.init();
  dst.tasksRepo.create({ title: 'Will be replaced' });

  const prepared = await dst.prepareImport(fs.readFileSync(backupFile));
  assert.equal(prepared.summary.tasks, 2);
  assert.equal(prepared.summary.steps, 2);
  assert.equal(prepared.summary.pomodoros, 1);

  const res = dst.applyImport(prepared, { safetyDir: path.join(dir, 'fresh', 'backups') });
  assert.ok(fs.existsSync(res.safetyBackup), 'safety copy written');

  const tasks = dst.listTasks('all');
  assert.deepEqual(tasks.map((x) => x.title).sort(), ['Done task', 'English']);
  const english = tasks.find((x) => x.title === 'English');
  assert.deepEqual(english.steps.map((x) => [x.title, x.completed]), [['Speaking', 1], ['Reading', 0]]);
  assert.equal(english.completed_pomodoros, 1);
  assert.equal(tasks.find((x) => x.title === 'Done task').status, 'completed');
  assert.equal(dst.settingsRepo.getAll().dailyGoal, 12);
  assert.equal(dst.settingsRepo.getAll().theme, 'violet');

  // The restored data is what is on disk after a restart.
  dst.db.close();
  const reopened = await createServices({ dbPath: path.join(dir, 'fresh', 'focus-neon.sqlite') });
  assert.equal(reopened.listTasks('all').length, 2);

  // The safety copy holds the data that was there before the import.
  const safety = await createServices({ dbPath: res.safetyBackup });
  assert.deepEqual(safety.listTasks('all').map((x) => x.title), ['Will be replaced']);
});

test('import: an old (version 1, "Neon Pomodoro") backup is upgraded and imported', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'neon-pomodoro-backup.sqlite');
  await makeV1Backup(file);
  const svc = await createServices({ dbPath: path.join(dir, 'live.sqlite') });
  svc.engine.init();
  const prepared = await svc.prepareImport(fs.readFileSync(file));
  assert.equal(prepared.summary.schemaVersion, 1);
  svc.applyImport(prepared, { safetyDir: path.join(dir, 'backups') });
  assert.equal(svc.db.schemaVersion(), SCHEMA_VERSION);
  const [task] = svc.listTasks('all');
  assert.equal(task.title, 'Old task');
  assert.equal(task.completed_pomodoros, 1);
  // steps work on imported data
  assert.equal(svc.stepsRepo.create(task.id, 'New step').length, 1);
});

test('import: invalid files are rejected and the live data is untouched', async () => {
  const dir = tmpDir();
  const svc = await createServices({ dbPath: path.join(dir, 'live.sqlite') });
  svc.engine.init();
  svc.tasksRepo.create({ title: 'Keep me' });

  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const other = new SQL.Database();
  other.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  const foreignDb = Buffer.from(other.export());

  const newer = await createServices({ dbPath: null });
  newer.db.run('INSERT INTO schema_version VALUES (99)');
  const newerBytes = Buffer.from(newer.db.db.export());

  const good = await createServices({ dbPath: null });
  const goodBytes = Buffer.from(good.db.db.export());
  const truncated = goodBytes.subarray(0, Math.floor(goodBytes.length / 2));

  const cases = [
    [Buffer.alloc(0), /empty/],
    [Buffer.from('hello, this is a text file, not a database'.repeat(20)), /not a SQLite database/],
    [foreignDb, /not a Focus Neon backup/],
    [newerBytes, /newer version/],
    [truncated, /damaged|could not be opened|not a Focus Neon/],
  ];
  for (const [bytes, re] of cases) {
    await assert.rejects(svc.prepareImport(bytes), re);
  }
  assert.deepEqual(svc.listTasks('all').map((t) => t.title), ['Keep me']);
});

test('import is refused while a session is in progress', async () => {
  const dir = tmpDir();
  const svc = await createServices({ dbPath: path.join(dir, 'live.sqlite') });
  svc.engine.init();
  const backup = await createServices({ dbPath: null });
  const prepared = await svc.prepareImport(Buffer.from(backup.db.db.export()));
  svc.engine.start();
  assert.throws(() => svc.applyImport(prepared, { safetyDir: path.join(dir, 'b') }), /current session/);
  assert.equal(fs.existsSync(path.join(dir, 'b')), false);
});

test('a failed write during import leaves the previous database intact', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'live.sqlite');
  const svc = await createServices({ dbPath });
  svc.engine.init();
  svc.tasksRepo.create({ title: 'Original' });
  const src = await createServices({ dbPath: null });
  src.tasksRepo.create({ title: 'Incoming' });
  const prepared = await svc.prepareImport(Buffer.from(src.db.db.export()));

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => svc.applyImport(prepared, { safetyDir: path.join(dir, 'b') }), /disk full/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(svc.listTasks('all').map((t) => t.title), ['Original']);
  const reopened = await createServices({ dbPath });
  assert.deepEqual(reopened.listTasks('all').map((t) => t.title), ['Original']);
});

// ------------------------------------------------------------------ rename carry-over

test('data from the old "Neon Pomodoro" folder is copied once to "Focus Neon"', () => {
  const appData = tmpDir();
  fs.mkdirSync(path.join(appData, 'Neon Pomodoro'));
  fs.writeFileSync(path.join(appData, 'Neon Pomodoro', 'neon-pomodoro.sqlite'), 'old-data');
  const target = path.join(appData, 'Focus Neon', 'focus-neon.sqlite');

  const from = carryOverLegacyDatabase(appData, target);
  assert.ok(from.endsWith('neon-pomodoro.sqlite'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-data');
  assert.ok(fs.existsSync(path.join(appData, 'Neon Pomodoro', 'neon-pomodoro.sqlite')), 'original kept');

  fs.writeFileSync(target, 'new-data');
  assert.equal(carryOverLegacyDatabase(appData, target), null, 'never overwrites existing data');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-data');
  assert.equal(carryOverLegacyDatabase(tmpDir(), path.join(tmpDir(), 'x.sqlite')), null);
});

test('Database.open still works for an empty new install', async () => {
  const db = await Database.open(path.join(tmpDir(), 'new.sqlite'));
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
});
