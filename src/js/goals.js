// Yearly Goals, after the "Metas e objetivos" page of the Cambridge planner:
// each goal has a start, a completion date, an action plan, milestones
// (◆ done, ◇ pending, struck through when dropped) and a neon-green
// progress bar from 0 to 100 %.

import { api } from './store.js';
import { $, h, radioGroup, toast, toastError, confirmAction, icon, ICONS } from './ui.js';
import { hoursMinutes, dateKeyToMs, plural } from './format.js';
import { registerPage, currentPage } from './navigation.js';
import { loadTags } from './tags.js';

const LOCALE = 'en-GB';
const state = { year: new Date().getFullYear(), years: [], goals: [], filter: 'all', addingFor: null };

function monthLabel(m) {
  if (!m) return null;
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' });
}

function dateLabel(d) {
  return d ? new Date(dateKeyToMs(d)).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;
}

function progressBar(g) {
  const pct = g.progress.percent;
  let detail;
  if (g.progress_mode === 'activity') {
    detail = `${hoursMinutes(g.progress.seconds)} of ${hoursMinutes(g.progress.targetSeconds)}${g.tag ? ` on ${g.tag.name}` : ''} in ${g.year}`;
  } else {
    detail = g.progress.label;
  }
  const bar = h('div.evo', {},
    h('span.evo__label', {}, 'Progress'),
    h('div.evo__track', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `Progress of ${g.title}` },
      h('span.evo__fill', { style: `width:${pct}%` }),
      h('span.evo__ticks', { 'aria-hidden': 'true' }, ['0%', '20%', '40%', '60%', '80%', '100%'].map((t) => h('span', {}, t)))),
    h('span.evo__pct', {}, `${pct}%`));
  const parts = [bar, h('p.evo__detail', {}, detail)];
  if (g.progress_mode === 'manual' && !g.completed_at) {
    const range = h('input.evo__slider', {
      type: 'range', min: '0', max: '100', step: '5', value: String(g.manual_progress), 'aria-label': `Set progress of ${g.title}`,
      onchange: async (e) => {
        try {
          await api.goals.update(g.id, { manualProgress: Number(e.target.value) });
          toast(`Progress set to ${e.target.value}%.`);
        } catch (err) { toastError(err); }
      },
      oninput: (e) => {
        const card = e.target.closest('.goal');
        card.querySelector('.evo__fill').style.width = `${e.target.value}%`;
        card.querySelector('.evo__pct').textContent = `${e.target.value}%`;
      },
    });
    parts.push(h('label.evo__manual', {}, 'Update progress', range));
  }
  return parts;
}

function milestoneItem(g, m) {
  const glyph = m.status === 'done' ? '◆' : '◇';
  const next = m.status === 'pending' ? 'done' : 'pending';
  return h('li.ms', { dataset: { status: m.status } },
    h('button.ms__mark', {
      type: 'button',
      title: m.status === 'done' ? 'Mark as not done' : m.status === 'dropped' ? 'Restore milestone' : 'Mark as done',
      'aria-label': `${m.title}: ${m.status === 'done' ? 'done, mark as not done' : m.status === 'dropped' ? 'dropped, restore' : 'mark as done'}`,
      onclick: () => setMilestone(m.id, { status: m.status === 'dropped' ? 'pending' : next }),
    }, glyph),
    h('button.ms__title', {
      type: 'button', title: 'Click to rename',
      onclick: (e) => renameMilestoneInline(e.currentTarget, m),
    }, m.title),
    m.done_on && m.status === 'done' ? h('span.ms__date', {}, dateLabel(m.done_on)) : null,
    h('span.ms__actions', {},
      h('button.ms__btn', {
        type: 'button', title: m.status === 'dropped' ? 'Restore' : 'Drop (no longer pursuing)',
        onclick: () => setMilestone(m.id, { status: m.status === 'dropped' ? 'pending' : 'dropped' }),
      }, m.status === 'dropped' ? 'Restore' : 'Drop'),
      h('button.ms__btn.ms__btn--danger', {
        type: 'button', title: 'Delete milestone', 'aria-label': `Delete milestone ${m.title}`,
        onclick: () => removeMilestone(m),
      }, '×')));
}

function renameMilestoneInline(titleEl, m) {
  const input = h('input.ms__edit', { type: 'text', maxlength: '200', value: m.title, 'aria-label': 'Milestone name' });
  const done = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== m.title) await setMilestone(m.id, { title: input.value });
    else load();
  };
  let finished = false;
  const finish = (save) => { if (!finished) { finished = true; done(save); } };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function goalCard(g) {
  const completed = Boolean(g.completed_at);
  const adding = state.addingFor === g.id;
  return h('li.goal', { dataset: { id: String(g.id), completed: String(completed) } },
    h('header.goal__head', {},
      h('h2.goal__title', {}, h('span.goal__diamond', { 'aria-hidden': 'true' }, '◆'), g.title),
      completed ? h('span.goal__badge', {}, 'Completed') : h('span.goal__badge.goal__badge--progress', {}, 'In Progress'),
      h('div.goal__tools', {},
        h('button.btn.btn--small.btn--ghost', { type: 'button', onclick: () => setCompleted(g, !completed) }, completed ? 'Reopen' : 'Mark as achieved'),
        h('button.icon-btn', { type: 'button', title: 'Edit goal', 'aria-label': `Edit goal ${g.title}`, onclick: () => openGoalEditor(g) }, icon(ICONS.edit)),
        h('button.icon-btn.icon-btn--danger', { type: 'button', title: 'Delete goal', 'aria-label': `Delete goal ${g.title}`, onclick: () => removeGoal(g) }, icon(ICONS.trash)))),
    h('dl.goal__dates', {},
      h('div', {}, h('dt', {}, 'Start'), h('dd', {}, monthLabel(g.start_month) || '—')),
      h('div', {}, h('dt', {}, 'Completion'), h('dd', {}, completed
        ? new Date(Date.parse(g.completed_at)).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' })
        : (g.target_date ? `Target ${dateLabel(g.target_date)}` : '—')))),
    h('div.goal__cols', {},
      h('section.goal__plan', { 'aria-label': 'Action plan' },
        h('h3', {}, 'Action plan'),
        g.action_plan ? h('p.goal__plan-text', {}, g.action_plan) : h('p.goal__plan-text.muted', {}, 'No plan written yet.'),
        g.linked.total ? h('p.goal__linked', {}, `${plural(g.linked.total, 'linked task')}, ${g.linked.done} done`) : null),
      h('section.goal__ms', { 'aria-label': 'Milestones' },
        h('h3', {}, 'Milestones'),
        h('ul.ms-list', {}, g.milestones.map((m) => milestoneItem(g, m))),
        adding
          ? h('div.ms-add', {}, h('span.ms__mark', { 'aria-hidden': 'true' }, '◇'), h('input.ms__edit', {
            type: 'text', maxlength: '200', placeholder: 'New milestone', 'aria-label': `New milestone for ${g.title}`, 'data-add-ms': String(g.id),
            onkeydown: (e) => {
              if (e.key === 'Enter') { e.preventDefault(); addMilestone(g, e.target); }
              if (e.key === 'Escape') { e.preventDefault(); state.addingFor = null; render(); }
            },
          }))
          : h('button.ms-add__btn', { type: 'button', onclick: () => { state.addingFor = g.id; render(); } }, '+ Add milestone'))),
    ...progressBar(g));
}

function render() {
  const visible = state.goals.filter((g) => state.filter === 'all'
    || (state.filter === 'completed' ? g.completed_at : !g.completed_at));
  $('#goal-list').replaceChildren(...visible.map(goalCard));
  $('#goal-empty').hidden = visible.length > 0;
  $('#goal-empty-title').textContent = state.goals.length
    ? (state.filter === 'completed' ? 'No completed goals yet' : 'All goals for this year are completed')
    : `No goals for ${state.year} yet`;
  $('#goals-heading').textContent = `Yearly Goals ${state.year}`;
  $('#goal-years').replaceChildren(...state.years.map((y) => h('li', {}, h('button.planner.planner--small', {
    type: 'button', 'aria-current': y === state.year ? 'true' : null,
    onclick: () => { state.year = y; load(); },
  }, h('span.planner__year', {}, String(y))))));
  if (state.addingFor) {
    const input = document.querySelector(`[data-add-ms="${state.addingFor}"]`);
    if (input) input.focus();
  }
}

async function load() {
  try {
    const [years, goals] = await Promise.all([api.goals.years(), api.goals.list(state.year)]);
    state.years = years.includes(state.year) ? years : [...years, state.year].sort((a, b) => a - b);
    state.goals = goals;
    render();
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ actions

async function setMilestone(id, patch) {
  try { await api.goals.updateMilestone(id, patch); } catch (err) { toastError(err); load(); }
}

async function addMilestone(g, input) {
  const title = input.value.trim();
  if (!title || input.dataset.busy) return;
  input.dataset.busy = '1';
  try {
    await api.goals.addMilestone(g.id, title);
    toast('Milestone added.');
  } catch (err) { toastError(err); delete input.dataset.busy; }
}

async function removeMilestone(m) {
  const ok = await confirmAction({ title: 'Delete this milestone?', text: `"${m.title}" will be removed from the goal.`, ok: 'Delete milestone' });
  if (!ok) return;
  try { await api.goals.removeMilestone(m.id); toast('Milestone deleted.'); } catch (err) { toastError(err); }
}

async function setCompleted(g, done) {
  try {
    await api.goals.setCompleted(g.id, done);
    toast(done ? `"${g.title}" marked as achieved.` : `"${g.title}" is in progress again.`);
  } catch (err) { toastError(err); }
}

async function removeGoal(g) {
  const ok = await confirmAction({
    title: `Delete the goal "${g.title}"?`,
    text: `Its milestones are deleted too.${g.linked.total ? ` ${plural(g.linked.total, 'linked task')} will stay in Tasks without a goal.` : ''}`,
    ok: 'Delete goal',
  });
  if (!ok) return;
  try { await api.goals.remove(g.id); toast('Goal deleted.'); } catch (err) { toastError(err); }
}

async function openGoalEditor(g = null) {
  const dlg = $('#goal-editor');
  const form = $('#goal-editor-form');
  const err = $('#goal-editor-error');
  err.hidden = true;
  $('#goal-editor-title').textContent = g ? 'Edit goal' : 'New goal';
  const tags = await loadTags(true);
  form.elements.tag.replaceChildren(h('option', { value: '' }, tags.length ? 'Choose a tag' : 'Create a tag in Tasks first'),
    ...tags.map((t) => h('option', { value: String(t.id) }, t.name)));

  form.elements.title.value = g ? g.title : '';
  form.elements.year.value = String(g ? g.year : state.year);
  form.elements.start.value = g && g.start_month ? g.start_month : '';
  form.elements.target.value = g && g.target_date ? g.target_date : '';
  form.elements.plan.value = g ? g.action_plan : '';
  const mode = g ? g.progress_mode : 'milestones';
  for (const r of form.elements.mode) r.checked = r.value === mode;
  form.elements.tag.value = g && g.tag_id ? String(g.tag_id) : '';
  form.elements.hours.value = g && g.target_minutes ? String(Math.round(g.target_minutes / 60)) : '';
  form.elements.manual.value = String(g ? g.manual_progress : 0);
  $('#goal-manual-out').textContent = `${form.elements.manual.value}%`;

  const sync = () => {
    const m = [...form.elements.mode].find((r) => r.checked).value;
    $('#goal-activity-fields').hidden = m !== 'activity';
    $('#goal-manual-field').hidden = m !== 'manual';
  };
  sync();
  for (const r of form.elements.mode) r.onchange = sync;
  form.elements.manual.oninput = () => { $('#goal-manual-out').textContent = `${form.elements.manual.value}%`; };

  dlg.showModal();
  form.elements.title.focus();
  form.onsubmit = async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const m = [...form.elements.mode].find((r) => r.checked).value;
    const payload = {
      title: form.elements.title.value,
      year: Number(form.elements.year.value),
      startMonth: form.elements.start.value || null,
      targetDate: form.elements.target.value || null,
      actionPlan: form.elements.plan.value,
      progressMode: m,
      tagId: form.elements.tag.value ? Number(form.elements.tag.value) : null,
      targetHours: form.elements.hours.value === '' ? null : Number(form.elements.hours.value),
      manualProgress: Number(form.elements.manual.value),
    };
    try {
      if (g) await api.goals.update(g.id, payload);
      else await api.goals.create(payload);
      dlg.close();
      if (payload.year !== state.year) { state.year = payload.year; }
      toast(g ? 'Goal saved.' : 'Goal created.');
      load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

export function initGoals() {
  const filter = radioGroup($('.page--goals .segmented'), 'goalFilter', (f) => {
    state.filter = f;
    filter.set(f);
    render();
  });
  filter.set('all');
  $('#goal-new').addEventListener('click', () => openGoalEditor());
  registerPage('goals', { onShow: load });
  api.data.onChanged(() => { if (currentPage() === 'goals') load(); });
}
