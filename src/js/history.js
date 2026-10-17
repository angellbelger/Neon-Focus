// Chronological session log with date / type / status filters.

import { api } from './store.js';
import { $, h, toastError } from './ui.js';
import { duration, time, dateLong, MODE_LABEL, STATUS_LABEL, parseIsoDate, plural } from './format.js';
import { registerPage, currentPage } from './navigation.js';

const PAGE_SIZE = 100;
const state = { rows: [], total: 0, loading: 0 };

function filters() {
  const from = parseIsoDate($('#hf-from').value);
  const toDay = parseIsoDate($('#hf-to').value);
  let to = null;
  if (toDay !== null) { const d = new Date(toDay); d.setDate(d.getDate() + 1); to = d.getTime(); }
  return { from, to, type: $('#hf-type').value, status: $('#hf-status').value };
}

function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

function render() {
  const body = $('#history-body');
  const rows = [];
  let lastDay = null;
  for (const r of state.rows) {
    const start = Date.parse(r.started_at);
    const end = Date.parse(r.ended_at);
    const k = dayKey(start);
    if (k !== lastDay) {
      lastDay = k;
      rows.push(h('tr.day-row', {}, h('td', { colspan: '6' }, dateLong(start))));
    }
    const taskTitle = r.display_task_title;
    rows.push(h('tr', {},
      h('td', {}, new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
      h('td', {}, `${time(start)}–${time(end)}`),
      h('td', {}, h('span.type-tag', { 'data-type': r.session_type }, MODE_LABEL[r.session_type])),
      h('td', {}, h('span.status-tag', { 'data-status': r.status }, STATUS_LABEL[r.status])),
      h('td.num', { title: `${r.actual_duration_seconds} s of ${r.planned_duration_seconds} s planned` },
        r.status === 'completed' ? duration(r.actual_duration_seconds) : `${duration(r.actual_duration_seconds)} of ${duration(r.planned_duration_seconds)}`),
      h('td.task-cell', {}, taskTitle
        ? h('span', { class: r.task_exists ? null : 'deleted', title: r.task_exists ? null : 'This task was deleted' }, taskTitle)
        : '—')));
  }
  body.replaceChildren(...rows);
  $('#history-empty').hidden = state.rows.length > 0;
  $('#history-more').hidden = state.rows.length >= state.total;
  $('#history-count').textContent = state.total ? `${plural(state.total, 'session')}${state.rows.length < state.total ? `, showing ${state.rows.length}` : ''}` : '';
}

async function load({ append = false } = {}) {
  const ticket = ++state.loading;
  try {
    const res = await api.history.list({ ...filters(), limit: PAGE_SIZE, offset: append ? state.rows.length : 0 });
    if (ticket !== state.loading) return;
    state.rows = append ? state.rows.concat(res.rows) : res.rows;
    state.total = res.total;
    render();
  } catch (err) { toastError(err); }
}

export function initHistory() {
  const form = $('#history-filters');
  form.addEventListener('change', () => {
    const from = $('#hf-from');
    const to = $('#hf-to');
    const bad = from.value && to.value && from.value > to.value;
    to.setAttribute('aria-invalid', String(Boolean(bad)));
    if (bad) { toastError(new Error('The "To" date is before the "From" date.')); return; }
    load();
  });
  form.addEventListener('reset', () => setTimeout(() => { $('#hf-to').removeAttribute('aria-invalid'); load(); }, 0));
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#history-more').addEventListener('click', () => load({ append: true }));

  registerPage('history', { onShow: () => load() });
  api.data.onChanged(() => { if (currentPage() === 'history') load(); });
}
