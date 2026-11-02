// Reminders: one-time events (meetings, appointments, interviews, deadlines)
// and annual occasions (birthdays, anniversaries). Annual reminders are kept
// as day + month and also appear in the Agenda on their date every year.

import { api } from './store.js';
import { $, h, radioGroup, toast, toastError, confirmAction } from './ui.js';
import { dateKeyToMs } from './format.js';
import { registerPage, currentPage } from './navigation.js';

const LOCALE = 'en-GB';
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(LOCALE, { month: 'long' }));
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const state = { view: 'once', data: null, editing: null, kind: 'once' };

// ------------------------------------------------------------------ helpers

function relativeDay(dateKey, today) {
  const days = Math.round((dateKeyToMs(dateKey) - dateKeyToMs(today)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1) return `In ${days} days`;
  return `${-days} days ago`;
}

function linkHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (_) { return 'link'; }
}

function dateBlock(dateKey) {
  const d = new Date(dateKeyToMs(dateKey));
  return h('div.rem-date', { 'aria-hidden': 'true' },
    h('span.rem-date__day', {}, String(d.getDate())),
    h('span.rem-date__month', {}, d.toLocaleDateString(LOCALE, { month: 'short' })),
    h('span.rem-date__wd', {}, d.toLocaleDateString(LOCALE, { weekday: 'short' })));
}

function actions(r) {
  return h('div.rem-actions', {},
    h('button.icon-btn.icon-btn--small', { type: 'button', title: 'Edit', 'aria-label': `Edit "${r.title}"`, onclick: () => openEditor(r) },
      h('span', { 'aria-hidden': 'true' }, '✎')),
    h('button.icon-btn.icon-btn--small.rem-del', { type: 'button', title: 'Delete', 'aria-label': `Delete "${r.title}"`, onclick: () => remove(r) },
      h('span', { 'aria-hidden': 'true' }, '✕')));
}

// ------------------------------------------------------------------ one-time

const STATUS_LABEL = { upcoming: 'Upcoming', past: 'Past', completed: 'Completed' };

function onceItem(r, today) {
  const full = new Date(dateKeyToMs(r.date)).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const isToday = r.date === today && r.status === 'upcoming';
  return h('li.rem-item.rem-item--once', { dataset: { id: String(r.id), status: r.status, today: String(isToday) }, 'aria-label': `${r.title}, ${full}${r.time ? ` at ${r.time}` : ''}` },
    dateBlock(r.date),
    h('div.rem-body', {},
      h('p.rem-title', {},
        h('span', {}, r.title),
        h(`span.rem-status.rem-status--${isToday ? 'today' : r.status}`, {}, isToday ? 'Today' : STATUS_LABEL[r.status])),
      h('p.rem-meta', {},
        h('span.rem-time', {}, r.time || 'All day'),
        h('span', {}, `${full.replace(/ \d{4}$/, '')} · ${relativeDay(r.date, today)}`)),
      r.link ? h('button.rem-link', { type: 'button', title: r.link, onclick: () => api.reminders.openLink(r.id).catch(toastError) },
        h('span', { 'aria-hidden': 'true' }, '↗'), ` Open ${linkHost(r.link)}`) : null,
      r.notes ? h('p.rem-notes', {}, r.notes) : null),
    h('div.rem-side', {},
      h('label.rem-done', { title: r.done ? 'Mark as not done' : 'Mark as done' },
        h('input', { type: 'checkbox', checked: r.done, 'aria-label': `Done: ${r.title}`, onchange: (e) => setDone(r, e.target.checked) }),
        h('span', {}, 'Done')),
      actions(r)));
}

function renderOnce() {
  const { once, today } = state.data;
  const upcoming = once.filter((r) => r.status === 'upcoming');
  const past = once.filter((r) => r.status === 'past').reverse();       // most recent first
  const done = once.filter((r) => r.status === 'completed').reverse();
  $('#rem-upcoming').replaceChildren(...upcoming.map((r) => onceItem(r, today)));
  $('#rem-upcoming-empty').hidden = upcoming.length > 0;
  $('#rem-past').replaceChildren(...past.map((r) => onceItem(r, today)));
  $('#rem-past-group').hidden = past.length === 0;
  $('#rem-done').replaceChildren(...done.map((r) => onceItem(r, today)));
  $('#rem-done-group').hidden = done.length === 0;
  $('#rem-count-once').textContent = upcoming.length ? String(upcoming.length) : '';
}

// ------------------------------------------------------------------ annual

function annualWhen(r) {
  if (r.daysUntil === 0) return 'Today';
  if (r.daysUntil === 1) return 'Tomorrow';
  return `In ${r.daysUntil} days`;
}

function leapNote(r) {
  return r.month === 2 && r.day === 29 ? h('span.rem-leap', { title: 'In years without 29 February it shows on 28 February.' }, '28 Feb in non-leap years') : null;
}

function annualItem(r) {
  return h('li.rem-item.rem-item--annual', { dataset: { id: String(r.id), today: String(r.daysUntil === 0) }, 'aria-label': `${r.title}, every year on ${r.day} ${MONTHS[r.month - 1]}` },
    h('div.rem-date.rem-date--annual', { 'aria-hidden': 'true' },
      h('span.rem-date__day', {}, String(r.day)),
      h('span.rem-date__month', {}, MONTHS[r.month - 1].slice(0, 3)),
      h('span.rem-date__wd', {}, '↻')),
    h('div.rem-body', {},
      h('p.rem-title', {}, h('span', {}, r.title), r.daysUntil === 0 ? h('span.rem-status.rem-status--today', {}, 'Today') : null),
      h('p.rem-meta', {}, h('span.rem-every', {}, `Every year on ${r.day} ${MONTHS[r.month - 1]}`), h('span', {}, `· ${annualWhen(r)}`), leapNote(r)),
      r.notes ? h('p.rem-notes', {}, r.notes) : null),
    h('div.rem-side', {}, actions(r)));
}

function renderAnnual() {
  const { annual } = state.data;
  $('#rem-count-annual').textContent = annual.length ? String(annual.length) : '';
  $('#rem-annual-empty').hidden = annual.length > 0;
  // the next three occasions, soonest first
  const next = annual.slice().sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 3);
  $('#rem-next').hidden = next.length === 0;
  $('#rem-next-list').replaceChildren(...next.map((r) => h('li.rem-next__item', { dataset: { today: String(r.daysUntil === 0) } },
    h('span.rem-next__when', {}, annualWhen(r)),
    h('span.rem-next__title', {}, r.title),
    h('span.rem-next__date', {}, new Date(dateKeyToMs(r.next)).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })))));
  // all of them, month by month
  const byMonth = new Map();
  for (const r of annual) { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r); }
  $('#rem-months').replaceChildren(...[...byMonth.entries()].map(([m, rows]) => h('section.rem-month', { 'aria-label': MONTHS[m - 1] },
    h('h2.rem-group__title', {}, MONTHS[m - 1]),
    h('ol.rem-list', {}, rows.map(annualItem)))));
}

function render() {
  if (!state.data) return;
  renderOnce();
  renderAnnual();
  $('#rem-once').hidden = state.view !== 'once';
  $('#rem-annual').hidden = state.view !== 'annual';
}

async function load() {
  try { state.data = await api.reminders.overview(); render(); } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ actions

async function setDone(r, done) {
  try {
    await api.reminders.setDone(r.id, done);
    toast(done ? `"${r.title}" marked as done.` : `"${r.title}" is open again.`);
    await load();
  } catch (err) { toastError(err); load(); }
}

async function remove(r) {
  const ok = await confirmAction({
    title: 'Delete this reminder?',
    text: r.kind === 'annual'
      ? `"${r.title}" will no longer appear in Reminders or in the Agenda, in any year.`
      : `"${r.title}" will be removed. Nothing else is affected.`,
    ok: 'Delete reminder',
  });
  if (!ok) return;
  try { await api.reminders.remove(r.id); toast('Reminder deleted.'); await load(); } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ editor

let kindRadios;

function fillDays(month, keep) {
  const sel = $('#rem-form').elements.day;
  const max = DAYS_IN_MONTH[(Number(month) || 1) - 1];
  sel.replaceChildren(...Array.from({ length: max }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
  sel.value = String(Math.min(Number(keep) || 1, max));
}

function setKind(kind) {
  state.kind = kind;
  kindRadios.set(kind);
  for (const el of document.querySelectorAll('.rem-fields--once')) el.hidden = kind !== 'once';
  for (const el of document.querySelectorAll('.rem-fields--annual')) el.hidden = kind !== 'annual';
  $('#rem-kind-hint').textContent = kind === 'once'
    ? 'A meeting, appointment, interview or deadline. It happens once.'
    : 'A birthday, anniversary or other date that comes back every year. It also shows in the Agenda on that day.';
  $('#rem-form').elements.title.placeholder = kind === 'once' ? 'e.g. Project meeting' : 'e.g. Wedding anniversary';
}

function showError(msg) { $('#rem-error').textContent = msg || ''; $('#rem-error').hidden = !msg; }

export function openEditor(r = null, kind = null) {
  const f = $('#rem-form');
  state.editing = r;
  showError('');
  const k = r ? r.kind : (kind || state.view);
  setKind(k);
  // the kind of an existing reminder stays as it is
  for (const b of document.querySelectorAll('[data-rem-kind]')) b.disabled = Boolean(r) && b.dataset.remKind !== k;
  $('#rem-editor-title').textContent = r ? 'Edit reminder' : 'New reminder';
  f.elements.title.value = r ? r.title : '';
  f.elements.notes.value = r ? r.notes : '';
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  f.elements.date.value = r && r.kind === 'once' ? r.date : todayKey;
  f.elements.time.value = r && r.kind === 'once' && r.time ? r.time : '';
  f.elements.link.value = r && r.kind === 'once' && r.link ? r.link : '';
  const month = r && r.kind === 'annual' ? r.month : today.getMonth() + 1;
  f.elements.month.value = String(month);
  fillDays(month, r && r.kind === 'annual' ? r.day : today.getDate());
  $('#rem-editor').showModal();
  f.elements.title.focus();
}

async function save(e) {
  e.preventDefault();
  const f = $('#rem-form');
  const base = { id: state.editing ? state.editing.id : undefined, kind: state.kind, title: f.elements.title.value, notes: f.elements.notes.value };
  const data = state.kind === 'once'
    ? { ...base, date: f.elements.date.value, time: f.elements.time.value || null, link: f.elements.link.value.trim() || null }
    : { ...base, month: Number(f.elements.month.value), day: Number(f.elements.day.value) };
  if (!data.title.trim()) { showError('Give the reminder a title.'); f.elements.title.focus(); return; }
  if (state.kind === 'once' && !data.date) { showError('Choose a date.'); f.elements.date.focus(); return; }
  const btn = $('#rem-save');
  btn.disabled = true;
  try {
    const saved = await api.reminders.save(data);
    $('#rem-editor').close();
    toast(state.editing ? 'Reminder updated.' : saved.kind === 'annual'
      ? `"${saved.title}" will come back every year on ${saved.day} ${MONTHS[saved.month - 1]}.`
      : 'Reminder saved.');
    state.view = saved.kind;
    viewRadios.set(saved.kind);
    await load();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ init

let viewRadios;

export function initReminders() {
  viewRadios = radioGroup($('.rem-views'), 'remView', (v) => { state.view = v; viewRadios.set(v); render(); });
  viewRadios.set(state.view);
  kindRadios = radioGroup($('.rem-kind'), 'remKind', (k) => setKind(k));

  const f = $('#rem-form');
  f.elements.month.replaceChildren(...MONTHS.map((m, i) => h('option', { value: String(i + 1) }, m)));
  f.elements.month.addEventListener('change', (e) => fillDays(e.target.value, f.elements.day.value));
  f.addEventListener('submit', save);
  $('#rem-cancel').addEventListener('click', () => $('#rem-editor').close());
  $('#rem-new').addEventListener('click', () => openEditor(null, state.view));

  registerPage('reminders', { onShow: load });
  api.data.onChanged(() => { if (currentPage() === 'reminders') load(); });
  // statuses move on with the clock (a meeting becomes "past")
  setInterval(() => { if (currentPage() === 'reminders' && !document.hidden) load(); }, 60000);
}
