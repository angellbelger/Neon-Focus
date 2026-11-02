// Dashboard: day / week / month / year statistics computed in the main
// process from stored sessions plus legacy data (weekly totals from paper
// planners, counted in week, month and year reports).

import { api, store } from './store.js';
import { $, h, radioGroup, toastError } from './ui.js';
import { duration, durationParts, periodLabel, bucketLabel, dateShort, dateLong, monthName, weekday, plural } from './format.js';
import { renderLineChart } from './charts.js';
import { registerPage, currentPage } from './navigation.js';
import { initActivity, activityVisible, refreshActivity } from './activity.js';
import { loadTags } from './tags.js';

// tagIds: [] = All tags (the general statistics); otherwise only sessions with one of these tags.
const state = { period: 'day', anchor: Date.now(), compare: 'focus', report: null, loading: 0, tagIds: [], tags: [] };

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

function kpi(label, value, { unit, delta, tone, legacy } = {}) {
  return h(`div.kpi${tone ? `.kpi--${tone}` : ''}`, {},
    h('span.kpi__label', {}, label, legacy ? h('span.legacy-mark', { title: legacy }, 'Legacy') : null),
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
    kpi('Pomodoros', String(s.pomodoros), {
      tone: 'primary',
      delta: deltaText(s.pomodoros, r.comparison.pomodoros, r, 'count'),
      legacy: s.legacyPomodoros ? `Includes ${plural(s.legacyPomodoros, 'Pomodoro')} from legacy records` : null,
    }),
    kpi(r.period === 'day' ? 'Focus time' : 'Focused', focus.value, {
      unit: focus.unit,
      delta: deltaText(s.focusSeconds, r.comparison.focusSeconds, r, 'time'),
      legacy: s.legacySeconds ? `Includes ${duration(s.legacySeconds)} of tag hours from legacy records` : null,
    }),
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
      tooltipFormat: (ctx) => {
        const b = r.buckets[ctx.dataIndex];
        return ` ${duration(focusSecs[ctx.dataIndex] ?? 0)} focused${b && b.legacySeconds ? ` (${duration(b.legacySeconds)} from legacy records)` : ''}`;
      },
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
      tooltipFormat: (ctx) => {
        const b = r.buckets[ctx.dataIndex];
        return ` ${plural(ctx.parsed.y, 'Pomodoro')}${b && b.legacyPomodoros ? ` (${b.legacyPomodoros} from legacy records)` : ''}`;
      },
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

/** Year picker: every year with sessions or legacy data (newest first). */
function renderYears(r) {
  const sel = $('#dash-year');
  const years = (r.years || []).slice().reverse();
  const shown = new Date(r.range.start + (r.range.end - r.range.start) / 2).getFullYear();
  if (!years.includes(shown)) years.push(shown);
  years.sort((a, b) => b - a);
  sel.replaceChildren(...years.map((y) => h('option', { value: String(y) }, String(y))));
  sel.value = String(shown);
}

/** The same date (and so the same day, week or month) in another year. */
function anchorInYear(year) {
  const now = new Date();
  if (year === now.getFullYear()) return now.getTime();
  const a = new Date(state.anchor);
  const day = Math.min(a.getDate(), new Date(year, a.getMonth() + 1, 0).getDate());
  return new Date(year, a.getMonth(), day, 12).getTime();
}

/** Line under the cards when legacy data is part of this report (or why it is not, in a day). */
function renderLegacyNote(r) {
  const el = $('#dash-legacy');
  const s = r.summary;
  if (!s.legacyPomodoros && !s.legacySeconds) { el.hidden = true; return; }
  const parts = [];
  if (s.legacyPomodoros) parts.push(plural(s.legacyPomodoros, 'Pomodoro'));
  if (s.legacySeconds) parts.push(`${duration(s.legacySeconds)} of tag hours`);
  const where = r.unit === 'month' ? 'in the month of each week' : 'in the totals (they are weekly, so they are not split by day)';
  el.replaceChildren(h('span.legacy-mark', {}, 'Legacy'), `Includes ${parts.join(' and ')} entered as weekly totals, shown ${where}.`);
  el.hidden = false;
}

// ------------------------------------------------------------------ tag filter

function filterNames() {
  const byId = new Map(state.tags.map((t) => [t.id, t]));
  return state.tagIds.map((id) => byId.get(id)).filter(Boolean);
}

function renderTagButton() {
  const sel = filterNames();
  const btn = $('#dash-tags-btn');
  btn.dataset.active = String(sel.length > 0);
  $('#dash-tags-label').textContent = !sel.length ? 'All tags'
    : sel.length <= 2 ? sel.map((t) => t.name).join(' + ') : `${sel[0].name} +${sel.length - 1}`;
  $('#dash-tags-dots').replaceChildren(...sel.slice(0, 3).map((t) => h(`span.tag-filter__dot.tag--${t.color}`)));
  btn.setAttribute('aria-label', sel.length ? `Tag filter: ${sel.map((t) => t.name).join(', ')}` : 'Tag filter: all tags');
}

function renderTagMenu() {
  const menu = $('#dash-tags-menu');
  const chosen = new Set(state.tagIds);
  menu.replaceChildren(
    h('label.tag-filter__option.tag-filter__option--all', {},
      h('input', { type: 'checkbox', checked: chosen.size === 0, 'data-tag-id': 'all', onchange: () => setTagFilter([]) }),
      h('span', {}, 'All tags'),
      h('small', {}, 'general statistics')),
    state.tags.length
      ? h('div.tag-filter__list', {}, state.tags.map((t) => h('label.tag-filter__option', {},
        h('input', {
          type: 'checkbox', checked: chosen.has(t.id), 'data-tag-id': String(t.id),
          onchange: (e) => setTagFilter(e.target.checked ? [...state.tagIds, t.id] : state.tagIds.filter((id) => id !== t.id)),
        }),
        h(`span.tag.tag--${t.color}`, {}, t.name))))
      : h('p.tag-filter__empty', {}, 'No tags yet. Create them in Tasks → Manage tags.'),
    h('p.tag-filter__hint', {}, 'Tick several tags to see them combined. A Pomodoro with two of them counts once.'));
}

function setTagFilter(ids) {
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.tagId : null;
  state.tagIds = [...new Set(ids)];
  renderTagButton();
  renderTagMenu();
  // keep the keyboard on the option just changed (the list was rebuilt)
  if (focused) $(`#dash-tags-menu input[data-tag-id="${focused}"]`)?.focus();
  load();
}

function openTagMenu(open) {
  const menu = $('#dash-tags-menu');
  const willOpen = open ?? menu.hidden;
  menu.hidden = !willOpen;
  $('#dash-tags-btn').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    renderTagMenu();
    loadTags(true).then((tags) => { state.tags = tags; renderTagMenu(); renderTagButton(); }).catch(() => {});
    menu.querySelector('input')?.focus();
  }
}

async function refreshTags() {
  try { state.tags = await loadTags(true); } catch (_) { return; }
  // a deleted tag simply leaves the selection
  const known = new Set(state.tags.map((t) => t.id));
  const kept = state.tagIds.filter((id) => known.has(id));
  if (kept.length !== state.tagIds.length) { state.tagIds = kept; load(); }
  renderTagButton();
  if (!$('#dash-tags-menu').hidden) renderTagMenu();
}

/** "Showing Pomodoros tagged …" line, and what a tag view leaves out. */
function renderFilterNote(r) {
  const el = $('#dash-filter-note');
  if (!r.filter) { el.hidden = true; return; }
  const parts = [
    h('span.tag-filter__dots', { 'aria-hidden': 'true' }, r.filter.tags.slice(0, 3).map((t) => h(`span.tag-filter__dot.tag--${t.color}`))),
    `Showing only Pomodoros tagged ${r.filter.tags.map((t) => t.name).join(' or ')}.`,
  ];
  if (r.legacyUntagged) parts.push(` Weekly TTP from legacy records (${plural(r.legacyUntagged, 'Pomodoro')}) has no tag, so it is only in All tags.`);
  parts.push(h('button.btn.btn--small.btn--ghost', { type: 'button', onclick: () => setTagFilter([]) }, 'Show all tags'));
  el.replaceChildren(...parts);
  el.hidden = false;
}

function render() {
  const r = state.report;
  if (!r) return;
  $('#dash-range').textContent = periodLabel(r.period, r.range, r.isCurrent);
  $('#dash-range').title = r.period === 'day' ? dateLong(r.range.start) : '';
  $('#dash-next').disabled = r.isCurrent || r.isFuture;
  $('#dash-today').disabled = r.isCurrent;
  // Earliest data = first session or first legacy week, whichever is older.
  const first = r.firstRecordAt ? Date.parse(r.firstRecordAt) : (r.firstSessionAt ? Date.parse(r.firstSessionAt) : null);
  $('#dash-prev').disabled = !first || r.range.start <= first;
  renderYears(r);

  const empty = !r.summary.hasData;
  $('#dash-empty').hidden = !empty;
  $('#dash-body').hidden = empty;
  if (empty) {
    const unit = UNIT_NAME[r.period];
    const tagged = r.filter ? `${r.filter.tags.map((t) => t.name).join(' or ')} ` : '';
    $('#dash-empty-title').textContent = r.isCurrent
      ? (r.period === 'day' ? `No ${tagged}sessions yet today` : `No ${tagged}sessions yet this ${unit}`)
      : `No ${tagged}sessions in this ${unit}`;
    $('#dash-empty-text').textContent = first
      ? (r.period === 'day'
        ? 'Statistics appear here as soon as you finish or stop a session. Legacy data is weekly, so it shows in the Week, Month and Year views. Use the arrows or the year list to look at other periods.'
        : 'Statistics appear here as soon as you finish or stop a session. Use the arrows or the year list to look at other periods.')
      : 'Your statistics are built from real sessions and legacy data. Finish your first focus session and it will show up here.';
    return;
  }
  renderKpis(r);
  renderFilterNote(r);
  renderLegacyNote(r);
  renderCharts(r);
}

async function load() {
  const ticket = ++state.loading;
  try {
    const r = await api.stats.report(state.period, state.anchor, state.tagIds.length ? state.tagIds : null);
    if (ticket !== state.loading) return; // a newer request is in flight
    state.report = r;
    render();
  } catch (err) {
    toastError(err);
  }
}

export function initDashboard() {
  const periods = radioGroup($('.page--dashboard .segmented[aria-label="Period"]'), 'period', (p) => {
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
  $('#dash-year').addEventListener('change', (e) => { state.anchor = anchorInYear(Number(e.target.value)); load(); });

  // tag filter (default: All tags)
  $('#dash-tags-btn').addEventListener('click', () => openTagMenu());
  document.addEventListener('pointerdown', (e) => {
    if (!$('#dash-tags-menu').hidden && !$('#dash-tag-filter').contains(e.target)) openTagMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dash-tags-menu').hidden) { e.stopPropagation(); openTagMenu(false); $('#dash-tags-btn').focus(); }
  });
  renderTagButton();
  refreshTags();

  initActivity({ onOverview: load });
  registerPage('dashboard', { onShow: () => (activityVisible() ? refreshActivity() : load()) });
  api.data.onChanged(() => { refreshTags(); if (currentPage() === 'dashboard' && !activityVisible()) load(); });
  store.on('settings', () => { if (currentPage() === 'dashboard') load(); });
}
