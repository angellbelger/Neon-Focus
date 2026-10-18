// Lightweight task management. Pomodoro counts and time are derived from
// sessions; finishing Pomodoros never completes a task automatically.

import { api, store } from './store.js';
import { $, h, icon, ICONS, radioGroup, toast, toastError, confirmAction } from './ui.js';
import { duration, dateShort, time, MODE_LABEL, STATUS_LABEL, plural } from './format.js';
import { registerPage, currentPage, navigate } from './navigation.js';

const state = {
  filter: 'active',
  tasks: [],
  open: new Set(),          // tasks with session history expanded
  collapsedSteps: new Set(),// tasks whose step list is collapsed
  addingStepFor: null,      // task id with the "add step" field open
  editingStep: null,        // step id being renamed
};

const MAX_STEPS = 100;

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

// ------------------------------------------------------------------ steps

function stepsMeta(t) {
  const total = t.steps.length;
  if (!total) return null;
  const done = t.steps.filter((x) => x.completed).length;
  const collapsed = state.collapsedSteps.has(t.id);
  const label = done === total ? `All ${total} steps done` : `${done} of ${total} steps`;
  return h('button.steps-toggle', {
    type: 'button',
    'data-all-done': String(done === total),
    'aria-expanded': String(!collapsed),
    'aria-controls': `task-steps-${t.id}`,
    title: collapsed ? 'Show steps' : 'Hide steps',
    onclick: () => {
      if (collapsed) state.collapsedSteps.delete(t.id); else state.collapsedSteps.add(t.id);
      rerenderTask(t.id);
    },
  },
  h('span.steps-toggle__bar', { 'aria-hidden': 'true' }, h('span', { style: `width:${(done / total) * 100}%` })),
  h('span', {}, label),
  icon('M7 10l5 5 5-5'));
}

function stepItem(t, step) {
  const done = Boolean(step.completed);
  const editing = state.editingStep === step.id;
  const title = editing
    ? h('input.step__edit', {
      type: 'text', maxlength: '200', value: step.title,
      'aria-label': `Rename step "${step.title}"`,
      'data-focus-key': `edit-${step.id}`,
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(t, step, e.currentTarget.value); }
        else if (e.key === 'Escape') { e.preventDefault(); state.editingStep = null; rerenderTask(t.id, `step-${step.id}`); }
      },
      onblur: (e) => { if (state.editingStep === step.id) commitRename(t, step, e.currentTarget.value); },
    })
    : h('button.step__title', {
      type: 'button',
      title: 'Click to rename',
      'aria-label': `${step.title}${done ? ', done' : ''}. Rename`,
      'data-focus-key': `step-${step.id}`,
      onclick: () => { state.editingStep = step.id; rerenderTask(t.id, `edit-${step.id}`); },
    }, step.title);

  return h('li.step', { dataset: { done: String(done), id: String(step.id) } },
    h('button.step__check', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(done),
      'aria-label': `${step.title}: mark as ${done ? 'not done' : 'done'}`,
      'data-focus-key': `check-${step.id}`,
      onclick: () => stepCall(t, () => api.tasks.setStepCompleted(step.id, !done), `check-${step.id}`),
    }, icon(ICONS.check)),
    title,
    h('button.step__delete', {
      type: 'button',
      title: 'Delete step',
      'aria-label': `Delete step "${step.title}"`,
      onclick: () => stepCall(t, () => api.tasks.removeStep(step.id), `add-btn-${t.id}`),
    }, icon('M6 6l12 12M18 6L6 18')));
}

function stepsBlock(t) {
  const collapsed = state.collapsedSteps.has(t.id) && t.steps.length > 0;
  const adding = state.addingStepFor === t.id;
  const full = t.steps.length >= MAX_STEPS;

  const addControl = adding
    ? h('div.step-add', {},
      h('span.step-add__plus', { 'aria-hidden': 'true' }, '+'),
      h('input.step-add__input', {
        type: 'text', maxlength: '200',
        placeholder: t.steps.length ? 'Next step' : 'Add a step',
        'aria-label': `Add a step to "${t.title}"`,
        'data-focus-key': `add-${t.id}`,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); addStep(t, e.currentTarget); }
          else if (e.key === 'Escape') { e.preventDefault(); state.addingStepFor = null; rerenderTask(t.id, `add-btn-${t.id}`); }
        },
        onblur: (e) => {
          const input = e.currentTarget;
          // Clicking elsewhere: save what was typed, or just close the field.
          setTimeout(() => {
            if (!input.isConnected || input.dataset.busy || state.addingStepFor !== t.id || document.activeElement === input) return;
            if (input.value.trim()) addStep(t, input, { keepOpen: false });
            else { state.addingStepFor = null; rerenderTask(t.id); }
          }, 0);
        },
      }))
    : (full ? null : h('button.step-add__btn', {
      type: 'button',
      'data-focus-key': `add-btn-${t.id}`,
      onclick: () => { state.addingStepFor = t.id; state.collapsedSteps.delete(t.id); rerenderTask(t.id, `add-${t.id}`); },
    }, h('span', { 'aria-hidden': 'true' }, '+'), t.steps.length ? 'Add step' : 'Add steps'));

  return h('div.steps', { id: `task-steps-${t.id}` },
    collapsed ? null : h('ul.steps__list', { 'aria-label': `Steps of "${t.title}"` }, t.steps.map((step) => stepItem(t, step))),
    collapsed ? null : addControl);
}

async function stepCall(t, fn, focusKey) {
  try {
    t.steps = await fn();
    rerenderTask(t.id, focusKey);
  } catch (err) { toastError(err); load(); }
}

async function addStep(t, input, { keepOpen = true } = {}) {
  const title = input.value.trim();
  if (!title || input.dataset.busy) return;
  // readOnly (not disabled) so the field keeps focus and doesn't fire a blur
  // that would submit the same step twice.
  input.dataset.busy = '1';
  input.readOnly = true;
  try {
    t.steps = await api.tasks.addStep(t.id, title);
    if (!keepOpen) state.addingStepFor = null;
    rerenderTask(t.id, keepOpen ? `add-${t.id}` : null);
  } catch (err) {
    delete input.dataset.busy;
    input.readOnly = false;
    toastError(err);
  }
}

async function commitRename(t, step, value) {
  state.editingStep = null;
  const title = value.trim();
  if (!title || title === step.title) { rerenderTask(t.id, `step-${step.id}`); return; }
  await stepCall(t, () => api.tasks.renameStep(step.id, title), `step-${step.id}`);
}

/** Redraws one task row in place and optionally focuses an element in it. */
function rerenderTask(taskId, focusKey = null) {
  const t = state.tasks.find((x) => x.id === taskId);
  const old = $(`#task-list .task[data-id="${taskId}"]`);
  if (!t || !old) return;
  const row = taskRow(t);
  old.replaceWith(row);
  if (focusKey) {
    const el = row.querySelector(`[data-focus-key="${focusKey}"]`);
    if (el) el.focus();
  }
}

// ------------------------------------------------------------------ rows

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
        stepsMeta(t),
        selected ? h('span.task__selected', {}, 'Selected on the timer') : null),
      stepsBlock(t)),
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
  // Keep focus and anything being typed when the list is redrawn underneath.
  const active = document.activeElement;
  const key = active && list.contains(active) ? active.dataset.focusKey : null;
  const typed = key && active.tagName === 'INPUT' ? { value: active.value, start: active.selectionStart } : null;
  list.replaceChildren(...state.tasks.map(taskRow));
  if (key) {
    const el = list.querySelector(`[data-focus-key="${key}"]`);
    if (el) {
      if (typed) { el.value = typed.value; }
      el.focus();
      if (typed) el.setSelectionRange(typed.start, typed.start);
    }
  }
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
    text: `${t.steps.length ? `Its ${plural(t.steps.length, 'step')} will be deleted too. ` : ''}${t.completed_pomodoros
      ? `Its ${plural(t.completed_pomodoros, 'Pomodoro')} stay in your history and statistics, but the task itself is removed.`
      : 'The task is removed. This cannot be undone.'}`,
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
