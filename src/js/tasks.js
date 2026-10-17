// Lightweight task management. Pomodoro counts and time are derived from
// sessions; finishing Pomodoros never completes a task automatically.

import { api, store } from './store.js';
import { $, h, icon, ICONS, radioGroup, toast, toastError, confirmAction } from './ui.js';
import { duration, dateShort, time, MODE_LABEL, STATUS_LABEL, plural } from './format.js';
import { registerPage, currentPage, navigate } from './navigation.js';

const state = { filter: 'active', tasks: [], open: new Set() };

function pips(done, est) {
  if (!est) return null;
  const n = Math.max(est, done);
  if (n > 24) return null;
  return h('span.pips', { 'aria-hidden': 'true' },
    Array.from({ length: n }, (_, i) => h(`span.pip${i < Math.min(done, est) ? '.is-done' : ''}${i >= est ? '.is-over' : ''}`)));
}

async function renderHistory(task, container) {
  container.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const rows = await api.tasks.sessions(task.id);
    if (!rows.length) {
      container.replaceChildren(h('p', {}, 'No sessions on this task yet.'));
      return;
    }
    container.replaceChildren(h('ol', {}, rows.map((r) => {
      const start = Date.parse(r.started_at);
      return h('li', {},
        h('span', {}, `${dateShort(start)}, ${time(start)}`),
        h('span.status', {}, `${MODE_LABEL[r.session_type]} ${STATUS_LABEL[r.status].toLowerCase()}`),
        h('span.num', {}, duration(r.actual_duration_seconds)));
    })));
  } catch (err) {
    container.replaceChildren(h('p.form-error', {}, err.message));
  }
}

function taskRow(t) {
  const selected = store.timer && store.timer.selectedTaskId === t.id;
  const done = t.completed_pomodoros;
  const est = t.estimated_pomodoros;
  const historyBox = h('div.task__history', { id: `task-hist-${t.id}`, hidden: !state.open.has(t.id) });
  if (state.open.has(t.id)) renderHistory(t, historyBox);

  const progressText = est ? `${done} of ${est} Pomodoros` : plural(done, 'Pomodoro');
  const estTime = est && store.settings ? ` of about ${duration(est * store.settings.focusMinutes * 60)}` : '';

  return h('li.task', { dataset: { status: t.status, id: String(t.id) } },
    h('button.task__check', {
      type: 'button',
      'aria-label': t.status === 'completed' ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`,
      'aria-pressed': String(t.status === 'completed'),
      onclick: () => toggleDone(t),
    }, icon(ICONS.check)),
    h('div.task__main', {},
      h('p.task__title', {}, t.title),
      t.description ? h('p.task__desc', {}, t.description) : null,
      h('div.task__meta', {},
        pips(done, est),
        h('span.pomo-count', {}, progressText),
        h('span', {}, `${duration(t.focus_seconds)} focused${estTime}`),
        selected ? h('span.task__selected', {}, 'Selected on the timer') : null)),
    h('div.task__actions', {},
      t.status === 'active' ? h('button.icon-btn.icon-btn--focus', {
        type: 'button', title: 'Focus on this task', 'aria-label': `Focus on "${t.title}"`,
        onclick: () => focusOn(t),
      }, icon(ICONS.play)) : null,
      h('button.icon-btn', {
        type: 'button', title: 'Session history', 'aria-label': `Session history for "${t.title}"`,
        'aria-expanded': String(state.open.has(t.id)), 'aria-controls': `task-hist-${t.id}`,
        onclick: (e) => toggleHistory(t, e.currentTarget, historyBox),
      }, icon(ICONS.history)),
      h('button.icon-btn', { type: 'button', title: 'Edit', 'aria-label': `Edit "${t.title}"`, onclick: () => openEditor(t) }, icon(ICONS.edit)),
      h('button.icon-btn.icon-btn--danger', { type: 'button', title: 'Delete', 'aria-label': `Delete "${t.title}"`, onclick: () => removeTask(t) }, icon(ICONS.trash))),
    historyBox);
}

function render() {
  const list = $('#task-list');
  list.replaceChildren(...state.tasks.map(taskRow));
  const empty = state.tasks.length === 0;
  $('#task-empty').hidden = !empty;
  if (empty) {
    $('#task-empty-title').textContent = state.filter === 'completed' ? 'No completed tasks yet' : state.filter === 'active' ? 'No active tasks' : 'No tasks yet';
    $('#task-empty-text').textContent = state.filter === 'completed'
      ? 'Tick a task when it is finished. Its Pomodoros stay in your statistics either way.'
      : 'Add one above, then pick it on the Focus screen. Pomodoros you finish on it are counted here.';
  }
}

async function load() {
  try {
    state.tasks = await api.tasks.list(state.filter);
    render();
  } catch (err) { toastError(err); }
}

async function toggleDone(t) {
  try {
    const next = t.status === 'completed' ? 'active' : 'completed';
    await api.tasks.setStatus(t.id, next);
    toast(next === 'completed' ? `Marked "${t.title}" as done.` : `"${t.title}" is active again.`);
  } catch (err) { toastError(err); }
}

async function focusOn(t) {
  try {
    if (store.timer.status !== 'idle' && store.timer.mode !== 'focus') {
      toast('The task will be used for your next focus session.');
    }
    await api.timer.setTask(t.id);
    navigate('focus');
  } catch (err) { toastError(err); }
}

function toggleHistory(t, btn, box) {
  const open = !state.open.has(t.id);
  if (open) state.open.add(t.id); else state.open.delete(t.id);
  btn.setAttribute('aria-expanded', String(open));
  box.hidden = !open;
  if (open) renderHistory(t, box);
}

async function removeTask(t) {
  const ok = await confirmAction({
    title: `Delete "${t.title}"?`,
    text: t.completed_pomodoros
      ? `Its ${plural(t.completed_pomodoros, 'Pomodoro')} stay in your history and statistics, but the task itself is removed.`
      : 'The task is removed. This cannot be undone.',
    ok: 'Delete task',
  });
  if (!ok) return;
  try {
    await api.tasks.remove(t.id);
    toast('Task deleted.');
  } catch (err) { toastError(err); }
}

function openEditor(t) {
  const dlg = $('#task-editor');
  const form = $('#task-editor-form');
  form.elements.title.value = t.title;
  form.elements.description.value = t.description || '';
  form.elements.estimate.value = t.estimated_pomodoros || '';
  $('#task-editor-error').hidden = true;
  dlg.showModal();
  form.elements.title.focus();
  form.onsubmit = async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    try {
      await api.tasks.update(t.id, {
        title: form.elements.title.value,
        description: form.elements.description.value,
        estimatedPomodoros: form.elements.estimate.value === '' ? null : Number(form.elements.estimate.value),
      });
      dlg.close();
      toast('Task saved.');
    } catch (err) {
      const box = $('#task-editor-error');
      box.textContent = err.message;
      box.hidden = false;
    }
  };
}

export function initTasks() {
  const filter = radioGroup($('.page--tasks .segmented'), 'taskFilter', (f) => {
    state.filter = f;
    filter.set(f);
    load();
  });
  filter.set(state.filter);

  $('#task-quick-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const title = form.elements.title.value.trim();
    if (!title) { form.elements.title.focus(); return; }
    try {
      await api.tasks.create({ title, estimatedPomodoros: form.elements.estimate.value === '' ? null : Number(form.elements.estimate.value) });
      form.reset();
      form.elements.title.focus();
      if (state.filter === 'completed') { state.filter = 'active'; filter.set('active'); load(); }
    } catch (err) { toastError(err); }
  });

  registerPage('tasks', { onShow: load });
  api.data.onChanged(() => { if (currentPage() === 'tasks') load(); });
  store.on('timer', () => { if (currentPage() === 'tasks') render(); });
}
