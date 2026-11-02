// Legacy data: weekly totals copied from paper planners kept before Focus Neon.
// A record is one figure for one calendar week — the week's TTP (Pomodoros),
// or the hours spent on one tag. Weeks follow Settings → "Weeks start on".
// Records live in their own table: sessions, tasks and notes are never touched.

import { api, store } from './store.js';
import { $, h, toast, toastError, confirmAction } from './ui.js';
import { hoursMinutes, dateKeyToMs } from './format.js';
import { loadTags } from './tags.js';

const LOCALE = 'en-GB';

const state = {
  year: new Date().getFullYear(),
  weeks: [],          // [{ week, from, to }] of state.year
  current: null,      // { year, week } of today
  editingId: null,    // record being edited (null = adding)
  duplicateId: null,  // existing record that blocks the entry
  tags: [],
  records: [],
};

const dlg = () => $('#legacy-manager');

function shortRange(from, to) {
  const a = new Date(dateKeyToMs(from));
  const b = new Date(dateKeyToMs(to));
  const left = a.getMonth() === b.getMonth() ? String(a.getDate()) : a.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  return `${left}–${b.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`;
}

function weekLabel(w) {
  return `W${w.week} · ${shortRange(w.from, w.to)}`;
}

/** Hours typed as 6.5, 6,5 or 6:30 -> seconds (NaN if not a number). */
function parseHours(text) {
  const t = String(text).trim().replace(',', '.');
  const m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60;
  if (t === '' || !/^\d*\.?\d+$/.test(t)) return NaN;
  return Math.round(Number(t) * 3600);
}

function kind() { return $('#lg-kind').value; }

function showError(message, existingId = null) {
  state.duplicateId = existingId;
  $('#lg-error-text').textContent = message;
  $('#lg-edit-existing').hidden = !existingId;
  $('#lg-error').hidden = false;
}

function clearError() {
  state.duplicateId = null;
  $('#lg-error').hidden = true;
}

function updateKindFields() {
  const hours = kind() === 'tag_hours';
  $('#lg-tag-wrap').hidden = !hours;
  $('#lg-value-label').textContent = hours ? 'Hours' : 'Pomodoros';
  const input = $('#lg-value');
  input.type = hours ? 'text' : 'number';
  input.placeholder = hours ? 'e.g. 6.5 or 6:30' : 'e.g. 32';
  if (hours) { input.removeAttribute('min'); input.removeAttribute('step'); } else { input.min = '1'; input.step = '1'; }
  updateHint();
}

function updateHint() {
  const v = $('#lg-value').value;
  if (kind() === 'tag_hours' && v) {
    const s = parseHours(v);
    $('#lg-hint').textContent = Number.isFinite(s) && s > 0 ? `= ${hoursMinutes(s)}` : '';
  } else {
    $('#lg-hint').textContent = '';
  }
}

function fillTags() {
  const sel = $('#lg-tag');
  const keep = sel.value;
  sel.replaceChildren(...(state.tags.length
    ? state.tags.map((t) => h('option', { value: String(t.id) }, t.name))
    : [h('option', { value: '', disabled: true }, 'Create a tag first (Tasks → Manage tags)')]));
  if (keep && state.tags.some((t) => String(t.id) === keep)) sel.value = keep;
}

async function loadWeeks(preferWeek = null) {
  const r = await api.legacy.weeks(state.year);
  state.weeks = r.weeks;
  state.current = r.current;
  $('#lg-weekstart').textContent = `Weeks run ${r.weekStart === 0 ? 'Sunday to Saturday' : 'Monday to Sunday (ISO week numbers)'}, as set in Settings → Weeks start on.`;
  const sel = $('#lg-week');
  const before = Number(sel.value) || null;
  sel.replaceChildren(...state.weeks.map((w) => h('option', { value: String(w.week) }, weekLabel(w))));
  let pick = preferWeek || before;
  if (!pick || pick > state.weeks.length) {
    pick = state.current && state.current.year === state.year ? state.current.week : 1;
  }
  sel.value = String(Math.min(pick, state.weeks.length));
}

function recordValue(r) {
  return r.kind === 'pomodoros' ? `${r.value}P` : hoursMinutes(r.value);
}

function renderList() {
  $('#lg-list-year').textContent = String(state.year);
  const byWeek = new Map();
  for (const r of state.records) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  $('#lg-empty').hidden = byWeek.size > 0;
  $('#lg-list').replaceChildren(...[...byWeek.entries()].map(([week, rows]) => {
    const w = rows[0];
    return h('li.legacy-week', { dataset: { week: String(week) } },
      h('p.legacy-week__head', {},
        h('span.legacy-week__num', {}, `W${week}`),
        h('span.legacy-week__dates', {}, shortRange(w.from, w.to)),
        w.inYear ? null : h('span.legacy-week__warn', { title: 'This year has fewer weeks with the current "Weeks start on" setting.' }, 'not in this year with the current week setting')),
      h('ul.legacy-week__rows', {}, rows.map((r) => h('li.legacy-row', {
        dataset: { id: String(r.id), kind: r.kind, editing: String(r.id === state.editingId) },
      },
      r.kind === 'pomodoros'
        ? h('span.legacy-row__what', {}, 'TTP')
        : h('span.legacy-row__what', {}, h(`span.tag.tag--${r.tag_color || 'gray'}`, { title: r.tag_id ? null : 'This tag was deleted; these hours no longer count.' }, r.tag_name + (r.tag_id ? '' : ' (deleted)'))),
      h('span.legacy-row__value', {}, recordValue(r)),
      h('span.legacy-row__actions', {},
        h('button.btn.btn--small.btn--ghost', { type: 'button', onclick: () => startEdit(r.id), 'aria-label': `Edit ${r.kind === 'pomodoros' ? 'TTP' : r.tag_name} for week ${r.week}` }, 'Edit'),
        h('button.btn.btn--small.btn--ghost.legacy-row__del', { type: 'button', onclick: () => remove(r), 'aria-label': `Delete ${r.kind === 'pomodoros' ? 'TTP' : r.tag_name} for week ${r.week}` }, 'Delete'))))));
  }));
}

async function loadList() {
  state.records = await api.legacy.list(state.year);
  renderList();
}

function resetForm({ keepWeek = true } = {}) {
  state.editingId = null;
  $('#lg-entry-title').textContent = 'Add a record';
  $('#lg-save').textContent = 'Add record';
  $('#lg-cancel').hidden = true;
  $('#lg-value').value = '';
  if (!keepWeek) $('#lg-week').value = String(state.current && state.current.year === state.year ? state.current.week : 1);
  updateHint();
  clearError();
}

async function startEdit(id) {
  const r = state.records.find((x) => x.id === id) || (await api.legacy.list()).find((x) => x.id === id);
  if (!r) return;
  clearError();
  state.editingId = r.id;
  if (r.year !== state.year) {
    state.year = r.year;
    $('#lg-year').value = String(r.year);
    await loadWeeks(r.week);
    await loadList();
  }
  $('#lg-week').value = String(r.week);
  $('#lg-kind').value = r.kind;
  updateKindFields();
  if (r.kind === 'tag_hours' && r.tag_id) $('#lg-tag').value = String(r.tag_id);
  $('#lg-value').value = r.kind === 'pomodoros' ? String(r.value) : String(Math.round((r.value / 3600) * 100) / 100);
  $('#lg-entry-title').textContent = `Edit record · W${r.week} ${r.year}`;
  $('#lg-save').textContent = 'Save changes';
  $('#lg-cancel').hidden = false;
  updateHint();
  renderList();
  $('#lg-value').focus();
}

async function save() {
  clearError();
  const year = Number($('#lg-year').value);
  const week = Number($('#lg-week').value);
  const k = kind();
  const tagId = k === 'tag_hours' ? Number($('#lg-tag').value) || null : null;
  if (k === 'tag_hours' && !tagId) { showError('Choose a tag for these hours.'); return; }
  const raw = $('#lg-value').value;
  const value = k === 'pomodoros' ? Number(raw) : parseHours(raw);
  if (k === 'pomodoros' && (!Number.isInteger(value) || value < 1)) { showError('Enter the number of Pomodoros as a whole number (1 or more).'); $('#lg-value').focus(); return; }
  if (k === 'tag_hours' && (!Number.isFinite(value) || value < 60)) { showError('Enter the hours, e.g. 6.5 or 6:30 (at least 1 minute).'); $('#lg-value').focus(); return; }

  // Same week and metric/tag already recorded? Offer to edit it instead.
  const existing = await api.legacy.find({ year, week, kind: k, tagId });
  if (existing && existing.id !== state.editingId) {
    const tagName = k === 'tag_hours' ? (state.tags.find((t) => t.id === tagId) || {}).name : null;
    showError(`Week ${week} of ${year} already has ${k === 'pomodoros' ? 'a TTP total' : `hours for "${tagName}"`}.`, existing.id);
    return;
  }

  const btn = $('#lg-save');
  btn.disabled = true;
  try {
    const wasEditing = Boolean(state.editingId);
    const rec = await api.legacy.save({ id: state.editingId, year, week, kind: k, tagId, value });
    toast(`${wasEditing ? 'Updated' : 'Saved'} legacy record: W${rec.week} ${rec.year}, ${rec.kind === 'pomodoros' ? `${rec.value} Pomodoros` : `${hoursMinutes(rec.value)} ${rec.tag_name}`}.`);
    resetForm();
    await loadList();
    $('#lg-value').focus();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function remove(r) {
  const what = r.kind === 'pomodoros' ? `the TTP total (${r.value}P)` : `the ${hoursMinutes(r.value)} of ${r.tag_name}`;
  const ok = await confirmAction({
    title: 'Delete this legacy record?',
    text: `This removes ${what} for week ${r.week} of ${r.year} from your statistics. Recorded sessions are not affected.`,
    ok: 'Delete record',
  });
  if (!ok) return;
  try {
    await api.legacy.remove(r.id);
    if (state.editingId === r.id) resetForm();
    toast('Legacy record deleted.');
    await loadList();
  } catch (err) { toastError(err); }
}

async function changeYear() {
  const y = Number($('#lg-year').value);
  if (!Number.isInteger(y) || y < 1970 || y > 2200) return;
  state.year = y;
  try {
    await loadWeeks();
    await loadList();
  } catch (err) { toastError(err); }
}

export async function openLegacyManager() {
  try {
    state.tags = await loadTags(true);
    if (!$('#lg-year').value) $('#lg-year').value = String(state.year);
    state.year = Number($('#lg-year').value);
    fillTags();
    await loadWeeks();
    resetForm();
    updateKindFields();
    await loadList();
    dlg().showModal();
    $('#lg-value').focus();
  } catch (err) { toastError(err); }
}

export function initLegacy() {
  $('#lg-year').addEventListener('change', changeYear);
  $('#lg-kind').addEventListener('change', () => { updateKindFields(); clearError(); });
  $('#lg-value').addEventListener('input', updateHint);
  $('#lg-week').addEventListener('change', clearError);
  $('#lg-tag').addEventListener('change', clearError);
  $('#lg-save').addEventListener('click', save);
  $('#lg-cancel').addEventListener('click', () => { resetForm(); renderList(); });
  $('#lg-edit-existing').addEventListener('click', () => { if (state.duplicateId) startEdit(state.duplicateId); });
  $('#legacy-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#lg-value')) { e.preventDefault(); save(); }
  });
  // The week setting changed while the manager is open: relabel the weeks.
  store.on('settings', () => { if (dlg().open) changeYear(); });
  api.data.onChanged(async () => {
    if (!dlg().open) return;
    state.tags = await loadTags(true);
    fillTags();
    loadList().catch(() => {});
  });
}

