// Focus page: the dial, controls, task chip and today's progress.

import { store, api } from './store.js';
import { $, $$, h, radioGroup, confirmAction, toastError, isTyping } from './ui.js';
import { clock, duration, MODE_LABEL } from './format.js';
import { navigate, currentPage, onPageChange } from './navigation.js';

const TICKS = 60;
const R_ARC = 168;
const CIRC = 2 * Math.PI * R_ARC;

let tickEls = [];
let lastLit = -1;
let lastText = '';
let rafId = null;
let dismissedBanner = null;
let modeRadios;

function buildDial() {
  const g = $('#dial-ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < TICKS; i += 1) {
    const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
    const major = i % 5 === 0;
    const r1 = major ? 176 : 179;
    const r2 = 192;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (200 + Math.cos(a) * r1).toFixed(2));
    line.setAttribute('y1', (200 + Math.sin(a) * r1).toFixed(2));
    line.setAttribute('x2', (200 + Math.cos(a) * r2).toFixed(2));
    line.setAttribute('y2', (200 + Math.sin(a) * r2).toFixed(2));
    line.setAttribute('class', `tick${major ? ' tick--major' : ''}`);
    g.append(line);
    tickEls.push(line);
  }
  const arc = $('#dial-arc');
  arc.style.strokeDasharray = `${CIRC}`;
}

/** Per-frame update: only touches the DOM when something visible changed. */
function frame() {
  rafId = null;
  const s = store.timer;
  if (!s) return;
  const remaining = store.remainingMs();
  const fraction = s.plannedMs ? remaining / s.plannedMs : 1;

  const text = clock(remaining);
  if (text !== lastText) {
    lastText = text;
    $('#dial-time').textContent = text;
    $('#rail-mini-time').textContent = text;
    document.title = s.status === 'idle' ? 'Neon Pomodoro' : `${text} ${MODE_LABEL[s.mode]} — Neon Pomodoro`;
  }

  // Lit tubes = remaining time, switching off clockwise from the top.
  const lit = Math.ceil(fraction * TICKS - 1e-9);
  if (lit !== lastLit) {
    lastLit = lit;
    tickEls.forEach((el, i) => {
      el.classList.toggle('is-lit', i < lit);
      el.classList.toggle('is-head', s.status !== 'idle' && i === lit - 1);
    });
  }

  $('#dial-arc').style.strokeDashoffset = String(CIRC * (1 - fraction));

  if (s.status === 'running') schedule();
}

function schedule() {
  if (rafId === null) rafId = requestAnimationFrame(frame);
}

function renderState(s) {
  document.body.dataset.mode = s.mode;
  document.body.dataset.status = s.status;
  lastText = '';
  lastLit = -1;

  const active = s.status !== 'idle';
  modeRadios.set(s.mode);
  for (const b of $$('.mode-switch [role="radio"]')) b.disabled = active;

  $('#dial-mode').textContent = MODE_LABEL[s.mode];
  $('#dial-state').textContent = s.status === 'running' ? (s.mode === 'focus' ? 'Stay with it' : 'Step away from the screen')
    : s.status === 'paused' ? 'Paused' : 'Ready';

  const label = s.status === 'running' ? 'Pause' : s.status === 'paused' ? 'Resume' : 'Start';
  $('#btn-main-label').textContent = label;
  $('#btn-main').setAttribute('aria-label', `${label} ${MODE_LABEL[s.mode].toLowerCase()}`);
  $('#btn-reset').disabled = !active;

  // cycle indicator
  const cycle = $('#cycle');
  cycle.replaceChildren();
  const n = s.longBreakInterval;
  const done = Math.min(s.focusDone, n);
  for (let i = 0; i < n; i += 1) {
    const cls = i < done ? 'is-done' : (i === done && s.mode === 'focus' ? 'is-current' : '');
    cycle.append(h('li', { class: cls || null }));
  }
  cycle.setAttribute('aria-label', `${done} of ${n} focus sessions done before the long break`);

  // task chip
  const chip = $('#task-chip');
  const t = s.task;
  chip.disabled = s.mode !== 'focus';
  chip.dataset.hasTask = String(Boolean(t));
  $('#task-chip-label').textContent = s.mode !== 'focus' ? 'Breaks are not linked to tasks'
    : t ? t.title : 'No task selected';
  $('#task-chip-count').textContent = t && s.mode === 'focus'
    ? (t.estimatedPomodoros ? `${t.completedPomodoros}/${t.estimatedPomodoros}` : `${t.completedPomodoros}`)
    : '';
  chip.setAttribute('aria-label', t && s.mode === 'focus' ? `Current task: ${t.title}. Change task` : 'Choose a task');

  // rail mini timer
  const mini = $('#rail-mini');
  mini.hidden = !active || currentPage() === 'focus';
  mini.dataset.paused = String(s.status === 'paused');
  $('#rail-mini-mode').textContent = s.status === 'paused' ? 'Paused' : MODE_LABEL[s.mode];

  renderBanner(s);
  frame();
}

function renderBanner(s) {
  const banner = $('#focus-banner');
  const text = $('#focus-banner-text');
  const action = $('#focus-banner-action');
  let msg = null;
  let key = null;
  let kind = 'info';
  let act = null;

  if (s.notice) {
    key = `notice-${s.notice.at}`;
    msg = s.notice.message;
    kind = 'warning';
    if (s.status === 'paused') act = { label: 'Resume', fn: () => api.timer.resume() };
  } else if (s.lastCompletion) {
    const c = s.lastCompletion;
    key = `done-${c.runId}`;
    const what = c.sessionType === 'focus' ? 'Focus session complete.' : `${MODE_LABEL[c.sessionType]} over.`;
    const next = MODE_LABEL[c.nextMode].toLowerCase();
    if (c.autoStarted && s.status !== 'idle') {
      msg = `${what} Your ${next} has started.`;
    } else if (s.status === 'idle') {
      msg = `${what} Your ${next} is ready.`;
      act = { label: `Start ${next}`, fn: () => api.timer.start() };
    }
  }

  if (!msg || key === dismissedBanner) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.dataset.key = key;
  text.textContent = msg;
  action.hidden = !act;
  if (act) {
    action.textContent = act.label;
    action.onclick = () => act.fn().catch(toastError);
  }
}

function renderToday(t) {
  if (!t) return;
  $('#today-pomodoros').textContent = String(t.pomodoros);
  $('#today-focus').textContent = duration(t.focusSeconds);
  $('#today-goal-text').textContent = t.pomodoros >= t.dailyGoal
    ? `${t.pomodoros} of ${t.dailyGoal}, goal reached`
    : `${t.pomodoros} of ${t.dailyGoal}`;
  const bar = $('#today-goal-bar');
  bar.setAttribute('aria-valuemax', String(t.dailyGoal));
  bar.setAttribute('aria-valuenow', String(Math.min(t.pomodoros, t.dailyGoal)));
  bar.dataset.met = String(t.pomodoros >= t.dailyGoal);
  $('#today-goal-fill').style.width = `${Math.min(1, t.progress) * 100}%`;
}

async function mainAction() {
  const s = store.timer;
  try {
    if (s.status === 'running') await api.timer.pause();
    else await api.timer.start(); // start() resumes a paused session
  } catch (err) { toastError(err); }
}

async function resetAction() {
  const s = store.timer;
  if (s.status === 'idle') return;
  const elapsed = s.plannedMs - store.remainingMs();
  if (elapsed > 60000) {
    const ok = await confirmAction({
      title: 'Reset this session?',
      text: `It will be saved in your history as interrupted and will not count as a ${s.mode === 'focus' ? 'Pomodoro' : 'completed break'}.`,
      ok: 'Reset session',
    });
    if (!ok) return;
  }
  try { await api.timer.reset(); } catch (err) { toastError(err); }
}

async function skipAction() {
  const s = store.timer;
  if (s.status !== 'idle' && s.plannedMs - store.remainingMs() > 60000) {
    const ok = await confirmAction({
      title: 'Skip to the next session?',
      text: 'The current session will be saved as skipped and will not count as completed.',
      ok: 'Skip session',
    });
    if (!ok) return;
  }
  try { await api.timer.skip(); } catch (err) { toastError(err); }
}

async function openTaskPicker() {
  const dlg = $('#task-picker');
  const list = $('#task-picker-list');
  let tasks = [];
  try { tasks = await api.tasks.list('active'); } catch (err) { toastError(err); return; }
  const selected = store.timer.selectedTaskId;
  const pick = async (id) => {
    dlg.close();
    try { await api.timer.setTask(id); } catch (err) { toastError(err); }
  };
  list.replaceChildren(
    h('li', {}, h('button', { type: 'button', 'aria-current': selected === null ? 'true' : null, onclick: () => pick(null) },
      h('span.muted', {}, 'No task'), h('span.count', {}, ''))),
    ...tasks.map((t) => h('li', {}, h('button', {
      type: 'button', 'aria-current': t.id === selected ? 'true' : null, onclick: () => pick(t.id),
    }, h('span', {}, t.title), h('span.count', {}, t.estimated_pomodoros ? `${t.completed_pomodoros}/${t.estimated_pomodoros}` : `${t.completed_pomodoros}`)))),
  );
  if (!tasks.length) {
    list.append(h('li', {}, h('p.muted', { style: 'padding: 6px 14px; font-size: .875rem' }, 'You have no active tasks yet. Focus sessions without a task still count.')));
  }
  dlg.showModal();
  const current = list.querySelector('[aria-current="true"]') || list.querySelector('button');
  if (current) current.focus();
}

export function initTimer() {
  buildDial();
  if (store.settings) $('#dial-ticks').classList.toggle('is-glowing', store.settings.glowIntensity > 0);

  modeRadios = radioGroup($('.mode-switch'), 'mode', (mode) => {
    if (store.timer && store.timer.status === 'idle' && store.timer.mode !== mode) {
      api.timer.setMode(mode).catch(toastError);
    }
  });

  $('#btn-main').addEventListener('click', mainAction);
  $('#btn-reset').addEventListener('click', resetAction);
  $('#btn-skip').addEventListener('click', skipAction);
  $('#task-chip').addEventListener('click', openTaskPicker);
  $('#task-picker-manage').addEventListener('click', () => { $('#task-picker').close(); navigate('tasks'); });
  $('#focus-banner-close').addEventListener('click', () => {
    dismissedBanner = $('#focus-banner').dataset.key;
    $('#focus-banner').hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || document.querySelector('dialog[open]')) return;
    if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); mainAction(); }
    else if (e.key === 'r' || e.key === 'R') resetAction();
    else if (e.key === 's' || e.key === 'S') skipAction();
  });

  store.on('timer', renderState);
  store.on('today', renderToday);
  store.on('settings', (st) => $('#dial-ticks').classList.toggle('is-glowing', st.glowIntensity > 0));
  onPageChange(() => store.timer && renderState(store.timer));

  // Keep the countdown correct after the window was hidden.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) frame(); });
}
