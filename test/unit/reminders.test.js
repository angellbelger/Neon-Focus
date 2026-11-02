'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServices } = require('../../core/services');
const { annualDate, onceStatus, isLeap } = require('../../core/database/repositories/reminders-repository');

function fakeClock(start) {
  let t = start;
  const c = () => t;
  c.set = (ms) => { t = ms; };
  return c;
}

async function setup(at = new Date(2026, 10, 2, 11, 0)) { // Mon 2 Nov 2026, 11:00
  const clock = fakeClock(at.getTime());
  const svc = await createServices({ dbPath: null, clock });
  svc.engine.init();
  return { svc, clock };
}

test('one-time reminders: validation, optional time/link/notes, links limited to the web', async () => {
  const { svc } = await setup();
  const r = svc.remindersRepo.save({ kind: 'once', title: '  Project   meeting ', date: '2026-11-05', time: '14:30', link: 'meet.google.com/abc-defg-hij', notes: 'Bring the slides' });
  assert.equal(r.title, 'Project meeting');
  assert.equal(r.link, 'https://meet.google.com/abc-defg-hij', 'a bare address becomes https://');
  assert.equal(svc.remindersRepo.save({ kind: 'once', title: 'Dentist', date: '2026-11-03' }).time, null, 'time is optional');
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: '', date: '2026-11-05' }), /title/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: 'x' }), /Date/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: 'x', date: '2026-02-30' }), /real day/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: 'x', date: '2026-11-05', time: '25:00' }), /14:30/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: 'x', date: '2026-11-05', link: 'javascript:alert(1)' }), /http/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'once', title: 'x', date: '2026-11-05', link: 'file:///C:/Windows' }), /http/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'weekly', title: 'x', date: '2026-11-05' }), /one-time or an annual/);
});

test('statuses: upcoming, today, past (with and without a time), completed; never repeated', async () => {
  const { svc, clock } = await setup();
  const mk = (title, date, time) => svc.remindersRepo.save({ kind: 'once', title, date, time });
  mk('Later today', '2026-11-02', '15:00');
  mk('Earlier today', '2026-11-02', '09:00');
  mk('All day today', '2026-11-02');
  mk('Yesterday', '2026-11-01', '10:00');
  const done = mk('Interview', '2026-11-04', '10:00');
  svc.remindersRepo.setDone(done.id, true);
  mk('Deadline', '2026-12-15');
  const st = Object.fromEntries(svc.reminderOverview().once.map((r) => [r.title, r.status]));
  assert.deepEqual(st, { Yesterday: 'past', 'All day today': 'upcoming', 'Earlier today': 'past', 'Later today': 'upcoming', Interview: 'completed', Deadline: 'upcoming' });
  assert.deepEqual(svc.reminderOverview().once.map((r) => r.title),
    ['Yesterday', 'All day today', 'Earlier today', 'Later today', 'Interview', 'Deadline'], 'chronological; all-day first on a date');
  // a year later the one-time ones are simply past: nothing repeats
  clock.set(new Date(2027, 10, 2, 9).getTime());
  assert.ok(svc.reminderOverview().once.every((r) => r.status !== 'upcoming'));
  assert.equal(svc.remindersRepo.listOnce().length, 6);
  assert.equal(onceStatus({ done: false, date: '2026-11-02', time: '11:00' }, new Date(2026, 10, 2, 11, 0).getTime()), 'upcoming', 'still upcoming during its minute');
  assert.throws(() => svc.remindersRepo.setDone(svc.remindersRepo.save({ kind: 'annual', title: 'B', month: 3, day: 15 }).id, true), /every year/);
});

test('annual reminders: day + month only, every year, edited in place, 29 Feb -> 28 Feb in non-leap years', async () => {
  const { svc } = await setup();
  const mom = svc.remindersRepo.save({ kind: 'annual', title: "Mother's birthday", month: 3, day: 15 });
  svc.remindersRepo.save({ kind: 'annual', title: 'Wedding anniversary', month: 9, day: 22, notes: 'Book dinner' });
  const leap = svc.remindersRepo.save({ kind: 'annual', title: 'Leap-day friend', month: 2, day: 29 });
  assert.throws(() => svc.remindersRepo.save({ kind: 'annual', title: 'x', month: 4, day: 31 }), /does not exist/);
  assert.throws(() => svc.remindersRepo.save({ kind: 'annual', title: 'x', month: 13, day: 1 }), /month/);

  for (const y of [1990, 2026, 2027, 2028, 2100]) {
    const r = svc.remindersRepo.annualBetween(`${y}-01-01`, `${y}-12-31`);
    assert.deepEqual(r[`${y}-03-15`].map((x) => x.title), ["Mother's birthday"], `15 March ${y}`);
    assert.deepEqual(r[`${y}-09-22`].map((x) => x.title), ['Wedding anniversary']);
    const feb = isLeap(y) ? `${y}-02-29` : `${y}-02-28`;
    assert.deepEqual(r[feb].map((x) => x.title), ['Leap-day friend'], `leap day in ${y} -> ${feb}`);
    assert.equal(Object.values(r).flat().length, 3, 'exactly one occurrence per year');
  }
  assert.equal(annualDate(2, 29, 2024), '2024-02-29');
  assert.equal(annualDate(2, 29, 2026), '2026-02-28');
  assert.equal(annualDate(2, 29, 2100), '2100-02-28', '2100 is not a leap year');

  // editing keeps the same record
  const edited = svc.remindersRepo.save({ id: mom.id, kind: 'annual', title: "Mom's birthday", month: 3, day: 15, notes: 'Call in the morning' });
  assert.equal(edited.id, mom.id);
  assert.equal(svc.remindersRepo.listAnnual().length, 3, 'no duplicate');
  // next occurrence (today is 2 Nov 2026)
  const ov = Object.fromEntries(svc.reminderOverview().annual.map((r) => [r.title, r]));
  assert.equal(ov["Mom's birthday"].next, '2027-03-15');
  assert.equal(ov['Leap-day friend'].next, '2027-02-28');
  assert.equal(ov['Wedding anniversary'].next, '2027-09-22');
  svc.remindersRepo.delete(leap.id);
  assert.equal(svc.remindersRepo.annualBetween('2028-02-01', '2028-03-01')['2028-02-29'], undefined, 'deleted: gone from every year');
});

test('the Agenda shows annual reminders on their dates in any year, after tasks and notes, without touching them', async () => {
  const { svc } = await setup();
  svc.tasksRepo.create({ title: 'Buy flowers', scheduledDate: '2027-03-15' });
  svc.notesRepo.save('2027-03-15', 'Family lunch');
  svc.remindersRepo.save({ kind: 'annual', title: "Mother's birthday", month: 3, day: 15 });
  svc.remindersRepo.save({ kind: 'annual', title: 'Cousin birthday', month: 3, day: 15 });
  svc.remindersRepo.save({ kind: 'once', title: 'Meeting', date: '2027-03-15', time: '10:00' });
  for (const monday of ['2027-03-15', '2030-03-11', '2001-03-12']) {
    const w = svc.agendaDays(monday, 7);
    const day = w.days.find((d) => d.date.endsWith('-03-15'));
    assert.deepEqual(day.reminders.map((r) => r.title).sort(), ['Cousin birthday', "Mother's birthday"], `week of ${monday}`);
    assert.equal(w.days.filter((d) => d.reminders.length).length, 1, 'only on that date');
  }
  const day = svc.agendaDays('2027-03-15', 1).days[0];
  assert.deepEqual(day.tasks.map((t) => t.title), ['Buy flowers'], 'tasks unchanged');
  assert.equal(day.note.body, 'Family lunch', 'note unchanged');
  assert.equal(day.reminders.some((r) => r.title === 'Meeting'), false, 'one-time reminders stay in Reminders');
  assert.equal(svc.db.get("SELECT COUNT(*) n FROM reminders WHERE kind = 'annual'").n, 2, 'nothing was generated in the database');
});

test('reminders survive a restart; Delete all data removes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-rem-'));
  const dbPath = path.join(dir, 'db.sqlite');
  let svc = await createServices({ dbPath });
  svc.remindersRepo.save({ kind: 'annual', title: 'Anniversary', month: 9, day: 22 });
  svc.remindersRepo.save({ kind: 'once', title: 'Call', date: '2026-12-01', link: 'https://zoom.us/j/1' });
  svc.db.close();
  svc = await createServices({ dbPath });
  assert.equal(svc.remindersRepo.listAnnual().length, 1);
  assert.equal(svc.remindersRepo.listOnce()[0].link, 'https://zoom.us/j/1');
  svc.clearAllData();
  assert.equal(svc.remindersRepo.listOnce().length + svc.remindersRepo.listAnnual().length, 0);
});
