'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { createServices } = require('../../core/services');
const { SCHEMA_VERSION } = require('../../core/database/database');
const { localDate } = require('../../core/dates');

const MIN = 60 * 1000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fn3-'));

function fakeClock(start) {
  let t = start;
  const c = () => t;
  c.set = (ms) => { t = ms; };
  c.advance = (ms) => { t += ms; };
  return c;
}

/** Runs one full focus session through the real timer engine. */
function pomodoro(svc, clock, taskId, minutes = 25) {
  svc.settingsRepo.update({ focusMinutes: minutes });
  svc.engine.refreshSettings();
  svc.engine.setMode('focus');
  svc.engine.setTask(taskId);
  svc.engine.start();
  for (let i = 0; i < minutes * 12; i += 1) { clock.advance(5000); svc.engine.tick(); }
  assert.equal(svc.engine.getState().status, 'idle');
}

async function setup(startLocal = new Date(2026, 9, 17, 9, 0)) {
  const clock = fakeClock(startLocal.getTime());
  const svc = await createServices({ dbPath: null, clock });
  svc.engine.init();
  return { svc, clock };
}

// ------------------------------------------------------------------ tasks & dates

test('new tasks are dated today; dates can be set, changed and cleared', async () => {
  const { svc } = await setup();
  const a = svc.tasksRepo.create({ title: 'Today task' });
  assert.equal(a.scheduled_date, '2026-10-17');
  const b = svc.tasksRepo.create({ title: 'NYE', scheduledDate: '2026-12-31' });
  assert.equal(b.scheduled_date, '2026-12-31');
  assert.equal(svc.tasksRepo.update(b.id, { scheduledDate: '2027-01-02' }).scheduled_date, '2027-01-02');
  assert.equal(svc.tasksRepo.update(b.id, { scheduledDate: null }).scheduled_date, null);
  assert.throws(() => svc.tasksRepo.create({ title: 'x', scheduledDate: '2026-02-30' }), /real day/);
  assert.throws(() => svc.tasksRepo.create({ title: 'x', scheduledDate: '17/10/2026' }), /2026-10-17/);
});

test('agenda shows tasks on their dates, with tags, steps and completion from the same task rows', async () => {
  const { svc } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const t = svc.tasksRepo.create({ title: 'English 17/10/2026', scheduledDate: '2026-10-17' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  svc.stepsRepo.create(t.id, 'Speaking');
  svc.tasksRepo.create({ title: 'Work', scheduledDate: '2026-10-19' });

  let week = svc.agendaDays('2026-10-12', 7);
  assert.equal(week.days.length, 7);
  const sat = week.days.find((d) => d.date === '2026-10-17');
  assert.deepEqual(sat.tasks.map((x) => x.title), ['English 17/10/2026']);
  assert.deepEqual(sat.tasks[0].tags.map((x) => x.name), ['English']);
  assert.equal(sat.tasks[0].steps_total, 1);
  assert.equal(week.days.find((d) => d.date === '2026-10-19'), undefined, 'outside the week');

  // completing in the Tasks section shows in the Agenda (same row)
  svc.tasksRepo.setStatus(t.id, 'completed');
  week = svc.agendaDays('2026-10-12', 7);
  assert.equal(week.days[5].tasks[0].status, 'completed');
});

// ------------------------------------------------------------------ notes

test('daily notes: create, edit, delete, independent of tasks, persisted', async () => {
  const dbPath = path.join(tmpDir(), 'n.sqlite');
  let svc = await createServices({ dbPath });
  svc.notesRepo.save('2026-12-31', "New Year's Eve with my daughter.");
  svc.notesRepo.save('2026-12-31', "New Year's Eve with my daughter. Fireworks at midnight.");
  svc.notesRepo.save('2027-01-04', 'Got rid of my computer');
  assert.equal(svc.notesRepo.save('2027-01-04', '   '), null, 'empty note deletes it');
  svc.db.close();
  svc = await createServices({ dbPath });
  const week = svc.agendaDays('2026-12-28', 7);
  const nye = week.days.find((d) => d.date === '2026-12-31');
  assert.equal(nye.note.body, "New Year's Eve with my daughter. Fireworks at midnight.");
  assert.equal(nye.tasks.length, 0);
  assert.equal(week.days.find((d) => d.date === '2027-01-03').note, null);
  assert.throws(() => svc.notesRepo.save('2026-13-01', 'x'));
});

// ------------------------------------------------------------------ TTP & H.E.

test('TTP counts completed Pomodoros per day; H.E. only counts sessions tagged English', async () => {
  const { svc, clock } = await setup(new Date(2026, 9, 17, 8, 0));
  const english = svc.tagsRepo.create({ name: 'English' });
  const work = svc.tagsRepo.create({ name: 'Work' });
  const e1 = svc.tasksRepo.create({ title: 'English 17/10/2026' });
  const e2 = svc.tasksRepo.create({ title: 'English Listening Practice' });
  const w = svc.tasksRepo.create({ title: 'Work' });
  const plain = svc.tasksRepo.create({ title: 'English but untagged' });
  svc.tagsRepo.setTaskTags(e1.id, [english.id]);
  svc.tagsRepo.setTaskTags(e2.id, [english.id]);
  svc.tagsRepo.setTaskTags(w.id, [work.id]);

  pomodoro(svc, clock, e1.id);
  pomodoro(svc, clock, e2.id);
  pomodoro(svc, clock, e2.id, 30);      // durations differ: real durations are used
  pomodoro(svc, clock, w.id);
  pomodoro(svc, clock, plain.id);       // title says English but no tag
  pomodoro(svc, clock, null);           // no task
  // an interrupted English session never counts
  svc.engine.setTask(e1.id); svc.engine.start(); clock.advance(10 * MIN); svc.engine.tick(); svc.engine.reset();

  const day = svc.agendaDays('2026-10-17', 1).days[0];
  assert.equal(day.ttp, 6);
  assert.equal(day.hoursSeconds, (25 + 25 + 30) * 60);   // 1 h 20 min
  // updates automatically with the next session
  pomodoro(svc, clock, e1.id);
  const again = svc.agendaDays('2026-10-17', 1).days[0];
  assert.equal(again.ttp, 7);
  assert.equal(again.hoursSeconds, (25 + 25 + 30 + 25) * 60);
});

test('a session is attributed to the local day it finished on', async () => {
  const { svc, clock } = await setup(new Date(2026, 9, 17, 23, 50));
  const english = svc.tagsRepo.create({ name: 'English' });
  const t = svc.tasksRepo.create({ title: 'Late English' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(svc, clock, t.id); // 23:50 -> 00:15
  const days = svc.agendaDays('2026-10-17', 2).days;
  assert.equal(days[0].ttp, 0);
  assert.equal(days[1].ttp, 1);
  assert.equal(days[1].hoursSeconds, 1500);
});

// ------------------------------------------------------------------ tags & history

test('tags: create, reuse across tasks, rename, unique names, delete', async () => {
  const { svc } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  assert.throws(() => svc.tagsRepo.create({ name: 'english' }), /already exists/);
  const research = svc.tagsRepo.create({ name: 'Research', color: 'violet' });
  const a = svc.tasksRepo.create({ title: 'A' });
  const b = svc.tasksRepo.create({ title: 'B' });
  svc.tagsRepo.setTaskTags(a.id, [english.id, research.id]);
  svc.tagsRepo.setTaskTags(b.id, [english.id]);
  const listed = Object.fromEntries(svc.listTasks('all').map((t) => [t.title, t.tags.map((x) => x.name)]));
  assert.deepEqual(listed, { A: ['English', 'Research'], B: ['English'] });
  assert.equal(svc.tagsRepo.list().find((t) => t.name === 'English').task_count, 2);

  svc.tagsRepo.update(english.id, { name: 'English study' });
  assert.deepEqual(svc.listTasks('all').find((t) => t.title === 'B').tags.map((x) => x.name), ['English study']);

  svc.tagsRepo.setTaskTags(a.id, []);
  assert.deepEqual(svc.listTasks('all').find((t) => t.title === 'A').tags, []);
  svc.tagsRepo.delete(research.id);
  assert.equal(svc.tagsRepo.list().length, 1);
});

test('activity totals aggregate across tasks sharing a tag, without double counting', async () => {
  const { svc, clock } = await setup(new Date(2026, 9, 17, 7, 0));
  const english = svc.tagsRepo.create({ name: 'English' });
  const reading = svc.tagsRepo.create({ name: 'Reading' });
  const tasks = ['English 17/10/2026', 'English Listening Practice', 'English Writing Practice']
    .map((title) => svc.tasksRepo.create({ title }));
  tasks.forEach((t) => svc.tagsRepo.setTaskTags(t.id, [english.id]));
  svc.tagsRepo.setTaskTags(tasks[2].id, [english.id, reading.id]); // two tags on one task
  [4, 3, 2].forEach((n, i) => { for (let k = 0; k < n; k += 1) pomodoro(svc, clock, tasks[i].id); });

  const all = svc.activityStats({});
  const e = all.tags.find((t) => t.name === 'English');
  assert.equal(e.sessions, 9);
  assert.equal(e.seconds, 9 * 1500);  // 3 h 45 min
  assert.equal(all.tags.find((t) => t.name === 'Reading').sessions, 2);
  assert.equal(all.total.sessions, 9, 'a session with two tags is still one session overall');
  assert.equal(all.untagged.sessions, 0);

  const detail = svc.activityDetail(english.id, {});
  assert.equal(detail.sessions, 9);
  assert.deepEqual(detail.byTask.map((x) => x.sessions), [4, 3, 2]);
});

test('changing a task\'s tags keeps past classification unless a correction is requested', async () => {
  const { svc, clock } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const work = svc.tagsRepo.create({ name: 'Work' });
  const t = svc.tasksRepo.create({ title: 'Mixed' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(svc, clock, t.id);
  svc.tagsRepo.setTaskTags(t.id, [work.id]);           // change from now on
  pomodoro(svc, clock, t.id);
  let s = svc.activityStats({});
  assert.equal(s.tags.find((x) => x.name === 'English').sessions, 1);
  assert.equal(s.tags.find((x) => x.name === 'Work').sessions, 1);

  // tagging an old untagged task does not reach back...
  const old = svc.tasksRepo.create({ title: 'English 16/10' });
  pomodoro(svc, clock, old.id);
  svc.tagsRepo.setTaskTags(old.id, [english.id]);
  assert.equal(svc.activityStats({}).tags.find((x) => x.name === 'English').sessions, 1);
  // ...unless explicitly asked to
  const r = svc.tagsRepo.setTaskTags(old.id, [english.id], { applyToPast: true });
  assert.equal(r.reclassified, 1);
  s = svc.activityStats({});
  assert.equal(s.tags.find((x) => x.name === 'English').sessions, 2);

  // deleting the task keeps its history in the statistics
  svc.tasksRepo.delete(old.id);
  assert.equal(svc.activityStats({}).tags.find((x) => x.name === 'English').sessions, 2);
});

test('activity statistics filter by date range', async () => {
  const { svc, clock } = await setup(new Date(2026, 8, 10, 9, 0)); // 10 Sep 2026
  const prog = svc.tagsRepo.create({ name: 'Programming' });
  const t = svc.tasksRepo.create({ title: 'Code' });
  svc.tagsRepo.setTaskTags(t.id, [prog.id]);
  pomodoro(svc, clock, t.id);                                    // September
  clock.set(new Date(2026, 9, 17, 9, 0).getTime());
  pomodoro(svc, clock, t.id);                                    // October
  pomodoro(svc, clock, t.id);
  const sept = svc.activityStats({ from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime() });
  assert.equal(sept.tags[0].sessions, 1);
  const oct = svc.activityStats({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 1).getTime() });
  assert.equal(oct.tags[0].seconds, 3000);
  assert.equal(svc.activityStats({}).tags[0].sessions, 3);
});

// ------------------------------------------------------------------ years

test('agenda years: only years with data, plus the current year, in order', async () => {
  const { svc } = await setup(new Date(2026, 9, 17, 9, 0));
  assert.deepEqual(svc.agendaYears(), [2026]);
  svc.tasksRepo.create({ title: 'Old', scheduledDate: '2024-03-01' });
  svc.notesRepo.save('2025-12-31', 'NYE');
  svc.goalsRepo.create({ year: 2028, title: 'Future goal' });
  svc.sessionsRepo.record({
    runId: 'r-ny', sessionType: 'focus', plannedSeconds: 1500, actualSeconds: 1500,
    startedAt: '2022-06-01T10:00:00.000Z', endedAt: '2022-06-01T10:25:00.000Z', status: 'completed',
  });
  assert.deepEqual(svc.agendaYears(), [2022, 2024, 2025, 2026, 2028]);
});

// ------------------------------------------------------------------ goals

test('goals: milestones progress ignores dropped ones; manual, tasks and activity progress', async () => {
  const { svc, clock } = await setup(new Date(2026, 9, 17, 9, 0));
  const g = svc.goalsRepo.create({ year: 2026, title: 'The Final Problem', startMonth: '2020-11', actionPlan: 'Step by step' });
  ['M60 - The UK pt 01', 'East Wind', 'Roses - The UK pt 02', 'SJ/WJ', "Master's degree"].forEach((m) => svc.goalsRepo.addMilestone(g.id, m));
  let goal = svc.listGoals(2026)[0];
  const [m1, m2, m3, , m5] = goal.milestones;
  svc.goalsRepo.updateMilestone(m1.id, { status: 'done', doneOn: '2020-11-10' });
  svc.goalsRepo.updateMilestone(m2.id, { status: 'done' });
  svc.goalsRepo.updateMilestone(m3.id, { status: 'done' });
  svc.goalsRepo.updateMilestone(m5.id, { status: 'dropped' });
  goal = svc.listGoals(2026)[0];
  assert.equal(goal.progress.percent, 75);                          // 3 of 4 (one dropped)
  assert.equal(goal.milestones[0].done_on, '2020-11-10');
  assert.equal(goal.milestones[1].done_on, '2026-10-17', 'done date recorded automatically');

  svc.goalsRepo.update(g.id, { progressMode: 'manual', manualProgress: 80 });
  assert.equal(svc.listGoals(2026)[0].progress.percent, 80);

  const linked = svc.goalsRepo.create({ year: 2026, title: 'Summer job', progressMode: 'tasks' });
  const t1 = svc.tasksRepo.create({ title: 'Application', goalId: linked.id });
  svc.tasksRepo.create({ title: 'Get approved', goalId: linked.id });
  svc.tasksRepo.setStatus(t1.id, 'completed');
  assert.equal(svc.listGoals(2026).find((x) => x.id === linked.id).progress.percent, 50);

  const english = svc.tagsRepo.create({ name: 'English' });
  const study = svc.goalsRepo.create({ year: 2026, title: 'Study English for 200 hours in 2026', progressMode: 'activity', tagId: english.id, targetHours: 200 });
  const et = svc.tasksRepo.create({ title: 'English' });
  svc.tagsRepo.setTaskTags(et.id, [english.id]);
  for (let i = 0; i < 4; i += 1) pomodoro(svc, clock, et.id, 30);    // 2 hours
  const s = svc.listGoals(2026).find((x) => x.id === study.id);
  assert.equal(s.progress.seconds, 7200);
  assert.equal(s.progress.percent, 1);                              // 2 of 200 h
  assert.throws(() => svc.goalsRepo.create({ year: 2026, title: 'x', progressMode: 'activity' }), /tag/);

  svc.goalsRepo.setCompleted(g.id, true);
  assert.ok(svc.listGoals(2026).find((x) => x.id === g.id).completed_at);
  svc.goalsRepo.delete(linked.id);
  assert.equal(svc.tasksRepo.getById(t1.id).goal_id, null, 'tasks survive goal deletion');
  assert.deepEqual(svc.goalYears(), [2026]);
});

// ------------------------------------------------------------------ migration & backup

test('a version-2 database upgrades to v3: tasks get their creation date, nothing is lost', async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  db.run('CREATE TABLE schema_version (version INTEGER NOT NULL);');
  db.exec(fs.readFileSync(path.join(__dirname, '../../core/database/schema.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, '../../core/database/migrations/002-task-steps.sql'), 'utf8'));
  db.run('INSERT INTO schema_version VALUES (1), (2)');
  const created = new Date(2026, 9, 17, 14, 30).toISOString();
  db.run("INSERT INTO tasks (title, description, estimated_pomodoros, status, created_at, updated_at) VALUES ('English 17/10/2026', '', 12, 'active', ?, ?)", [created, created]);
  db.run("INSERT INTO task_steps (task_id, title, completed, position, created_at, updated_at) VALUES (1, 'Speaking', 0, 0, ?, ?)", [created, created]);
  const file = path.join(tmpDir(), 'v2.sqlite');
  fs.writeFileSync(file, Buffer.from(db.export()));

  const svc = await createServices({ dbPath: file });
  assert.equal(svc.db.schemaVersion(), SCHEMA_VERSION);
  const [t] = svc.listTasks('all');
  assert.equal(t.scheduled_date, localDate(Date.parse(created)));
  assert.equal(t.steps.length, 1);
  assert.deepEqual(t.tags, []);
});

test('backup and import carry tags, session classifications, notes and goals', async () => {
  const dir = tmpDir();
  const { svc: src, clock } = await setup();
  const english = src.tagsRepo.create({ name: 'English' });
  const t = src.tasksRepo.create({ title: 'English 17/10/2026' });
  src.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(src, clock, t.id);
  src.notesRepo.save('2026-10-17', 'Great study day');
  const g = src.goalsRepo.create({ year: 2026, title: 'The UK' });
  src.goalsRepo.addMilestone(g.id, 'UK P01');
  const backup = path.join(dir, 'backup.sqlite');
  src.db.backupTo(backup);

  const dst = await createServices({ dbPath: path.join(dir, 'live.sqlite') });
  dst.engine.init();
  const prepared = await dst.prepareImport(fs.readFileSync(backup));
  assert.equal(prepared.summary.tags, 1);
  assert.equal(prepared.summary.notes, 1);
  assert.equal(prepared.summary.goals, 1);
  dst.applyImport(prepared, { safetyDir: path.join(dir, 'b') });
  const day = dst.agendaDays('2026-10-17', 1).days[0];
  assert.equal(day.ttp, 1);
  assert.equal(day.hoursSeconds, 1500);
  assert.equal(day.note.body, 'Great study day');
  assert.equal(dst.listGoals(2026)[0].milestones[0].title, 'UK P01');
});

test('H.E. can follow a renamed tag through the hoursTagId setting', async () => {
  const { svc, clock } = await setup();
  const tag = svc.tagsRepo.create({ name: 'Inglês' });
  const t = svc.tasksRepo.create({ title: 'Estudo' });
  svc.tagsRepo.setTaskTags(t.id, [tag.id]);
  pomodoro(svc, clock, t.id);
  assert.equal(svc.agendaDays('2026-10-17', 1).days[0].hoursSeconds, 0, 'no "English" tag yet');
  svc.settingsRepo.update({ hoursTagId: tag.id });
  assert.equal(svc.agendaDays('2026-10-17', 1).days[0].hoursSeconds, 1500);
  assert.equal(svc.agendaDays('2026-10-17', 1).hoursTag.name, 'Inglês');
});
