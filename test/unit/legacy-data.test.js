'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { createServices } = require('../../core/services');
const { Database, SCHEMA_VERSION } = require('../../core/database/database');
const { weekOfDate, weekRange, weeksInYear, addDaysToDate } = require('../../core/dates');

function fakeClock(start) {
  let t = start;
  const c = () => t;
  c.set = (ms) => { t = ms; };
  c.advance = (ms) => { t += ms; };
  return c;
}

/** One full focus session through the real timer engine. */
function pomodoro(svc, clock, taskId, minutes = 25) {
  svc.settingsRepo.update({ focusMinutes: minutes });
  svc.engine.refreshSettings();
  svc.engine.setMode('focus');
  svc.engine.setTask(taskId);
  svc.engine.start();
  for (let i = 0; i < minutes * 12; i += 1) { clock.advance(5000); svc.engine.tick(); }
}

async function setup(startLocal = new Date(2026, 9, 21, 9, 0)) { // Wednesday 21 Oct 2026, ISO week 43
  const clock = fakeClock(startLocal.getTime());
  const svc = await createServices({ dbPath: null, clock });
  svc.engine.init();
  return { svc, clock };
}

const H = 3600;
const yearRange = (y) => [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()];

// ------------------------------------------------------------------ calendar weeks

test('week numbers follow "Weeks start on": ISO for Monday, 1 January week for Sunday', () => {
  assert.deepEqual(weekOfDate('2026-10-19', 1), { year: 2026, week: 43 });
  assert.deepEqual(weekOfDate('2026-10-18', 0), { year: 2026, week: 43 });
  assert.deepEqual(weekOfDate('2024-12-30', 1), { year: 2025, week: 1 }, 'ISO week 1 can start in December');
  assert.deepEqual(weekOfDate('2027-01-01', 1), { year: 2026, week: 53 }, 'and the last week can end in January');
  assert.deepEqual(weekOfDate('2025-12-28', 0), { year: 2026, week: 1 }, 'Sunday weeks: the week holding 1 January is week 1');
  assert.equal(weeksInYear(2026, 1), 53);
  assert.equal(weeksInYear(2025, 1), 52);
  assert.equal(weeksInYear(2026, 0), 52);
  assert.equal(weeksInYear(2022, 0), 53);
  assert.deepEqual(weekRange(2026, 43, 1), { from: '2026-10-19', to: '2026-10-25', anchor: '2026-10-22' });
  assert.deepEqual(weekRange(2026, 43, 0), { from: '2026-10-18', to: '2026-10-24', anchor: '2026-10-24' });
  // every week of 2015–2035 round-trips, and weeks tile the calendar with no gaps
  for (const ws of [0, 1]) {
    let expectFrom = weekRange(2015, 1, ws).from;
    for (let y = 2015; y <= 2035; y += 1) {
      for (let w = 1; w <= weeksInYear(y, ws); w += 1) {
        const r = weekRange(y, w, ws);
        assert.equal(r.from, expectFrom, `contiguous ${y}-W${w} ws=${ws}`);
        assert.equal(new Date(`${r.from}T12:00`).getDay(), ws);
        for (let d = 0; d < 7; d += 1) assert.deepEqual(weekOfDate(addDaysToDate(r.from, d), ws), { year: y, week: w });
        assert.equal(Number(r.anchor.slice(0, 4)), y, 'the anchor day lies in the week\'s own year');
        expectFrom = addDaysToDate(r.to, 1);
      }
    }
  }
});

// ------------------------------------------------------------------ records

test('legacy records: create, several tags per week, edit, delete; duplicates refused', async () => {
  const { svc } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const prog = svc.tagsRepo.create({ name: 'Programming' });
  const ttp = svc.saveLegacy({ year: 2025, week: 10, kind: 'pomodoros', value: 32 });
  const en = svc.saveLegacy({ year: 2025, week: 10, kind: 'tag_hours', tagId: english.id, value: 6.5 * H });
  svc.saveLegacy({ year: 2025, week: 10, kind: 'tag_hours', tagId: prog.id, value: 2 * H });
  assert.equal(svc.legacyList(2025).length, 3, 'one TTP and two tags in the same week');

  assert.throws(() => svc.saveLegacy({ year: 2025, week: 10, kind: 'pomodoros', value: 5 }), (e) => e.code === 'DUPLICATE' && e.existingId === ttp.id);
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 10, kind: 'tag_hours', tagId: english.id, value: H }), /already has hours for "English"/);
  assert.throws(() => svc.saveLegacy({ id: en.id, year: 2025, week: 10, kind: 'tag_hours', tagId: prog.id, value: H }), /DUPLICATE|already has/, 'editing into a clash is refused');

  const edited = svc.saveLegacy({ id: ttp.id, year: 2025, week: 10, kind: 'pomodoros', value: 35 });
  assert.equal(edited.value, 35);
  assert.equal(svc.saveLegacy({ id: en.id, year: 2025, week: 11, kind: 'tag_hours', tagId: english.id, value: 7 * H }).week, 11, 'a record can move to another week');

  assert.throws(() => svc.saveLegacy({ year: 2025, week: 53, kind: 'pomodoros', value: 1 }), /Week must be between 1 and 52/, '2025 has 52 ISO weeks');
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 1, kind: 'pomodoros', value: 0 }), /between 1 and 5000/);
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 1, kind: 'pomodoros', value: 2.5 }), /whole number/);
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 1, kind: 'tag_hours', tagId: 999, value: H }), /existing tag/);
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 1, kind: 'tag_hours', tagId: english.id, value: 169 * H }), /Hours/);
  assert.throws(() => svc.saveLegacy({ year: 2025, week: 1, kind: 'other', value: 1 }), /Choose/);

  assert.equal(svc.legacyRepo.delete(ttp.id), true);
  assert.equal(svc.legacyList(2025).length, 2);
  assert.ok(svc.saveLegacy({ year: 2025, week: 10, kind: 'pomodoros', value: 30 }), 'after deleting, the week can be entered again');
});

test('legacy weeks list and dates follow the week setting', async () => {
  const { svc } = await setup();
  let w = svc.legacyWeeks(2026);
  assert.equal(w.weeks.length, 53);
  assert.deepEqual(w.current, { year: 2026, week: 43 });
  assert.deepEqual(w.weeks[42], { week: 43, from: '2026-10-19', to: '2026-10-25' });
  svc.saveLegacy({ year: 2026, week: 53, kind: 'pomodoros', value: 3 });
  svc.settingsRepo.update({ weekStart: 0 });
  w = svc.legacyWeeks(2026);
  assert.equal(w.weeks.length, 52);
  assert.deepEqual(w.weeks[42], { week: 43, from: '2026-10-18', to: '2026-10-24' });
  const [rec] = svc.legacyList(2026);
  assert.equal(rec.inYear, false, 'a week 53 record is flagged when the setting leaves the year with 52 weeks');
});

// ------------------------------------------------------------------ statistics

test('the Agenda week box adds legacy TTP and the selected tag\'s legacy hours to tracked data', async () => {
  const { svc, clock } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const research = svc.tagsRepo.create({ name: 'Research' });
  const t = svc.tasksRepo.create({ title: 'Listening', scheduledDate: '2026-10-21' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(svc, clock, t.id);                         // tracked: 1 Pomodoro, 25 min English, on Wed 21 Oct
  const sessionsBefore = svc.db.get('SELECT COUNT(*) n FROM sessions').n;
  const tasksBefore = JSON.stringify(svc.db.all('SELECT * FROM tasks'));

  // legacy for ISO week 43 of 2026 (19–25 Oct) and for another week
  svc.saveLegacy({ year: 2026, week: 43, kind: 'pomodoros', value: 10 });
  svc.saveLegacy({ year: 2026, week: 43, kind: 'tag_hours', tagId: english.id, value: 3 * H });
  svc.saveLegacy({ year: 2026, week: 43, kind: 'tag_hours', tagId: research.id, value: 2 * H });
  svc.saveLegacy({ year: 2026, week: 40, kind: 'pomodoros', value: 99 });

  let r = svc.agendaDays('2026-10-19', 7);
  assert.equal(r.week.ttp, 11, '1 tracked + 10 legacy');
  assert.equal(r.week.hoursSeconds, 25 * 60 + 3 * H, 'H.E. = tracked English + legacy English');
  assert.deepEqual(r.week.legacy, { pomodoros: 10, hoursSeconds: 3 * H, tagSeconds: 3 * H, records: 3 });
  assert.equal(r.days.find((d) => d.date === '2026-10-21').ttp, 1, 'day rows show tracked data only');
  assert.equal(r.days.reduce((n, d) => n + d.ttp, 0), 1);

  // choosing another tag in Settings switches the hours (tracked + legacy) at once
  svc.settingsRepo.update({ hoursTagId: research.id });
  r = svc.agendaDays('2026-10-19', 7);
  assert.equal(r.hoursTag.name, 'Research');
  assert.equal(r.week.hoursSeconds, 2 * H);
  assert.equal(r.week.ttp, 11, 'TTP stays the total of all Pomodoros');

  // Sunday-first weeks: the same record (2026 W43) is the week 18–24 Oct
  svc.settingsRepo.update({ weekStart: 0, hoursTagId: null });
  assert.equal(svc.agendaDays('2026-10-18', 7).week.ttp, 11);
  assert.equal(svc.agendaDays('2026-10-25', 7).week.ttp, 0);

  // nothing else changed
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM sessions').n, sessionsBefore);
  assert.equal(JSON.stringify(svc.db.all('SELECT * FROM tasks')), tasksBefore);
  assert.equal(svc.today().pomodoros, 1, 'today/dashboard figures come from sessions only');
});

test('several tags in the Agenda: each has its own hours (tracked + legacy); none selected = TTP only', async () => {
  const { svc, clock } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const german = svc.tagsRepo.create({ name: 'German' });
  const prog = svc.tagsRepo.create({ name: 'Programming' });
  const both = svc.tasksRepo.create({ title: 'Bilingual reading', scheduledDate: '2026-10-21' });
  svc.tagsRepo.setTaskTags(both.id, [english.id, german.id]);
  pomodoro(svc, clock, both.id);                                   // 25 min counts for English and for German
  svc.saveLegacy({ year: 2026, week: 43, kind: 'tag_hours', tagId: prog.id, value: 6 * H });
  svc.saveLegacy({ year: 2026, week: 43, kind: 'pomodoros', value: 4 });

  // not chosen yet: the earlier single choice / the tag named "English"
  assert.equal(svc.settingsRepo.getAll().hoursTagIds, null);
  assert.deepEqual(svc.hoursTags().map((t) => t.name), ['English']);

  svc.settingsRepo.update({ hoursTagIds: [prog.id, english.id, german.id] });
  let r = svc.agendaDays('2026-10-19', 7);
  assert.deepEqual(r.tags.map((t) => t.name), ['English', 'German', 'Programming'], 'shown in tag-name order');
  assert.deepEqual(r.week.tags.map((t) => [t.name, t.seconds, t.legacySeconds]),
    [['English', 1500, 0], ['German', 1500, 0], ['Programming', 6 * H, 6 * H]]);
  assert.equal(r.week.ttp, 5, 'TTP: 1 tracked + 4 legacy, counted once');
  const wed = r.days.find((d) => d.date === '2026-10-21');
  assert.deepEqual(wed.tagSeconds, { [english.id]: 1500, [german.id]: 1500, [prog.id]: 0 });

  // remove one, add none: the list is exactly what is stored
  svc.settingsRepo.update({ hoursTagIds: [german.id] });
  assert.deepEqual(svc.agendaDays('2026-10-19', 7).week.tags.map((t) => t.name), ['German']);
  svc.settingsRepo.update({ hoursTagIds: [] });
  r = svc.agendaDays('2026-10-19', 7);
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.week.tags, []);
  assert.equal(r.week.ttp, 5);
  assert.equal(r.hoursTag, null);

  // a deleted tag simply drops out of the selection
  svc.settingsRepo.update({ hoursTagIds: [english.id, prog.id] });
  svc.tagsRepo.delete(prog.id);
  assert.deepEqual(svc.hoursTags().map((t) => t.name), ['English']);

  // validation
  assert.throws(() => svc.settingsRepo.update({ hoursTagIds: 'English' }), /list of tags/);
  assert.throws(() => svc.settingsRepo.update({ hoursTagIds: [0] }), /valid tag ids/);
  assert.deepEqual(svc.settingsRepo.update({ hoursTagIds: [english.id, english.id] }).hoursTagIds, [english.id], 'duplicates collapse');

  // "so far" = all recorded time: tracked + legacy, per tag
  const all = svc.activityStats({});
  assert.equal(all.total.sessions, 5);
  assert.equal(all.tags.find((t) => t.name === 'German').seconds, 1500);
});

test('year totals, Activity Statistics and tag goals combine legacy and tracked time', async () => {
  const { svc, clock } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  const t = svc.tasksRepo.create({ title: 'Reading' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(svc, clock, t.id);
  svc.saveLegacy({ year: 2026, week: 2, kind: 'pomodoros', value: 40 });
  svc.saveLegacy({ year: 2026, week: 2, kind: 'tag_hours', tagId: english.id, value: 10 * H });
  svc.saveLegacy({ year: 2026, week: 1, kind: 'tag_hours', tagId: english.id, value: 1 * H }); // 29 Dec 2025 – 4 Jan 2026: counts in 2026
  svc.saveLegacy({ year: 2025, week: 52, kind: 'pomodoros', value: 7 });                      // 22–28 Dec 2025

  const [a, b] = yearRange(2026);
  const s = svc.activityStats({ from: a, to: b });
  const en = s.tags.find((x) => x.name === 'English');
  assert.equal(en.seconds, 25 * 60 + 11 * H);
  assert.equal(en.legacySeconds, 11 * H);
  assert.equal(en.sessions, 1, 'legacy hours add time, not Pomodoro sessions');
  assert.equal(s.total.sessions, 41, 'TTP for 2026 = 1 tracked + 40 legacy');
  assert.equal(s.total.legacyPomodoros, 40);
  assert.equal(svc.activityStats({ from: yearRange(2025)[0], to: yearRange(2025)[1] }).total.sessions, 7);
  assert.equal(svc.activityStats({}).total.sessions, 48, 'all time');

  const d = svc.activityDetail(english.id, { from: a, to: b });
  assert.equal(d.seconds, 25 * 60 + 11 * H);
  assert.equal(d.legacySeconds, 11 * H);
  assert.ok(d.byTask.some((x) => x.legacy && x.seconds === 11 * H), 'a "Legacy records" line');
  assert.equal(d.byMonth.find((m) => m.month === '2026-01').seconds, 11 * H);

  assert.equal(svc.tagSeconds(english.id, a, b), 25 * 60 + 11 * H, 'goal progress counts legacy hours');
  const goal = svc.goalsRepo.create({ year: 2026, title: '200 hours of English', progressMode: 'activity', tagId: english.id, targetHours: 200 });
  assert.equal(svc.listGoals(2026).find((g) => g.id === goal.id).progress.seconds, 25 * 60 + 11 * H);

  assert.ok(svc.agendaYears().includes(2025), 'years with only legacy data get a planner');
});

test('Dashboard reports include legacy data for past years and agree with the Agenda and Activity Statistics', async () => {
  const { svc, clock } = await setup();                   // today: Wed 21 Oct 2026
  const english = svc.tagsRepo.create({ name: 'English' });
  const t = svc.tasksRepo.create({ title: 'Reading' });
  svc.tagsRepo.setTaskTags(t.id, [english.id]);
  pomodoro(svc, clock, t.id);                             // tracked 2026: 1 Pomodoro, 25 min English
  // 2025: legacy only (no sessions that year)
  svc.saveLegacy({ year: 2025, week: 10, kind: 'pomodoros', value: 40 });          // 3–9 Mar 2025
  svc.saveLegacy({ year: 2025, week: 10, kind: 'tag_hours', tagId: english.id, value: 5 * H });
  svc.saveLegacy({ year: 2025, week: 1, kind: 'pomodoros', value: 6 });            // 30 Dec 2024 – 5 Jan 2025: a 2025 week
  svc.saveLegacy({ year: 2026, week: 43, kind: 'pomodoros', value: 10 });          // this week
  const before = JSON.stringify([svc.db.all('SELECT * FROM sessions'), svc.db.all('SELECT * FROM legacy_records')]);

  // year 2025: summary, months, previous-year comparison
  const y25 = svc.report({ period: 'year', anchor: new Date(2025, 5, 1).getTime() });
  assert.equal(y25.summary.hasData, true, 'a year with only legacy data is not "empty"');
  assert.equal(y25.summary.pomodoros, 46);
  assert.equal(y25.summary.legacyPomodoros, 46);
  assert.equal(y25.summary.focusSeconds, 5 * H);
  assert.equal(y25.buckets[0].pomodoros, 6, 'W1 2025 (anchor Thu 2 Jan) is January 2025');
  assert.equal(y25.buckets[2].pomodoros, 40, 'W10 is March');
  assert.equal(y25.buckets[2].focusSeconds, 5 * H);
  assert.equal(y25.average.divisor, 12);
  assert.equal(svc.report({ period: 'year', anchor: new Date(2024, 5, 1).getTime() }).summary.pomodoros, 0, 'nothing leaks into 2024');

  // 2026 compared with 2025 to date (both include legacy)
  const y26 = svc.report({ period: 'year', anchor: clock() });
  assert.equal(y26.summary.pomodoros, 11);
  assert.equal(y26.previous.pomodoros, 46);
  assert.equal(y26.comparison.pomodoros, 46, 'to 21 Oct 2025, all 2025 legacy weeks are included');

  // same numbers as the Agenda and Activity Statistics
  const [a, b] = yearRange(2025);
  assert.equal(svc.activityStats({ from: a, to: b }).total.sessions, y25.summary.pomodoros);
  const week = svc.report({ period: 'week', anchor: clock() });
  assert.equal(week.summary.pomodoros, svc.agendaDays('2026-10-19', 7).week.ttp, 'week report = Agenda week box');
  assert.equal(week.summary.pomodoros, 11);
  assert.ok(week.buckets.every((x) => x.legacyPomodoros === undefined), 'weekly totals are not split across days');
  assert.equal(svc.report({ period: 'month', anchor: clock() }).summary.pomodoros, 11);
  assert.equal(svc.report({ period: 'day', anchor: clock() }).summary.pomodoros, 1, 'a day report never includes weekly legacy totals');

  // Sunday-first weeks: the record moves with the week, still counted once
  svc.settingsRepo.update({ weekStart: 0 });
  assert.equal(svc.report({ period: 'week', anchor: new Date(2026, 9, 24, 12).getTime() }).summary.pomodoros, 11, 'Sun 18 – Sat 24 Oct');
  assert.equal(svc.report({ period: 'week', anchor: new Date(2026, 9, 25, 12).getTime() }).summary.pomodoros, 0);
  assert.equal(svc.report({ period: 'year', anchor: new Date(2025, 5, 1).getTime() }).summary.pomodoros, 46);
  svc.settingsRepo.update({ weekStart: 1 });

  // navigation: years and the earliest record (legacy W1 2025 starts Mon 30 Dec 2024)
  assert.deepEqual(y25.years, [2025, 2026]);
  assert.equal(new Date(y25.firstRecordAt).getTime(), new Date(2024, 11, 30).getTime());
  assert.equal(JSON.stringify([svc.db.all('SELECT * FROM sessions'), svc.db.all('SELECT * FROM legacy_records')]), before, 'reports never change records');
});

test('deleting a tag keeps its legacy rows by name but they stop counting; clearing all data removes them', async () => {
  const { svc } = await setup();
  const english = svc.tagsRepo.create({ name: 'English' });
  svc.saveLegacy({ year: 2026, week: 5, kind: 'tag_hours', tagId: english.id, value: 4 * H });
  svc.saveLegacy({ year: 2026, week: 5, kind: 'pomodoros', value: 9 });
  svc.tagsRepo.delete(english.id);
  const rows = svc.legacyList(2026);
  assert.equal(rows.length, 2);
  const orphan = rows.find((r) => r.kind === 'tag_hours');
  assert.equal(orphan.tag_id, null);
  assert.equal(orphan.tag_name, 'English');
  const [a, b] = yearRange(2026);
  assert.equal(svc.activityStats({ from: a, to: b }).total.seconds, 0);
  assert.equal(svc.activityStats({ from: a, to: b }).total.sessions, 9);
  svc.clearAllData();
  assert.equal(svc.legacyList().length, 0);
});

test('the schema upgrades an older database and keeps legacy data through backup and import', async () => {
  assert.ok(SCHEMA_VERSION >= 4);
  const { svc } = await setup();
  svc.saveLegacy({ year: 2024, week: 20, kind: 'pomodoros', value: 21 });
  const bytes = Buffer.from(svc.db.db.export());
  const prepared = await Database.prepareImport(bytes);
  assert.equal(prepared.summary.legacy, 1);

  // a version-3 database (no legacy table) is upgraded on open
  const SQL = await initSqlJs();
  const old = new SQL.Database(bytes);
  old.run('DROP TABLE legacy_records');
  old.run('DROP TABLE media_files');
  old.run('DROP TABLE reminders');
  old.run('DELETE FROM schema_version WHERE version >= 4');
  const upgraded = await Database.prepareImport(Buffer.from(old.export()));
  assert.equal(upgraded.summary.legacy, 0);
  assert.equal(upgraded.summary.schemaVersion, 3);
});
