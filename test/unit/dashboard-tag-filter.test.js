'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServices } = require('../../core/services');

const H = 3600;

function fakeClock(start) {
  let t = start;
  const c = () => t;
  c.set = (ms) => { t = ms; };
  c.advance = (ms) => { t += ms; };
  return c;
}

function pomodoro(svc, clock, taskId, minutes = 25) {
  svc.settingsRepo.update({ focusMinutes: minutes });
  svc.engine.refreshSettings();
  svc.engine.setMode('focus');
  svc.engine.setTask(taskId);
  svc.engine.start();
  for (let i = 0; i < minutes * 12; i += 1) { clock.advance(5000); svc.engine.tick(); }
}

async function setup() {
  const clock = fakeClock(new Date(2026, 9, 21, 9, 0).getTime()); // Wed 21 Oct 2026 (ISO week 43)
  const svc = await createServices({ dbPath: null, clock });
  svc.engine.init();
  const english = svc.tagsRepo.create({ name: 'English' });
  const german = svc.tagsRepo.create({ name: 'German' });
  const prog = svc.tagsRepo.create({ name: 'Programming' });
  const task = (title, tags) => { const t = svc.tasksRepo.create({ title }); svc.tagsRepo.setTaskTags(t.id, tags.map((x) => x.id)); return t; };
  const a = task('Listening', [english]);
  const b = task('Bilingual reading', [english, german]);
  const c = task('Refactor', [prog]);
  const d = svc.tasksRepo.create({ title: 'Untagged' });
  for (const t of [a, b, c, d]) { pomodoro(svc, clock, t.id); clock.advance(10 * 60 * 1000); }
  // one English session stopped early (interrupted)
  svc.engine.setMode('focus'); svc.engine.setTask(a.id); svc.engine.start();
  for (let i = 0; i < 60; i += 1) { clock.advance(5000); svc.engine.tick(); }
  svc.engine.reset();
  svc.tasksRepo.setStatus(a.id, 'completed');
  svc.tasksRepo.setStatus(c.id, 'completed');
  // legacy for this week and for 2025
  svc.saveLegacy({ year: 2026, week: 43, kind: 'pomodoros', value: 40 });
  svc.saveLegacy({ year: 2026, week: 43, kind: 'tag_hours', tagId: english.id, value: 3 * H });
  svc.saveLegacy({ year: 2026, week: 43, kind: 'tag_hours', tagId: german.id, value: 2 * H });
  svc.saveLegacy({ year: 2025, week: 10, kind: 'tag_hours', tagId: english.id, value: 5 * H });
  svc.saveLegacy({ year: 2025, week: 10, kind: 'pomodoros', value: 30 });
  return { svc, clock, english, german, prog };
}

const rep = (svc, period, tagIds, anchor) => svc.report({ period, anchor: anchor ?? new Date(2026, 9, 21, 12).getTime(), tagIds });

test('All tags is the existing report, unchanged', async () => {
  const { svc } = await setup();
  for (const period of ['day', 'week', 'month', 'year']) {
    const plain = rep(svc, period);
    const all = rep(svc, period, []);
    assert.deepEqual(all.summary, plain.summary, period);
    assert.deepEqual(all.buckets, plain.buckets, period);
    assert.equal(all.filter, null);
  }
  assert.equal(rep(svc, 'day').summary.pomodoros, 4);
  assert.equal(rep(svc, 'week').summary.pomodoros, 44, '4 tracked + 40 legacy TTP');
  assert.equal(rep(svc, 'day', [999]).filter, null, 'unknown tags fall back to All tags');
});

test('one tag: only its sessions, its legacy hours, its tasks', async () => {
  const { svc, english, prog } = await setup();
  const day = rep(svc, 'day', [english.id]);
  assert.deepEqual(day.filter.tags.map((t) => t.name), ['English']);
  assert.equal(day.summary.pomodoros, 2, 'Listening + Bilingual reading');
  assert.equal(day.summary.focusSeconds, 50 * 60 + 5 * 60, 'two Pomodoros + 5 min of the interrupted one');
  assert.equal(day.summary.interruptedSessions, 1);
  assert.equal(day.summary.tasksCompleted, 1, 'only the English task that was completed');
  assert.equal(day.summary.legacyPomodoros, 0, 'a day never includes weekly legacy');

  const week = rep(svc, 'week', [english.id]);
  assert.equal(week.summary.pomodoros, 2, 'untagged weekly legacy TTP is not attributed to a tag');
  assert.equal(week.summary.focusSeconds, 55 * 60 + 3 * H, 'tracked English + legacy English hours');
  assert.equal(week.summary.legacySeconds, 3 * H);
  assert.equal(week.legacyUntagged, 40, 'the excluded weekly TTP is reported so the UI can say so');

  const p = rep(svc, 'week', [prog.id]);
  assert.equal(p.summary.pomodoros, 1);
  assert.equal(p.summary.focusSeconds, 25 * 60);
  assert.equal(p.summary.tasksCompleted, 1);
});

test('several tags: combined, each session counted once', async () => {
  const { svc, english, german } = await setup();
  const day = rep(svc, 'day', [english.id, german.id]);
  assert.equal(day.summary.pomodoros, 2, 'Bilingual reading has both tags but counts once');
  const g = rep(svc, 'day', [german.id]);
  assert.equal(g.summary.pomodoros, 1);
  const week = rep(svc, 'week', [german.id, english.id]);
  assert.equal(week.summary.legacySeconds, 5 * H, 'legacy hours of both tags');
  assert.equal(week.summary.focusSeconds, 55 * 60 + 5 * H);
  const year = rep(svc, 'year', [english.id, german.id]);
  assert.equal(year.buckets[9].pomodoros, 2, 'October');
  assert.equal(year.buckets[9].focusSeconds, 55 * 60 + 5 * H);
});

test('works with the year selector, including legacy-only years and comparisons', async () => {
  const { svc, english, prog } = await setup();
  const y25 = rep(svc, 'year', [english.id], new Date(2025, 5, 1).getTime());
  assert.equal(y25.summary.hasData, true);
  assert.equal(y25.summary.pomodoros, 0);
  assert.equal(y25.summary.focusSeconds, 5 * H);
  assert.equal(y25.buckets[2].focusSeconds, 5 * H, 'March 2025');
  assert.equal(rep(svc, 'year', [prog.id], new Date(2025, 5, 1).getTime()).summary.hasData, false);
  const y26 = rep(svc, 'year', [english.id]);
  assert.equal(y26.previous.focusSeconds, 5 * H, 'the comparison year is filtered the same way');
  assert.equal(y26.summary.pomodoros, 2);
  // the All-tags year still has everything
  assert.equal(rep(svc, 'year', null, new Date(2025, 5, 1).getTime()).summary.pomodoros, 30);
});
