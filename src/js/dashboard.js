// Dashboard: day / week / month / year statistics computed in the main
// process from stored sessions.

import { api, store } from './store.js';
import { $, h, radioGroup, toastError } from './ui.js';
import { duration, durationParts, periodLabel, bucketLabel, dateShort, dateLong, monthName, weekday, plural } from './format.js';
import { renderLineChart } from './charts.js';
import { registerPage, currentPage } from './navigation.js';

const state = { period: 'day', anchor: Date.now(), compare: 'focus', report: null, loading: 0 };

const PREV_NAME = {
  day: [ 'yesterday', 'the previous day' ],
  week: [ 'last week', 'the previous week' ],
  month: [ 'last month', 'the previous month' ],
  year: [ 'last year', 'the previous year' ],
};
const UNIT_NAME = { day: 'day', week: 'week', month: 'month', year: 'year' };

function shift(period, anchor, n) {
  const d = new Date(anchor);
  if (period === 'day') d.setDate(d.getDate() + n);
  else if (period === 'week') d.setDate(d.getDate() + 7 * n);
  else if (period === 'month') { d.setDate(1); d.setMonth(d.getMonth() + n); }
  else { d.setMonth(0, 1); d.setFullYear(d.getFullYear() + n); }
  return d.getTime();
}

const TO_DATE_NAME = {
  day: 'this time yesterday', week: 'this point last week', month: 'this point last month', year: 'this point last year',
};

function prevName(r) { return PREV_NAME[r.period][r.isCurrent ? 0 : 1]; }
function compareName(r) { return r.comparison.basis === 'to-date' ? TO_DATE_NAME[r.period] : prevName(r); }

function deltaText(cur, prev, r, kind) {
  if (!r.previous.hasData) return { text: `No data for ${prevName(r)}`, trend: null };
  const diff = cur - prev;
  if (diff === 0) return { text: `Same as ${compareName(r)}`, trend: null };
  const up = diff > 0;
  let amount;
  if (kind === 'time') amount = duration(Math.abs(diff));
  else amount = String(Math.abs(diff));
  const pct = prev ? ` (${up ? '+' : '−'}${Math.round(Math.abs(diff / prev) * 100)}%)` : '';
  return { text: `${up ? '+' : '−'}${amount}${pct} vs ${compareName(r)}`, trend: up ? 'up' : 'down' };
}

function kpi(label, value, { unit, delta, tone } = {}) {
  return h(`div.kpi${tone ? `.kpi--${tone}` : ''}`, {},
    h('span.kpi__label', {}, label),
    h('span.kpi__value', {}, value, unit ? h('small', {}, unit) : null),
    delta ? h('span.kpi__delta', { 'data-trend': delta.trend || null }, delta.text) : null);
}

function bestLabel(r) {
  if (!r.best) return '—';
  if (r.period === 'day') return `${String(new Date(r.best.start).getHours()).padStart(2, '0')}:00`;
  if (r.period === 'week') return weekday(r.best.start);
  if (r.period === 'month') return dateShort(r.best.start);
  return monthName(r.best.start, 'short');
}

function renderKpis(r) {
  const s = r.summary;
  const focus = durationParts(s.focusSeconds);
  const items = [
    kpi('Pomodoros', String(s.pomodoros), { tone: 'primary', delta: deltaText(s.pomodoros, r.comparison.pomodoros, r, 'count') }),
    kpi(r.period === 'day' ? 'Focus time' : 'Focused', focus.value, { unit: focus.unit, delta: deltaText(s.focusSeconds, r.comparison.focusSeconds, r, 'time') }),
  ];

  if (r.period === 'day') {
    items.push(kpi('Sessions', String(s.completedSessions), {
      unit: 'completed',
      delta: { text: `${s.interruptedSessions} interrupted, ${s.abandonedSessions} skipped`, trend: null },
    }));
    items.push(kpi('Tasks completed', String(s.tasksCompleted)));
    items.push(kpi('Daily goal', `${s.pomodoros}/${r.goal.dailyGoal}`, {
      tone: 'secondary',
      delta: { text: s.pomodoros >= r.goal.dailyGoal ? 'Goal reached' : `${r.goal.dailyGoal - s.pomodoros} to go`, trend: s.pomodoros >= r.goal.dailyGoal ? 'up' : null },
    }));
  } else {
    const avg = durationParts(r.average.focusSeconds);
    items.push(kpi(`Average per ${r.average.unit}`, avg.value, {
      unit: avg.unit,
      delta: { text: `${r.average.pomodoros.toFixed(1)} Pomodoros, over ${plural(r.average.divisor, r.average.unit)}`, trend: null },
    }));
    const bestTitle = r.period === 'year' ? 'Most productive month' : r.period === 'week' ? 'Most productive day' : 'Best day';
    items.push(kpi(bestTitle, bestLabel(r), {
      tone: 'secondary',
      delta: r.best ? { text: `${duration(r.best.focusSeconds)}, ${plural(r.best.pomodoros, 'Pomodoro')}`, trend: null } : null,
    }));
    items.push(kpi('Sessions', String(s.completedSessions), {
      unit: 'completed',
      delta: { text: `${s.interruptedSessions} interrupted, ${s.abandonedSessions} skipped`, trend: null },
    }));
    items.push(kpi(r.period === 'year' ? 'Tasks completed' : 'Days at goal', r.period === 'year' ? String(s.tasksCompleted) : `${r.goal.daysGoalMet}`, {
      unit: r.period === 'year' ? null : `/ ${r.goal.daysCounted}`,
      delta: r.period === 'year' ? null : { text: `Goal: ${r.goal.dailyGoal} a day, ${plural(s.tasksCompleted, 'task')} done`, trend: null },
    }));
  }
  $('#dash-kpis').replaceChildren(...items);
}

/** Values for buckets that haven't happened yet are null so lines stop at "now". */
function seriesValues(r, buckets, pick, now) {
  return buckets.map((b) => (b.start > now ? null : pick(b)));
}

function renderCharts(r) {
  const now = Date.now();
  const labels = r.buckets.map((b) => bucketLabel(r.unit, r.period, b.start));
  const maxFocus = Math.max(0, ...r.buckets.map((b) => b.focusSeconds), ...r.prevBuckets.map((b) => b.focusSeconds));
  const inHours = maxFocus >= 2 * 3600;
  const toUnit = (sec) => (inHours ? +(sec / 3600).toFixed(2) : +(sec / 60).toFixed(1));
  const unitLabel = inHours ? 'Hours' : 'Minutes';

  const focusSecs = seriesValues(r, r.buckets, (b) => b.focusSeconds, now);
  renderLineChart('chart-focus', {
    labels,
    series: [{ label: 'Focus time', data: focusSecs.map((v) => (v === null ? null : toUnit(v))), color: 'var(--focus)' }],
    options: {
      yTitle: unitLabel,
      tooltipFormat: (ctx) => ` ${duration(focusSecs[ctx.dataIndex] ?? 0)} focused`,
    },
  });
  $('#chart-focus-sub').textContent = `${duration(r.summary.focusSeconds)} in total`;

  const pomos = seriesValues(r, r.buckets, (b) => b.pomodoros, now);
  renderLineChart('chart-pomodoros', {
    labels,
    series: [{ label: 'Pomodoros', data: pomos, color: 'var(--long)' }],
    options: {
      yTitle: 'Pomodoros',
      integer: true,
      tooltipFormat: (ctx) => ` ${plural(ctx.parsed.y, 'Pomodoro')}`,
    },
  });
  $('#chart-pomo-sub').textContent = plural(r.summary.pomodoros, 'Pomodoro');

  // Comparison: aligned by position in the period (hour, weekday, day of month, month).
  const len = Math.max(r.buckets.length, r.prevBuckets.length);
  const cmpLabels = [];
  for (let i = 0; i < len; i += 1) {
    if (r.unit === 'hour') cmpLabels.push(`${String(i).padStart(2, '0')}:00`);
    else if (r.unit === 'month') cmpLabels.push(monthName(new Date(2000, i, 1).getTime()));
    else if (r.period === 'week') cmpLabels.push(weekday(r.buckets[i].start));
    else cmpLabels.push(String(i + 1));
  }
  const metric = state.compare;
  const pick = metric === 'focus' ? (b) => b.focusSeconds : (b) => b.pomodoros;
  const curRaw = Array.from({ length: len }, (_, i) => (r.buckets[i] && r.buckets[i].start <= now ? pick(r.buckets[i]) : null));
  const prevRaw = Array.from({ length: len }, (_, i) => (r.prevBuckets[i] ? pick(r.prevBuckets[i]) : null));
  const conv = metric === 'focus' ? (v) => (v === null ? null : toUnit(v)) : (v) => v;
  const fmt = metric === 'focus' ? (v) => duration(v ?? 0) : (v) => plural(v ?? 0, 'Pomodoro');
  const curName = r.isCurrent ? (r.period === 'day' ? 'Today' : `This ${UNIT_NAME[r.period]}`) : `Selected ${UNIT_NAME[r.period]}`;
  const prevLabel = prevName(r);
  renderLineChart('chart-compare', {
    labels: cmpLabels,
    legend: true,
    series: [
      { label: curName, data: curRaw.map(conv), color: 'var(--focus)', fill: false },
      { label: prevLabel.charAt(0).toUpperCase() + prevLabel.slice(1), data: prevRaw.map(conv), color: 'var(--long)', dashed: true, fill: false },
    ],
    options: {
      yTitle: metric === 'focus' ? unitLabel : 'Pomodoros',
      integer: metric !== 'focus',
      tooltipFormat: (ctx) => {
        const raw = ctx.datasetIndex === 0 ? curRaw[ctx.dataIndex] : prevRaw[ctx.dataIndex];
        return ` ${ctx.dataset.label}: ${fmt(raw)}`;
      },
    },
  });
  $('#chart-compare-note').hidden = r.previous.hasData;
}

function render() {
  const r = state.report;
  if (!r) return;
  $('#dash-range').textContent = periodLabel(r.period, r.range, r.isCurrent);
  $('#dash-range').title = r.period === 'day' ? dateLong(r.range.start) : '';
  $('#dash-next').disabled = r.isCurrent || r.isFuture;
  $('#dash-today').disabled = r.isCurrent;
  const first = r.firstSessionAt ? Date.parse(r.firstSessionAt) : null;
  $('#dash-prev').disabled = !first || r.range.start <= first;

  const empty = !r.summary.hasData;
  $('#dash-empty').hidden = !empty;
  $('#dash-body').hidden = empty;
  if (empty) {
    const unit = UNIT_NAME[r.period];
    $('#dash-empty-title').textContent = r.isCurrent
      ? (r.period === 'day' ? 'No sessions yet today' : `No sessions yet this ${unit}`)
      : `No sessions in this ${unit}`;
    $('#dash-empty-text').textContent = first
      ? 'Statistics appear here as soon as you finish or stop a session. Use the arrows to look at other periods.'
      : 'Your statistics are built from real sessions only. Finish your first focus session and it will show up here.';
    return;
  }
  renderKpis(r);
  renderCharts(r);
}

async function load() {
  const ticket = ++state.loading;
  try {
    const r = await api.stats.report(state.period, state.anchor);
    if (ticket !== state.loading) return; // a newer request is in flight
    state.report = r;
    render();
  } catch (err) {
    toastError(err);
  }
}

export function initDashboard() {
  const periods = radioGroup($('.page--dashboard .segmented'), 'period', (p) => {
    state.period = p;
    periods.set(p);
    load();
  });
  const compare = radioGroup($('.mini-toggle'), 'compare', (m) => {
    state.compare = m;
    compare.set(m);
    render();
  });
  periods.set(state.period);
  compare.set(state.compare);

  $('#dash-prev').addEventListener('click', () => { state.anchor = shift(state.period, state.anchor, -1); load(); });
  $('#dash-next').addEventListener('click', () => { state.anchor = shift(state.period, state.anchor, 1); load(); });
  $('#dash-today').addEventListener('click', () => { state.anchor = Date.now(); load(); });

  registerPage('dashboard', { onShow: load });
  api.data.onChanged(() => { if (currentPage() === 'dashboard') load(); });
  store.on('settings', () => { if (currentPage() === 'dashboard') load(); });
}
