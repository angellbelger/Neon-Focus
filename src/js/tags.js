// Tags: reusable activity categories shown as chips on tasks, a picker to
// assign them to a task, and a manager to create, rename, recolour and
// delete them. Used by Tasks, Agenda, Goals and Activity Statistics.

import { api } from './store.js';
import { $, h, toast, toastError, confirmAction } from './ui.js';
import { plural } from './format.js';

export const TAG_COLORS = ['cyan', 'violet', 'amber', 'green', 'pink', 'blue', 'red', 'gray'];

let cache = null;

export async function loadTags(force = false) {
  if (!cache || force) cache = await api.tags.list();
  return cache;
}

export function invalidateTags() { cache = null; }

/** Small coloured chips for a task's tags. */
export function tagChips(tags, { small = false } = {}) {
  if (!tags || !tags.length) return null;
  return h(`span.tag-chips${small ? '.tag-chips--small' : ''}`, {},
    tags.map((t) => h(`span.tag.tag--${t.color || 'cyan'}`, { title: `Tag: ${t.name}` }, t.name)));
}

// ------------------------------------------------------------------ picker

/**
 * Lets the user choose a task's tags. Offers to re-classify the task's past
 * Pomodoros (an explicit historical correction); off by default.
 * Resolves true if tags were saved.
 */
export async function openTagPicker(task) {
  const dlg = $('#tag-picker');
  const list = $('#tag-picker-list');
  const err = $('#tag-picker-error');
  const pastWrap = $('#tag-picker-past-wrap');
  const pastBox = $('#tag-picker-past');
  err.hidden = true;
  pastBox.checked = false;
  $('#tag-picker-task').textContent = task.title;
  $('#tag-picker-new').value = '';

  const selected = new Set((task.tags || []).map((t) => t.id));
  let past = 0;
  try { past = await api.tasks.pastSessions(task.id); } catch (_) { past = 0; }

  const renderList = (tags) => {
    list.replaceChildren(...tags.map((t) => h('li', {},
      h('label.check-row', {},
        h('input', {
          type: 'checkbox', value: String(t.id), checked: selected.has(t.id) ? true : null,
          onchange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); },
        }),
        h(`span.tag.tag--${t.color}`, {}, t.name),
        h('span.muted', {}, t.task_count ? plural(t.task_count, 'task') : '')))));
    if (!tags.length) list.append(h('li.muted', {}, 'No tags yet. Create your first one below.'));
  };

  renderList(await loadTags(true));

  pastWrap.hidden = past === 0;
  $('#tag-picker-past-text').textContent = `Also re-classify this task's ${plural(past, 'past Pomodoro')} with these tags (corrects history; normally past sessions keep the tags they had).`;

  const createBtn = $('#tag-picker-create');
  const newInput = $('#tag-picker-new');
  const create = async () => {
    const name = newInput.value.trim();
    if (!name) { newInput.focus(); return; }
    try {
      const tag = await api.tags.create({ name });
      selected.add(tag.id);
      newInput.value = '';
      renderList(await loadTags(true));
      toast(`Tag "${tag.name}" created.`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  createBtn.onclick = create;
  newInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };

  dlg.showModal();
  return new Promise((resolve) => {
    $('#tag-picker-form').onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') { resolve(false); return; }
      e.preventDefault();
      try {
        const r = await api.tasks.setTags(task.id, [...selected], { applyToPast: pastBox.checked });
        dlg.close();
        invalidateTags();
        toast(r.reclassified ? `Tags saved. ${plural(r.reclassified, 'past session')} re-classified.` : 'Tags saved.');
        resolve(true);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };
    dlg.addEventListener('close', () => resolve(false), { once: true });
  });
}

// ------------------------------------------------------------------ manager

async function renderManager() {
  const list = $('#tag-manager-list');
  const tags = await loadTags(true);
  list.replaceChildren(...tags.map((t) => {
    const name = h('input.tag-admin__name', { type: 'text', maxlength: '40', value: t.name, 'aria-label': `Name of tag ${t.name}` });
    const save = async (patch) => {
      try {
        await api.tags.update(t.id, patch);
        invalidateTags();
        toast('Tag saved.');
        renderManager();
      } catch (e) { toastError(e); renderManager(); }
    };
    name.addEventListener('change', () => { if (name.value.trim() && name.value.trim() !== t.name) save({ name: name.value }); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
    return h('li.tag-admin__row', {},
      h('span.tag-admin__colors', { role: 'radiogroup', 'aria-label': `Colour of ${t.name}` },
        TAG_COLORS.map((c) => h(`button.swatch-dot.tag--${c}`, {
          type: 'button', role: 'radio', 'aria-checked': String(c === t.color), title: c, 'aria-label': c,
          onclick: () => { if (c !== t.color) save({ color: c }); },
        }))),
      name,
      h('span.tag-admin__use', {}, `${plural(t.task_count, 'task')}, ${plural(t.pomodoro_count, 'Pomodoro')}`),
      h('button.icon-btn.icon-btn--danger', {
        type: 'button', title: 'Delete tag', 'aria-label': `Delete tag ${t.name}`,
        onclick: async () => {
          const ok = await confirmAction({
            title: `Delete the tag "${t.name}"?`,
            text: `It is removed from ${plural(t.task_count, 'task')}. Its ${plural(t.pomodoro_count, 'recorded Pomodoro')} will no longer count under any tag in Activity Statistics or goals. The sessions themselves stay in your history.`,
            ok: 'Delete tag',
          });
          if (!ok) return;
          try { await api.tags.remove(t.id); invalidateTags(); toast('Tag deleted.'); } catch (e) { toastError(e); }
          renderManager();
        },
      }, h('span', { 'aria-hidden': 'true' }, '×')));
  }));
  if (!tags.length) list.append(h('li.muted', {}, 'No tags yet. Examples: English, Programming, Research, Reading, Work.'));
}

export async function openTagManager() {
  const dlg = $('#tag-manager');
  $('#tag-manager-error').hidden = true;
  await renderManager();
  const input = $('#tag-manager-new');
  const create = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      const tag = await api.tags.create({ name });
      input.value = '';
      invalidateTags();
      toast(`Tag "${tag.name}" created.`);
      $('#tag-manager-error').hidden = true;
      renderManager();
    } catch (e) { $('#tag-manager-error').textContent = e.message; $('#tag-manager-error').hidden = false; }
  };
  $('#tag-manager-create').onclick = create;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
  dlg.showModal();
}
