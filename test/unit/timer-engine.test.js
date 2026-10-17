'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServices } = require('../../core/services');

function fakeClock(start = Date.UTC(2026, 9, 12, 12, 0, 0)) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  clock.set = (ms) => { t = ms; };
  return clock;
}

const MIN = 60 * 1000;

async function setup(opts = {}) {
  const clock = fakeClock();
  const svc = await createServices({ dbPath: opts.dbPath ?? null, clock });
  svc.engine.init();
  return { svc, clock, engine: svc.engine };
}

/** Advance in 1s ticks so the gap detector sees a live process. */
function run(clock, engine, ms, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    clock.advance(Math.min(step, ms - done));
    engine.tick();
  }
}

function sessions(svc) {
  return svc.db.all('SELECT * FROM sessions ORDER BY id');
}

test('a full focus session counts as exactly one Pomodoro and moves to a short break', async () => {
  const { svc, clock, engine } = await setup();
  const events = [];
  engine.on('completed', (e) => events.push(e));
  engine.start();
  run(clock, engine, 25 * MIN);
  const rows = sessions(svc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_type, 'focus');
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].actual_duration_seconds, 1500);
  assert.equal(events.length, 1);
  assert.equal(engine.getState().status, 'idle');
  assert.equal(engine.getState().mode, 'short_break');
  assert.equal(svc.today().pomodoros, 1);
});

test('breaks complete with an alarm event but never count as Pomodoros', async () => {
  const { svc, clock, engine } = await setup();
  const events = [];
  engine.on('completed', (e) => events.push(e.sessionType));
  engine.start(); run(clock, engine, 25 * MIN);
  engine.start(); run(clock, engine, 5 * MIN);
  assert.deepEqual(events, ['focus', 'short_break']);
  assert.equal(svc.today().pomodoros, 1);
  assert.equal(engine.getState().mode, 'focus');
});

test('standard sequence: 4th focus is followed by a long break, then the cycle restarts', async () => {
  const { clock, engine } = await setup();
  const modes = [];
  for (let i = 0; i < 4; i += 1) {
    engine.start(); run(clock, engine, 25 * MIN, 5000);
    modes.push(engine.getState().mode);
    engine.start(); run(clock, engine, (i === 3 ? 15 : 5) * MIN, 5000);
  }
  assert.deepEqual(modes, ['short_break', 'short_break', 'short_break', 'long_break']);
  assert.equal(engine.getState().focusDone, 0);
  assert.equal(engine.getState().mode, 'focus');
});

test('pause preserves remaining time; paused time is not counted', async () => {
  const { clock, engine } = await setup();
  engine.start();
  run(clock, engine, 10 * MIN);
  engine.pause();
  clock.advance(60 * MIN); engine.tick();
  const s = engine.getState();
  assert.equal(s.status, 'paused');
  assert.equal(s.elapsedMs, 10 * MIN);
  engine.resume();
  run(clock, engine, 15 * MIN - 1000);
  assert.equal(engine.getState().status, 'running');
  run(clock, engine, 1000);
  assert.equal(engine.getState().status, 'idle');
});

test('reset records an interrupted session and never a Pomodoro', async () => {
  const { svc, clock, engine } = await setup();
  engine.start(); run(clock, engine, 24 * MIN);
  engine.reset();
  const rows = sessions(svc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'interrupted');
  assert.equal(rows[0].completed, 0);
  assert.equal(rows[0].actual_duration_seconds, 24 * 60);
  assert.equal(svc.today().pomodoros, 0);
  assert.equal(engine.getState().mode, 'focus');
  assert.equal(engine.getState().status, 'idle');
});

test('a reset within the first second is discarded, not recorded', async () => {
  const { svc, clock, engine } = await setup();
  engine.start(); clock.advance(400); engine.reset();
  assert.equal(sessions(svc).length, 0);
});

test('completion is processed exactly once even if triggered repeatedly', async () => {
  const { svc, clock, engine } = await setup();
  let n = 0;
  engine.on('completed', () => { n += 1; });
  engine.start();
  run(clock, engine, 25 * MIN - 1000);
  clock.advance(1000);
  const a = engine.active;
  engine.tick(); engine.tick();
  engine.active = a;                       // simulate a stale double-fire
  engine.complete(clock());
  assert.equal(n, 1);
  assert.equal(sessions(svc).length, 1);
});

test('the database rejects a duplicate run_id', async () => {
  const { svc } = await setup();
  const rec = {
    runId: 'r1', sessionType: 'focus', plannedSeconds: 60, actualSeconds: 60,
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', status: 'completed',
  };
  assert.equal(svc.sessionsRepo.record(rec), true);
  assert.equal(svc.sessionsRepo.record(rec), false);
  assert.equal(sessions(svc).length, 1);
});

test('only one timer can run: start while running is a no-op', async () => {
  const { svc, clock, engine } = await setup();
  engine.start();
  const id = engine.getState().runId;
  clock.advance(1000); engine.start();
  assert.equal(engine.getState().runId, id);
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM active_session').n, 1);
});

test('sleep (clock jump) pauses at the last observed moment instead of completing', async () => {
  const { svc, clock, engine } = await setup();
  const notices = [];
  engine.on('notice', (n) => notices.push(n.reason));
  engine.start();
  run(clock, engine, 5 * MIN);
  clock.advance(3 * 60 * MIN);   // laptop lid closed for 3 hours
  engine.tick();
  const s = engine.getState();
  assert.equal(s.status, 'paused');
  assert.equal(s.elapsedMs, 5 * MIN);
  assert.equal(sessions(svc).length, 0);
  assert.deepEqual(notices, ['sleep']);
});

test('restart restores a running session as paused at its last heartbeat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const clock = fakeClock();
  let svc = await createServices({ dbPath, clock });
  svc.engine.init();
  svc.engine.start();
  run(clock, svc.engine, 7 * MIN);            // heartbeats every 5 s
  // app "crashes": nothing closes cleanly; 2 hours pass
  clock.advance(120 * MIN);
  svc = await createServices({ dbPath, clock });
  svc.engine.init();
  const s = svc.engine.getState();
  assert.equal(s.status, 'paused');
  assert.ok(s.elapsedMs >= 7 * MIN - 5000 && s.elapsedMs <= 7 * MIN, `elapsed ${s.elapsedMs}`);
  assert.equal(s.notice.kind, 'restored');
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM sessions').n, 0);
});

test('data persists across reopen (tasks, sessions, settings)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  const dbPath = path.join(dir, 'persist.sqlite');
  const clock = fakeClock();
  let svc = await createServices({ dbPath, clock });
  svc.engine.init();
  const t = svc.tasksRepo.create({ title: 'Write report', estimatedPomodoros: 4 });
  svc.engine.setTask(t.id);
  svc.settingsRepo.update({ dailyGoal: 6 });
  svc.engine.start(); run(clock, svc.engine, 25 * MIN, 5000);
  svc.db.close();

  svc = await createServices({ dbPath, clock });
  const task = svc.tasksRepo.getById(t.id);
  assert.equal(task.completed_pomodoros, 1);
  assert.equal(task.estimated_pomodoros, 4);
  assert.equal(task.status, 'active', 'a Pomodoro must not complete the task');
  assert.equal(svc.settingsRepo.getAll().dailyGoal, 6);
});

test('deleting a task keeps its sessions with the title snapshot', async () => {
  const { svc, clock, engine } = await setup();
  const t = svc.tasksRepo.create({ title: 'Read paper' });
  engine.setTask(t.id);
  engine.start(); run(clock, engine, 25 * MIN, 5000);
  svc.tasksRepo.delete(t.id);
  engine.onTaskRemoved(t.id);
  const { rows } = svc.sessionsRepo.history({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, null);
  assert.equal(rows[0].display_task_title, 'Read paper');
  assert.equal(svc.today().pomodoros, 1);
});

test('focus without a task is still recorded as a Pomodoro', async () => {
  const { svc, clock, engine } = await setup();
  engine.start(); run(clock, engine, 25 * MIN, 5000);
  assert.equal(sessions(svc)[0].task_id, null);
  assert.equal(svc.today().pomodoros, 1);
});

test('auto-start begins the next session after completion', async () => {
  const { svc, clock, engine } = await setup();
  svc.settingsRepo.update({ autoStartBreaks: true });
  engine.refreshSettings();
  engine.start(); run(clock, engine, 25 * MIN, 5000);
  const s = engine.getState();
  assert.equal(s.status, 'running');
  assert.equal(s.mode, 'short_break');
  assert.equal(s.lastCompletion.sessionType, 'focus');
});

test('skip records an abandoned session and advances the mode without counting', async () => {
  const { svc, clock, engine } = await setup();
  engine.start(); run(clock, engine, 3 * MIN);
  engine.skip();
  assert.equal(sessions(svc)[0].status, 'abandoned');
  assert.equal(engine.getState().mode, 'short_break');
  assert.equal(engine.getState().focusDone, 0);
});

test('invalid settings are rejected', async () => {
  const { svc } = await setup();
  assert.throws(() => svc.settingsRepo.update({ focusMinutes: 0 }));
  assert.throws(() => svc.settingsRepo.update({ focusMinutes: 2.5 }));
  assert.throws(() => svc.settingsRepo.update({ nope: 1 }));
  assert.throws(() => svc.settingsRepo.update({ alarmSound: 'airhorn' }));
  assert.equal(svc.settingsRepo.getAll().focusMinutes, 25);
});

test('SQL injection in task titles is stored as plain text', async () => {
  const { svc } = await setup();
  const evil = "x'); DROP TABLE sessions; --";
  const t = svc.tasksRepo.create({ title: evil });
  assert.equal(svc.tasksRepo.getById(t.id).title, evil);
  assert.ok(svc.db.get("SELECT name FROM sqlite_master WHERE name='sessions'"));
});
