// Activity Statistics: time recorded per tag over a chosen range. Uses the
// same session records and tag snapshots as the Agenda's H.E. and goals.

import { api, store } from './store.js';
import { $, h, radioGroup, toastError } from './ui.js';
import { hoursMinutes, isoDate, parseIsoDate, dateShort } from './format.js';
import { currentPage } from './navigation.js';

const LOCALE = 'en-GB';
const state = { view: 'overview', range: 'month', year: new Date().getFullYear(), from: null, to: null, tagId: null, ticket: 0 };

/** {from, to, label} in ms for the selected range; to is exclusive. */
function rangeBounds() {
  const now = new Date();
  const y = now.getFullYear(); const m = now.getMonth(); const d = now.getDate();
  switch (state.range) {
    case 'today': return { from: new Date(y, m, d).getTime(), to: new Date(y, m, d + 1).getTime(), label: `Today, ${dateShort(Date.now())}` };
    case 'week': {
      const ws = store.settings ? Number(store.settings.weekStart) : 1;
      const diff = (now.getDay() - ws + 7) % 7;
      const start = new Date(y, m, d - diff);
      return { from: start.getTime(), to: new Date(y, m, d - diff + 7).getTime(), label: `Week of ${start.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}` };
    }
    case 'month': return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime(), label: now.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }) };
    case 'year': return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: `${y} so far` };
    case 'pickyear': return { from: new Date(state.year, 0, 1).getTime(), to: new Date(state.year + 1, 0, 1).getTime(), label: String(state.year) };
    case 'custom': {
      const from = parseIsoDate($('#act-from').value);
      const toDay = parseIsoDate($('#act-to').value);
      if (from === null || toDay === null) return { from: null, to: null, label: 'Choose a start and end date', incomplete: true };
      const end = new Date(toDay); end.setDate(end.getDate() + 1);
      return {
        from, to: end.getTime(),
        label: `${new Date(from).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })} – ${new Date(toDay).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}`,
      };
    }
    default: return { from: undefined, to: undefined, label: 'All recorded history' };
  }
}

function shareBar(seconds, total) {
  const pct = total ? Math.round((seconds / total) * 100) : 0;
  return h('span.share', { title: `${pct}% of all focused time in this range` }, h('span', { style: `width:${pct}%` }));
}

async function renderDetail() {
  const box = $('#act-detail');
  if (!state.tagId) { box.replaceChildren(h('p.act-detail__hint', {}, 'Select a tag to see its sessions.')); return; }
  const r = rangeBounds();
  if (r.incomplete) return;
  try {
    const d = await api.activity.detail(state.tagId, { from: r.from, to: r.to });
    const maxMonth = Math.max(1, ...d.byMonth.map((m) => m.seconds));
    box.replaceChildren(...[
      h('p.act-detail__eyebrow', {}, r.label),
      h('h3.act-detail__title', {}, h(`span.tag.tag--${d.tag.color}`, {}, d.tag.name)),
      h('dl.act-figures', {},
        h('div', {}, h('dt', {}, 'Total Pomodoro sessions'), h('dd', {}, String(d.sessions))),
        h('div', {}, h('dt', {}, 'Total focused time'), h('dd', {}, hoursMinutes(d.seconds)))),
      d.sessions
        ? h('p.act-detail__span', {}, `From ${new Date(Date.parse(d.firstAt)).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })} to ${new Date(Date.parse(d.lastAt)).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}`)
        : h('p.act-detail__span', {}, 'No completed Pomodoros with this tag in this range.'),
      d.byMonth.length > 1 ? h('section.act-months', {},
        h('h4', {}, 'By month'),
        h('ul', {}, d.byMonth.map((m) => {
          const [yy, mm] = m.month.split('-').map(Number);
          return h('li', {},
            h('span', {}, new Date(yy, mm - 1, 1).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' })),
            h('span.share', {}, h('span', { style: `width:${(m.seconds / maxMonth) * 100}%` })),
            h('span.num', {}, hoursMinutes(m.seconds)));
        }))) : null,
      d.byTask.length ? h('section.act-tasks', {},
        h('h4', {}, 'By task'),
        h('ul', {}, d.byTask.slice(0, 12).map((t) => h('li', {},
          h('span.act-tasks__name', {}, t.task),
          h('span.num', {}, `${t.sessions}P`),
          h('span.num', {}, hoursMinutes(t.seconds)))))) : null,
    ].filter(Boolean));
  } catch (err) { toastError(err); }
}

async function load() {
  const r = rangeBounds();
  $('#act-range-label').textContent = r.label;
  if (r.incomplete) return;
  const ticket = ++state.ticket;
  try {
    const s = await api.activity.stats({ from: r.from, to: r.to });
    if (ticket !== state.ticket) return;
    const body = $('#act-body');
    const total = s.total.seconds;
    if (state.tagId && !s.tags.some((t) => t.id === state.tagId)) state.tagId = null;
    if (!state.tagId && s.tags.length) state.tagId = s.tags[0].id;
    body.replaceChildren(...s.tags.map((t) => h('tr', {
      'aria-selected': String(t.id === state.tagId),
      tabindex: '0',
      onclick: () => { state.tagId = t.id; load(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.tagId = t.id; load(); } },
    },
    h('th', { scope: 'row' }, h(`span.tag.tag--${t.color}`, {}, t.name)),
    h('td.num', {}, String(t.sessions)),
    h('td.num', {}, hoursMinutes(t.seconds)),
    h('td', {}, shareBar(t.seconds, total)))));
    $('#act-foot').replaceChildren(
      h('tr.muted', {}, h('th', { scope: 'row' }, 'No tag'), h('td.num', {}, String(s.untagged.sessions)), h('td.num', {}, hoursMinutes(s.untagged.seconds)), h('td', {}, shareBar(s.untagged.seconds, total))),
      h('tr', {}, h('th', { scope: 'row' }, 'All focus'), h('td.num', {}, String(s.total.sessions)), h('td.num', {}, hoursMinutes(total)), h('td')),
    );
    $('#act-empty').hidden = s.tags.length > 0;
    $('.act-table').hidden = s.tags.length === 0;
    renderDetail();
  } catch (err) { toastError(err); }
}

async function fillYears() {
  const years = await api.agenda.years();
  const sel = $('#act-year');
  sel.replaceChildren(...years.slice().reverse().map((y) => h('option', { value: String(y) }, String(y))));
  sel.value = String(state.year);
}

function showView(view) {
  state.view = view;
  $('#dash-overview').hidden = view !== 'overview';
  $('#dash-activity').hidden = view !== 'activity';
  if (view === 'activity') { fillYears().catch(() => {}); load(); }
}

export function initActivity({ onOverview }) {
  const views = radioGroup($('.dash-views'), 'dashView', (v) => {
    views.set(v);
    showView(v);
    if (v === 'overview') onOverview();
  });
  views.set('overview');

  const ranges = radioGroup($('#act-filters .segmented'), 'actRange', (r) => {
    state.range = r;
    ranges.set(r);
    $('#act-year-wrap').hidden = r !== 'pickyear';
    $('#act-from-wrap').hidden = r !== 'custom';
    $('#act-to-wrap').hidden = r !== 'custom';
    if (r === 'custom' && !$('#act-from').value) {
      const now = new Date();
      $('#act-from').value = isoDate(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
      $('#act-to').value = isoDate(now.getTime());
    }
    load();
  });
  ranges.set('month');
  $('#act-year').addEventListener('change', (e) => { state.year = Number(e.target.value); load(); });
  $('#act-from').addEventListener('change', load);
  $('#act-to').addEventListener('change', load);
  $('#act-filters').addEventListener('submit', (e) => e.preventDefault());

  api.data.onChanged(() => { if (currentPage() === 'dashboard' && state.view === 'activity') load(); });
}

export function activityVisible() { return state.view === 'activity'; }

export function refreshActivity() { return load(); }
