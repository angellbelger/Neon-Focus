'use strict';

/**
 * Productivity statistics, computed from raw session rows.
 *
 * All period boundaries are built in LOCAL time with calendar arithmetic
 * (setDate / new Date(y, m, d)), so days stay correct across DST changes.
 * Timestamps in the database are UTC; conversion happens here.
 *
 * Attribution rules:
 *  - A Pomodoro (completed focus session) belongs to the bucket in which it ended.
 *  - Focus time is spread across buckets in proportion to how much of the
 *    session's wall-clock span overlaps each bucket (so a session crossing
 *    midnight or an hour boundary is split, not double-counted).
 *  - Focus time includes every second actually spent in focus mode, including
 *    sessions stopped early. Pomodoros only count completed focus sessions.
 *    Breaks never count as Pomodoros or focus time.
 */

const PERIODS = ['day', 'week', 'month', 'year'];

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * @returns {{start:number,end:number,buckets:{start:number,end:number}[], unit:'hour'|'day'|'month'}}
 */
function periodRange(period, anchorMs, weekStart = 1) {
  const a = new Date(anchorMs);
  let start;
  let end;
  const buckets = [];
  let unit;
  switch (period) {
    case 'day': {
      start = startOfDay(anchorMs);
      end = addDays(start, 1);
      unit = 'hour';
      const y = a.getFullYear(); const m = a.getMonth(); const d = a.getDate();
      for (let h = 0; h < 24; h += 1) {
        const bs = h === 0 ? start : new Date(y, m, d, h).getTime();
        const be = h === 23 ? end : new Date(y, m, d, h + 1).getTime();
        buckets.push({ start: bs, end: Math.max(bs, be) });
      }
      break;
    }
    case 'week': {
      const day0 = startOfDay(anchorMs);
      const diff = (new Date(day0).getDay() - weekStart + 7) % 7;
      start = addDays(day0, -diff);
      end = addDays(start, 7);
      unit = 'day';
      for (let i = 0; i < 7; i += 1) buckets.push({ start: addDays(start, i), end: addDays(start, i + 1) });
      break;
    }
    case 'month': {
      start = new Date(a.getFullYear(), a.getMonth(), 1).getTime();
      end = new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime();
      unit = 'day';
      for (let t = start; t < end; t = addDays(t, 1)) buckets.push({ start: t, end: addDays(t, 1) });
      break;
    }
    case 'year': {
      start = new Date(a.getFullYear(), 0, 1).getTime();
      end = new Date(a.getFullYear() + 1, 0, 1).getTime();
      unit = 'month';
      for (let m = 0; m < 12; m += 1) {
        buckets.push({
          start: new Date(a.getFullYear(), m, 1).getTime(),
          end: new Date(a.getFullYear(), m + 1, 1).getTime(),
        });
      }
      break;
    }
    default:
      throw new Error(`Unknown period "${period}".`);
  }
  return { start, end, buckets, unit };
}

/** The period immediately before the one containing anchorMs. */
function previousRange(period, anchorMs, weekStart = 1) {
  const cur = periodRange(period, anchorMs, weekStart);
  return periodRange(period, cur.start - 1, weekStart);
}

/** Moves an anchor by n periods. */
function shiftAnchor(period, anchorMs, n) {
  const d = new Date(anchorMs);
  switch (period) {
    case 'day': d.setDate(d.getDate() + n); break;
    case 'week': d.setDate(d.getDate() + 7 * n); break;
    case 'month': d.setDate(1); d.setMonth(d.getMonth() + n); break;
    case 'year': d.setMonth(0, 1); d.setFullYear(d.getFullYear() + n); break;
    default: throw new Error(`Unknown period "${period}".`);
  }
  return d.getTime();
}

function parseRow(row) {
  return {
    ...row,
    startMs: Date.parse(row.started_at),
    endMs: Date.parse(row.ended_at),
  };
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Focus seconds of one session attributable to [bStart, bEnd). */
function focusSecondsIn(s, bStart, bEnd) {
  if (s.session_type !== 'focus' || s.actual_duration_seconds <= 0) return 0;
  const span = s.endMs - s.startMs;
  if (span <= 0) return s.endMs >= bStart && s.endMs < bEnd ? s.actual_duration_seconds : 0;
  return (s.actual_duration_seconds * overlap(s.startMs, s.endMs, bStart, bEnd)) / span;
}

function isPomodoro(s) {
  return s.session_type === 'focus' && s.status === 'completed';
}

function aggregateBuckets(sessions, buckets) {
  return buckets.map((b) => {
    let focus = 0;
    let pomodoros = 0;
    for (const s of sessions) {
      focus += focusSecondsIn(s, b.start, b.end);
      if (isPomodoro(s) && s.endMs >= b.start && s.endMs < b.end) pomodoros += 1;
    }
    return { start: b.start, end: b.end, focusSeconds: Math.round(focus), pomodoros };
  });
}

function summarise(sessions, start, end) {
  const inRange = sessions.filter((s) => s.endMs >= start && s.endMs < end);
  let focus = 0;
  for (const s of sessions) focus += focusSecondsIn(s, start, end);
  const count = (pred) => inRange.filter(pred).length;
  return {
    pomodoros: count(isPomodoro),
    focusSeconds: Math.round(focus),
    completedSessions: count((s) => s.status === 'completed'),
    interruptedSessions: count((s) => s.status === 'interrupted'),
    abandonedSessions: count((s) => s.status === 'abandoned'),
    focusSessionsStarted: count((s) => s.session_type === 'focus'),
    breaksCompleted: count((s) => s.session_type !== 'focus' && s.status === 'completed'),
    sessionCount: sessions.filter((s) => overlap(s.startMs, Math.max(s.endMs, s.startMs + 1), start, end) > 0).length,
  };
}

/** Pomodoros per local calendar day within [start, end). */
function pomodorosByDay(sessions, start, end) {
  const map = new Map();
  for (const s of sessions) {
    if (isPomodoro(s) && s.endMs >= start && s.endMs < end) {
      const k = dayKey(s.endMs);
      map.set(k, (map.get(k) || 0) + 1);
    }
  }
  return map;
}

function pctDelta(cur, prev) {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Builds the full report for a period.
 *
 * @param {object} p
 * @param {'day'|'week'|'month'|'year'} p.period
 * @param {number} p.anchor   any ms timestamp inside the wanted period
 * @param {object[]} p.sessions  rows overlapping [previous.start, current.end)
 * @param {number} p.tasksCompleted       tasks completed in the current period
 * @param {number} p.tasksCompletedPrev   tasks completed in the previous period
 * @param {{dailyGoal:number, weekStart:number}} p.settings
 * @param {number} p.now
 */
function buildReport({ period, anchor, sessions, tasksCompleted = 0, tasksCompletedPrev = 0, settings, now }) {
  if (!PERIODS.includes(period)) throw new Error(`Unknown period "${period}".`);
  const weekStart = settings.weekStart ?? 1;
  const cur = periodRange(period, anchor, weekStart);
  const prev = previousRange(period, anchor, weekStart);
  const rows = sessions.map(parseRow);

  const curRows = rows.filter((s) => overlap(s.startMs, Math.max(s.endMs, s.startMs + 1), cur.start, cur.end) > 0);
  const prevRows = rows.filter((s) => overlap(s.startMs, Math.max(s.endMs, s.startMs + 1), prev.start, prev.end) > 0);

  const buckets = aggregateBuckets(curRows, cur.buckets);
  const prevBuckets = aggregateBuckets(prevRows, prev.buckets);
  const summary = { ...summarise(curRows, cur.start, cur.end), tasksCompleted };
  const previous = { ...summarise(prevRows, prev.start, prev.end), tasksCompleted: tasksCompletedPrev };
  summary.hasData = summary.sessionCount > 0;
  previous.hasData = previous.sessionCount > 0;

  const isCurrent = now >= cur.start && now < cur.end;
  const isFuture = cur.start > now;

  // For a period still in progress, compare against the same elapsed portion
  // of the previous period (e.g. Mon–Wed vs last Mon–Wed), not its full total.
  let comparedTo = previous;
  if (isCurrent) {
    const cut = Math.min(prev.start + (now - cur.start), prev.end);
    comparedTo = { ...summarise(prevRows, prev.start, cut), hasData: previous.hasData };
  }

  // Days covered so far (for averages): whole period if in the past.
  let daysCounted = 0;
  if (!isFuture) {
    const lastDay = isCurrent ? startOfDay(now) : addDays(cur.end, -1);
    for (let t = startOfDay(cur.start); t <= lastDay; t = addDays(t, 1)) daysCounted += 1;
  }

  // Best bucket (by focus time, tie-broken by Pomodoros); null if nothing happened.
  let best = null;
  for (const b of buckets) {
    if (b.focusSeconds <= 0 && b.pomodoros <= 0) continue;
    if (!best || b.focusSeconds > best.focusSeconds
        || (b.focusSeconds === best.focusSeconds && b.pomodoros > best.pomodoros)) best = b;
  }

  // Goal tracking
  const dailyGoal = settings.dailyGoal;
  const byDay = pomodorosByDay(curRows, cur.start, cur.end);
  let daysGoalMet = 0;
  for (const n of byDay.values()) if (n >= dailyGoal) daysGoalMet += 1;
  const goal = {
    dailyGoal,
    progress: period === 'day' ? Math.min(summary.pomodoros / dailyGoal, 1) : null,
    daysGoalMet,
    daysCounted,
  };

  // Averages
  let average;
  if (period === 'year') {
    let monthsCounted = 0;
    if (!isFuture) {
      monthsCounted = isCurrent ? new Date(now).getMonth() + 1 : 12;
    }
    average = {
      unit: 'month',
      divisor: monthsCounted,
      focusSeconds: monthsCounted ? summary.focusSeconds / monthsCounted : 0,
      pomodoros: monthsCounted ? summary.pomodoros / monthsCounted : 0,
    };
  } else {
    average = {
      unit: 'day',
      divisor: daysCounted,
      focusSeconds: daysCounted ? summary.focusSeconds / daysCounted : 0,
      pomodoros: daysCounted ? summary.pomodoros / daysCounted : 0,
    };
  }

  return {
    period,
    unit: cur.unit,
    range: { start: cur.start, end: cur.end },
    prevRange: { start: prev.start, end: prev.end },
    isCurrent,
    isFuture,
    buckets,
    prevBuckets,
    summary,
    previous,
    comparison: {
      basis: isCurrent ? 'to-date' : 'full',
      pomodoros: comparedTo.pomodoros,
      focusSeconds: comparedTo.focusSeconds,
      focusDeltaPct: previous.hasData ? pctDelta(summary.focusSeconds, comparedTo.focusSeconds) : null,
      pomodoroDelta: previous.hasData ? summary.pomodoros - comparedTo.pomodoros : null,
      pomodoroDeltaPct: previous.hasData ? pctDelta(summary.pomodoros, comparedTo.pomodoros) : null,
    },
    best,
    average,
    goal,
  };
}

module.exports = {
  PERIODS, periodRange, previousRange, shiftAnchor, buildReport, startOfDay, addDays,
  _internal: { focusSecondsIn, aggregateBuckets, summarise },
};
