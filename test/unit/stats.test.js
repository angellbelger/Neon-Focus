'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../../core/stats');

const settings = { dailyGoal: 4, weekStart: 1 };
let seq = 0;
function row(type, status, startLocal, minutes, actualMinutes = minutes) {
  const s = startLocal.getTime();
  return {
    id: ++seq,
    session_type: type,
    status,
    completed: status === 'completed' ? 1 : 0,
    planned_duration_seconds: minutes * 60,
    actual_duration_seconds: actualMinutes * 60,
    started_at: new Date(s).toISOString(),
    ended_at: new Date(s + minutes * 60000).toISOString(),
  };
}

test('empty period produces an empty state, not invented data', () => {
  const r = stats.buildReport({ period: 'week', anchor: Date.now(), sessions: [], settings, now: Date.now() });
  assert.equal(r.summary.hasData, false);
  assert.equal(r.summary.pomodoros, 0);
  assert.equal(r.best, null);
  assert.equal(r.comparison.focusDeltaPct, null);
  assert.equal(r.buckets.length, 7);
});

test('daily report: hourly distribution, counts and goal', () => {
  const day = new Date(2026, 9, 12);
  const sessions = [
    row('focus', 'completed', new Date(2026, 9, 12, 9, 0), 25),
    row('short_break', 'completed', new Date(2026, 9, 12, 9, 25), 5),
    row('focus', 'completed', new Date(2026, 9, 12, 9, 50), 25), // crosses 10:00
    row('focus', 'interrupted', new Date(2026, 9, 12, 14, 0), 25, 10),
  ];
  const r = stats.buildReport({ period: 'day', anchor: day.getTime(), sessions, settings, now: day.getTime() + 20 * 3600e3 });
  assert.equal(r.summary.pomodoros, 2);
  assert.equal(r.summary.completedSessions, 3);
  assert.equal(r.summary.interruptedSessions, 1);
  assert.equal(r.summary.focusSeconds, (25 + 25 + 10) * 60);
  assert.equal(r.buckets[9].focusSeconds, 35 * 60);
  assert.equal(r.buckets[10].focusSeconds, 15 * 60);
  assert.equal(r.buckets[10].pomodoros, 1); // ended at 10:15
  assert.equal(r.goal.progress, 0.5);
});

test('session crossing midnight is split between days; Pomodoro goes to the day it ended', () => {
  const s = row('focus', 'completed', new Date(2026, 9, 12, 23, 50), 20);
  const r1 = stats.buildReport({ period: 'day', anchor: new Date(2026, 9, 12, 12).getTime(), sessions: [s], settings, now: Date.now() });
  const r2 = stats.buildReport({ period: 'day', anchor: new Date(2026, 9, 13, 12).getTime(), sessions: [s], settings, now: Date.now() });
  assert.equal(r1.summary.focusSeconds, 600);
  assert.equal(r2.summary.focusSeconds, 600);
  assert.equal(r1.summary.pomodoros, 0);
  assert.equal(r2.summary.pomodoros, 1);
});

test('weekly report respects week start and finds the most productive day', () => {
  // 2026-10-12 is a Monday
  const sessions = [
    row('focus', 'completed', new Date(2026, 9, 12, 9), 25),
    row('focus', 'completed', new Date(2026, 9, 14, 9), 25),
    row('focus', 'completed', new Date(2026, 9, 14, 10), 25),
    row('focus', 'completed', new Date(2026, 9, 5, 10), 25), // previous week
  ];
  const now = new Date(2026, 9, 18, 20).getTime();
  const r = stats.buildReport({ period: 'week', anchor: new Date(2026, 9, 15).getTime(), sessions, settings, now });
  assert.equal(new Date(r.range.start).getDay(), 1);
  assert.equal(r.summary.pomodoros, 3);
  assert.equal(new Date(r.best.start).getDate(), 14);
  assert.equal(r.previous.pomodoros, 1);
  assert.equal(r.comparison.pomodoroDelta, 2);
  assert.equal(r.average.divisor, 7);

  const sunday = stats.buildReport({ period: 'week', anchor: new Date(2026, 9, 15).getTime(), sessions, settings: { ...settings, weekStart: 0 }, now });
  assert.equal(new Date(sunday.range.start).getDay(), 0);
});

test('monthly and yearly buckets have correct lengths, averages use elapsed time', () => {
  const now = new Date(2026, 1, 10, 12).getTime(); // Feb 10 2026
  const m = stats.buildReport({ period: 'month', anchor: now, sessions: [], settings, now });
  assert.equal(m.buckets.length, 28);
  assert.equal(m.average.divisor, 10);
  const y = stats.buildReport({ period: 'year', anchor: now, sessions: [row('focus', 'completed', new Date(2026, 0, 5, 9), 25)], settings, now });
  assert.equal(y.buckets.length, 12);
  assert.equal(y.average.divisor, 2);
  assert.equal(y.buckets[0].pomodoros, 1);
  assert.equal(new Date(y.best.start).getMonth(), 0);
});

test('breaks never add focus time or Pomodoros', () => {
  const d = new Date(2026, 9, 12, 9);
  const r = stats.buildReport({
    period: 'day', anchor: d.getTime(),
    sessions: [row('long_break', 'completed', d, 15), row('short_break', 'completed', d, 5)],
    settings, now: d.getTime(),
  });
  assert.equal(r.summary.pomodoros, 0);
  assert.equal(r.summary.focusSeconds, 0);
  assert.equal(r.summary.breaksCompleted, 2);
});

test('DST-safe day ranges always start at local midnight', () => {
  for (let m = 0; m < 12; m += 1) {
    const r = stats.periodRange('month', new Date(2026, m, 15).getTime(), 1);
    for (const b of r.buckets) {
      const d = new Date(b.start);
      assert.equal(d.getHours(), 0);
    }
  }
});

test('shiftAnchor moves by whole periods', () => {
  const a = new Date(2026, 0, 31).getTime();
  assert.equal(new Date(stats.shiftAnchor('month', a, 1)).getMonth(), 1);
  assert.equal(new Date(stats.shiftAnchor('year', a, -1)).getFullYear(), 2025);
  assert.equal(new Date(stats.shiftAnchor('week', a, 1)).getDate(), 7);
});

test('a period in progress is compared with the same elapsed part of the previous one', () => {
  const sessions = [
    row('focus', 'completed', new Date(2026, 9, 5, 9), 25),   // last Monday
    row('focus', 'completed', new Date(2026, 9, 9, 9), 25),   // last Friday
    row('focus', 'completed', new Date(2026, 9, 12, 9), 25),  // this Monday
  ];
  const now = new Date(2026, 9, 12, 18).getTime();           // Monday evening
  const r = stats.buildReport({ period: 'week', anchor: now, sessions, settings, now });
  assert.equal(r.previous.pomodoros, 2);
  assert.equal(r.comparison.basis, 'to-date');
  assert.equal(r.comparison.pomodoros, 1);
  assert.equal(r.comparison.pomodoroDelta, 0);
});
