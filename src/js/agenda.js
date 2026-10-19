// Agenda: the digital version of the paper planner. One calendar week per
// "page" like a printed agenda, starting on the day chosen in Settings
// ("Weeks start on": Monday → Monday–Sunday, Sunday → Sunday–Saturday). It
// opens on the week holding today, which carries the neon accent; each day lists the tasks dated for it (the same task rows
// as the Tasks section), a free-text note, and a box on the far right with
// TTP (Total Pomodoro) and H.E. (Hours English) calculated from sessions.

import { api, store } from './store.js';
import { $, h, icon, ICONS, toast, toastError, confirmAction } from './ui.js';
import { isoDate, dateKeyToMs, hoursMinutes, dayOfYear, plural } from './format.js';
import { registerPage, currentPage } from './navigation.js';
import { tagChips, loadTags } from './tags.js';
import { openEditor } from './tasks.js';

const LOCALE = 'en-GB';

const state = {
  weekStart: null,     // 'YYYY-MM-DD' of the first day shown (the page covers it and the next six days)
  weekStartDay: null,  // Settings "Weeks start on" the page was built with (0 = Sunday, 1 = Monday)
  followToday: true,   // page shows the current week (moves on when a new week starts)
  scrollToToday: false, // bring today's row into view after the next render
  calMonth: null,      // ms inside the month shown in the mini calendar
  years: [],
  yearNotes: {},       // year -> note written on 1 January
  expandedNotes: new Set(), // years whose note is shown in full (display only)
  data: null,
  editingNote: null,   // date whose note editor is open
  addingFor: null,     // date whose "add task" field is open
  drafts: {},          // unsaved text keyed by focus key
  loading: 0,
};

function addDays(key, n) {
  const d = new Date(dateKeyToMs(key));
  d.setDate(d.getDate() + n);
  return isoDate(d.getTime());
}

const todayKey = () => isoDate(Date.now());

/** "Weeks start on" from Settings, the single source of truth (0 = Sunday … 6 = Saturday). */
function firstDayOfWeek() {
  const v = Number(store.settings?.weekStart);
  return Number.isInteger(v) && v >= 0 && v <= 6 ? v : 1;
}

/** First day of the calendar week that contains `key`, per Settings. */
function weekOf(key, ws = firstDayOfWeek()) {
  const dow = new Date(dateKeyToMs(key)).getDay(); // 0 = Sunday
  return addDays(key, -((dow - ws + 7) % 7));
}

/** The last day on the current page (six days after the first). */
function pageEnd() {
  return addDays(state.weekStart, 6);
}

const showsToday = () => { const t = todayKey(); return t >= state.weekStart && t <= pageEnd(); };

/** Week number of the week starting on `first`. Monday weeks follow ISO 8601
    (week 1 holds the first Thursday); other start days count the week that
    holds 1 January as week 1 (the usual Sunday-first convention). */
function weekNumber(first) {
  const day = 86400000;
  if (firstDayOfWeek() === 1) {
    const thu = new Date(dateKeyToMs(addDays(first, 3)));
    const jan1 = new Date(thu.getFullYear(), 0, 1);
    return Math.floor(Math.round((thu - jan1) / day) / 7) + 1;
  }
  const last = new Date(dateKeyToMs(addDays(first, 6)));
  const week1 = weekOf(isoDate(new Date(last.getFullYear(), 0, 1).getTime()));
  return Math.round((dateKeyToMs(first) - dateKeyToMs(week1)) / day / 7) + 1;
}

/** The year of the planner this page belongs to: the year of its first day
    (so the week holding 31 December stays in that year's planner). */
function pageYear() {
  return new Date(dateKeyToMs(state.weekStart)).getFullYear();
}

function rangeLabel(from, to) {
  const a = new Date(dateKeyToMs(from));
  const b = new Date(dateKeyToMs(to));
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const left = sameMonth ? a.getDate() : a.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  return `${left}–${b.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ------------------------------------------------------------------ rendering

function taskLine(t) {
  const done = t.status === 'completed';
  return h('li.ag-task', { dataset: { status: t.status, id: String(t.id) } },
    h('button.ag-task__check', {
      type: 'button', role: 'checkbox', 'aria-checked': String(done),
      'aria-label': `${t.title}: mark as ${done ? 'not done' : 'done'}`,
      'data-focus-key': `check-${t.id}`,
      onclick: () => toggleTask(t),
    }, icon(ICONS.check)),
    h('button.ag-task__title', {
      type: 'button', title: 'Edit task', 'data-focus-key': `edit-${t.id}`, onclick: () => openEditor(t),
    }, t.title),
    tagChips(t.tags, { small: true }),
    h('span.ag-task__meta', {},
      t.steps_total ? h('span', { title: 'Steps done' }, `${t.steps_done}/${t.steps_total} steps`) : null,
      t.completed_pomodoros ? h('span', { title: `${plural(t.completed_pomodoros, 'Pomodoro')} on this task in total` }, `${t.completed_pomodoros}P`) : null));
}

function noteBlock(day) {
  const editing = state.editingNote === day.date;
  if (editing) {
    const key = `note-${day.date}`;
    const area = h('textarea.ag-note__input', {
      rows: '3', maxlength: '2000', 'aria-label': `Note for ${day.date}`, 'data-focus-key': key,
      placeholder: "A note about the day, e.g. New Year's Eve with my daughter.",
      oninput: (e) => { state.drafts[key] = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(day.date, e.target.value); }
        if (e.key === 'Escape') { e.preventDefault(); closeNote(day.date); }
      },
    });
    area.value = state.drafts[key] ?? (day.note ? day.note.body : '');
    return h('div.ag-note.ag-note--editing', {},
      area,
      h('div.ag-note__actions', {},
        h('button.btn.btn--small.btn--accent', { type: 'button', onclick: () => saveNote(day.date, area.value) }, 'Save note'),
        h('button.btn.btn--small.btn--ghost', { type: 'button', onclick: () => closeNote(day.date) }, 'Cancel'),
        day.note ? h('button.btn.btn--small.btn--ghost.ag-note__del', { type: 'button', onclick: () => deleteNote(day.date) }, 'Delete note') : null,
        h('span.ag-note__hint', {}, 'Ctrl+Enter to save')));
  }
  if (day.note) {
    return h('div.ag-note', {},
      h('button.ag-note__text', {
        type: 'button', title: 'Edit note', 'data-focus-key': `note-open-${day.date}`,
        onclick: () => openNote(day.date),
      }, day.note.body));
  }
  return null;
}

function addControls(day) {
  const adding = state.addingFor === day.date;
  if (adding) {
    const key = `add-${day.date}`;
    const input = h('input.ag-add__input', {
      type: 'text', maxlength: '200', placeholder: 'New task for this day', 'aria-label': `New task for ${day.date}`,
      'data-focus-key': key,
      oninput: (e) => { state.drafts[key] = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTask(day.date, e.target); }
        if (e.key === 'Escape') { e.preventDefault(); state.addingFor = null; delete state.drafts[key]; render(); }
      },
    });
    input.value = state.drafts[key] || '';
    return h('div.ag-add', {}, h('span.ag-add__plus', { 'aria-hidden': 'true' }, '+'), input);
  }
  return h('div.ag-day__tools', {},
    h('button.ag-tool', { type: 'button', 'data-focus-key': `add-btn-${day.date}`, onclick: () => { state.addingFor = day.date; render(`add-${day.date}`); } },
      h('span', { 'aria-hidden': 'true' }, '+'), 'Task'),
    day.note || state.editingNote === day.date ? null
      : h('button.ag-tool.ag-tool--note', { type: 'button', 'data-focus-key': `note-btn-${day.date}`, onclick: () => openNote(day.date) },
        h('span', { 'aria-hidden': 'true' }, '+'), 'Note'));
}

function dayRow(day, hoursLabel) {
  const ms = dateKeyToMs(day.date);
  const d = new Date(ms);
  const today = day.date === isoDate(Date.now());
  const doy = dayOfYear(ms);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const full = d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return h('li.ag-day', { dataset: { date: day.date, today: String(today), weekend: String(weekend) }, 'aria-label': full },
    h('div.ag-day__date', {},
      h('span.ag-day__num', {}, String(d.getDate())),
      h('span.ag-day__wd', {}, d.toLocaleDateString(LOCALE, { weekday: 'long' })),
      h('span.ag-day__month', {}, d.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })),
      h('span.ag-day__doy', { title: `Day ${doy.n} of the year, ${doy.left} left` }, `${doy.n}/${doy.left}`),
      today ? h('span.ag-day__today', {}, 'Today') : null),
    h('div.ag-day__body', {},
      day.tasks.length
        ? h('ul.ag-tasks', { 'aria-label': `Tasks on ${full}` }, day.tasks.map(taskLine))
        : null,
      noteBlock(day),
      addControls(day)),
    h('dl.ag-day__stats', { 'aria-label': `Productivity on ${full}` },
      h('div', {}, h('dt', { title: 'Total Pomodoro' }, 'TTP'), h('dd', {}, String(day.ttp))),
      h('div', {}, h('dt', { title: `Hours ${hoursLabel}` }, 'H.E.'), h('dd', {}, hoursMinutes(day.hoursSeconds)))));
}

function renderYears() {
  const current = pageYear();
  $('#ag-planner-name').textContent = String(current);
  // Newest planner first; each shows the note written on 1 January of its year.
  const years = [...state.years].sort((a, b) => b - a);
  $('#ag-years').replaceChildren(...years.map((y) => {
    const quote = state.yearNotes[y];
    const expanded = Boolean(quote) && state.expandedNotes.has(y);
    const isCurrent = y === current;
    // Every card reserves three lines for the note, so collapsed cards are
    // all the same height. Expanding only changes the display, never the note.
    return h('li', {},
      h('div.planner.planner--card', {
        'aria-current': isCurrent ? 'true' : null,
        'data-expanded': String(expanded),
        // Another year's card: open that planner with its note expanded.
        // The open planner's card: click to expand or collapse its note.
        onclick: (e) => {
          if (isCurrent && e.target.closest('button.planner__note')) return;
          if (!isCurrent) {
            if (quote) state.expandedNotes.add(y);
            openYear(y);
          } else if (quote) {
            toggleNote(y);
          }
        },
      },
      h('button.planner__open', {
        type: 'button',
        'aria-label': isCurrent ? `${y} planner (open)` : `Open the ${y} planner`,
      }, h('span.planner__year', {}, String(y)), h('span.planner__label', {}, 'Planner')),
      quote
        ? h('button.planner__note', {
          type: 'button',
          'aria-expanded': String(expanded),
          'aria-label': `Note from 1 January ${y}: ${quote}. ${expanded ? 'Show less' : 'Show the whole note'}`,
          onclick: (e) => { if (isCurrent) { e.stopPropagation(); toggleNote(y); } },
        }, quote)
        : h('span.planner__note.planner__note--empty', { 'aria-hidden': 'true' }),
      quote ? h('span.planner__chevron', { 'aria-hidden': 'true' }) : null));
  }));
  markTruncatedNotes();
}

function toggleNote(year) {
  if (state.expandedNotes.has(year)) state.expandedNotes.delete(year);
  else state.expandedNotes.add(year);
  renderYears();
}

/** Marks notes that don't fit in three lines, so they show a "more" chevron. */
function markTruncatedNotes() {
  requestAnimationFrame(() => {
    for (const card of document.querySelectorAll('#ag-years .planner--card')) {
      const note = card.querySelector('button.planner__note');
      if (!note) continue;
      const expanded = card.dataset.expanded === 'true';
      const overflow = note.scrollHeight > note.clientHeight + 1;
      card.dataset.truncated = String(expanded || overflow);
      if (!expanded && !overflow) note.removeAttribute('aria-expanded');
    }
  });
}

function renderCalendar() {
  const base = new Date(state.calMonth);
  const year = base.getFullYear();
  const month = base.getMonth();
  $('#ag-cal-title').textContent = base.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
  const ws = firstDayOfWeek();
  const names = [];
  for (let i = 0; i < 7; i += 1) {
    names.push(new Date(2026, 0, 4 + ((ws + i) % 7)).toLocaleDateString(LOCALE, { weekday: 'narrow' }));
  }
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - ws + 7) % 7;
  const daysIn = new Date(year, month + 1, 0).getDate();
  const weekEnd = pageEnd();
  const todayKey = isoDate(Date.now());
  const cells = names.map((n) => h('span.minical__dow', { 'aria-hidden': 'true' }, n));
  for (let i = 0; i < lead; i += 1) cells.push(h('span.minical__blank'));
  for (let dnum = 1; dnum <= daysIn; dnum += 1) {
    const key = isoDate(new Date(year, month, dnum).getTime());
    cells.push(h('button.minical__day', {
      type: 'button',
      'data-in-week': String(key >= state.weekStart && key <= weekEnd),
      'data-today': String(key === todayKey),
      'aria-label': new Date(year, month, dnum).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }),
      onclick: () => goTo(weekOf(key)),
    }, String(dnum)));
  }
  $('#ag-cal').replaceChildren(...cells);
}

async function renderSide() {
  const r = state.data;
  const label = r.hoursTag ? r.hoursTag.name : 'English';
  $('#ag-week-title').textContent = showsToday() ? `This week · W${weekNumber(state.weekStart)}` : `Week ${weekNumber(state.weekStart)}`;
  $('#ag-week-ttp').textContent = `${r.week.ttp}P`;
  $('#ag-week-he').textContent = hoursMinutes(r.week.hoursSeconds);
  $('#ag-week-he-label').title = `Hours ${label}`;
  $('#ag-week-meta').textContent = r.week.tasks ? `${r.week.tasksDone} of ${plural(r.week.tasks, 'task')} done` : 'No tasks this week';
  renderYears();
  renderCalendar();

  // Year totals come from the same session records as Activity Statistics.
  const y = pageYear();
  const nowYear = new Date().getFullYear();
  $('#ag-year-title').textContent = y === nowYear ? `${y} so far` : `${y} in total`;
  try {
    const stats = await api.activity.stats({ from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() });
    $('#ag-year-ttp').textContent = `${stats.total.sessions}P`;
    const tag = r.hoursTag ? stats.tags.find((t) => t.id === r.hoursTag.id) : null;
    $('#ag-year-he').textContent = hoursMinutes(tag ? tag.seconds : 0);
  } catch (_) { /* side box only */ }

  // H.E. tag choice
  const sel = $('#ag-hours-tag');
  const tags = await loadTags();
  const chosen = store.settings ? store.settings.hoursTagId : null;
  sel.replaceChildren(h('option', { value: '' }, 'The tag named "English"'),
    ...tags.map((t) => h('option', { value: String(t.id) }, t.name)));
  sel.value = chosen && tags.some((t) => t.id === chosen) ? String(chosen) : '';
}

function render(focusKey = null) {
  const r = state.data;
  if (!r) return;
  const list = $('#ag-days');
  const active = document.activeElement;
  const key = focusKey || (active && list.contains(active) ? active.dataset.focusKey : null);
  const caret = active && list.contains(active) && 'selectionStart' in active ? active.selectionStart : null;

  const label = r.hoursTag ? r.hoursTag.name : 'English';
  // The seven days in calendar order from the configured first day, like a printed weekly agenda.
  list.replaceChildren(...r.days.map((d) => dayRow(d, label)));
  $('#ag-range').textContent = rangeLabel(r.from, r.to);

  if (state.scrollToToday && !key) {
    state.scrollToToday = false;
    const row = list.querySelector('.ag-day[data-today="true"]');
    // Only scrolls when today is actually out of sight (late in the week on a small window).
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  if (key) {
    const el = list.querySelector(`[data-focus-key="${key}"]`);
    if (el) {
      el.focus();
      if (caret !== null && 'setSelectionRange' in el) { try { el.setSelectionRange(caret, caret); } catch (_) { /* n/a */ } }
    }
  }
}

async function load() {
  const ticket = ++state.loading;
  try {
    const [data, years, yearNotes] = await Promise.all([
      api.agenda.days(state.weekStart, 7), api.agenda.years(), api.agenda.yearNotes(),
    ]);
    if (ticket !== state.loading) return;
    state.data = data;
    state.years = years;
    state.yearNotes = yearNotes || {};
    render();
    renderSide();
  } catch (err) { toastError(err); }
}

function goTo(weekStart) {
  state.weekStartDay = firstDayOfWeek();
  state.weekStart = weekOf(weekStart);
  state.followToday = showsToday();
  state.scrollToToday = state.followToday;
  state.calMonth = dateKeyToMs(state.followToday ? todayKey() : state.weekStart);
  state.addingFor = null;
  state.editingNote = null;
  state.drafts = {};
  load();
}

function openYear(year) {
  const now = new Date();
  // Current year: this week. Other years: the last week of that planner
  // (the calendar week holding 31 December).
  if (year === now.getFullYear()) goTo(weekOf(todayKey()));
  else goTo(weekOf(`${year}-12-31`));
}

// ------------------------------------------------------------------ actions

async function toggleTask(t) {
  const next = t.status === 'completed' ? 'active' : 'completed';
  try {
    await api.tasks.setStatus(t.id, next);
    toast(next === 'completed' ? `Marked "${t.title}" as done.` : `"${t.title}" is active again.`);
    // data:changed reloads the week
  } catch (err) { toastError(err); }
}

async function addTask(date, input) {
  const title = input.value.trim();
  if (!title || input.dataset.busy) return;
  input.dataset.busy = '1';
  try {
    await api.tasks.create({ title, scheduledDate: date });
    delete state.drafts[`add-${date}`];
    input.value = '';
    toast(`Task added to ${new Date(dateKeyToMs(date)).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}.`);
    await load();
    render(`add-${date}`);
  } catch (err) { toastError(err); } finally { delete input.dataset.busy; }
}

function openNote(date) {
  state.editingNote = date;
  render(`note-${date}`);
}

function closeNote(date) {
  state.editingNote = null;
  delete state.drafts[`note-${date}`];
  render(`note-open-${date}`);
}

async function saveNote(date, body) {
  try {
    const n = await api.agenda.saveNote(date, body);
    state.editingNote = null;
    delete state.drafts[`note-${date}`];
    toast(n ? 'Note saved.' : 'Empty note removed.');
    await load();
  } catch (err) { toastError(err); }
}

async function deleteNote(date) {
  const ok = await confirmAction({ title: 'Delete this note?', text: 'The note for this day will be removed. Tasks are not affected.', ok: 'Delete note' });
  if (!ok) return;
  try {
    await api.agenda.deleteNote(date);
    state.editingNote = null;
    delete state.drafts[`note-${date}`];
    toast('Note deleted.');
    await load();
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ init

export function initAgenda() {
  state.weekStartDay = firstDayOfWeek();
  state.weekStart = weekOf(todayKey());
  state.scrollToToday = true;
  state.calMonth = Date.now();

  $('#ag-prev').addEventListener('click', () => goTo(addDays(state.weekStart, -7)));
  $('#ag-next').addEventListener('click', () => goTo(addDays(state.weekStart, 7)));
  $('#ag-today').addEventListener('click', () => goTo(weekOf(todayKey())));
  $('#ag-cal-prev').addEventListener('click', () => {
    const d = new Date(state.calMonth); d.setDate(1); d.setMonth(d.getMonth() - 1); state.calMonth = d.getTime(); renderCalendar();
  });
  $('#ag-cal-next').addEventListener('click', () => {
    const d = new Date(state.calMonth); d.setDate(1); d.setMonth(d.getMonth() + 1); state.calMonth = d.getTime(); renderCalendar();
  });
  $('#ag-hours-tag').addEventListener('change', async (e) => {
    try {
      await api.settings.update({ hoursTagId: e.target.value ? Number(e.target.value) : null });
      toast('H.E. now counts the selected tag.');
      load();
    } catch (err) { toastError(err); }
  });

  registerPage('agenda', {
    onShow: () => {
      // Opening the Agenda always lands on the current calendar week (also
      // after Sunday midnight, when a new week begins).
      if (!showsToday()) goTo(weekOf(todayKey()));
      else { if (state.followToday) state.scrollToToday = true; load(); }
    },
  });
  api.data.onChanged(() => { if (currentPage() === 'agenda') load(); });
  store.on('settings', () => {
    // "Weeks start on" changed in Settings: rebuild the page around the same
    // week (the one holding today, or the first day that was on screen).
    if (firstDayOfWeek() !== state.weekStartDay) {
      const anchor = showsToday() ? todayKey() : state.weekStart;
      state.weekStartDay = firstDayOfWeek();
      state.weekStart = weekOf(anchor);
      state.followToday = showsToday();
      state.addingFor = null;
      state.editingNote = null;
      if (state.data) load();   // reloads the days, the week box (TTP / H.E.) and the calendar
      return;
    }
    if (state.data && currentPage() === 'agenda') renderCalendar();
  });
}
