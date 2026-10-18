// Settings form: each change is validated in the main process and saved to
// SQLite immediately.

import { api, store } from './store.js';
import { $, $$, h, radioGroup, toast, toastError, confirmAction } from './ui.js';
import { playAlarm } from './audio.js';
import { registerPage } from './navigation.js';
import { plural, dateShort } from './format.js';

let themeRadios;

function applyAppearance(s) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--glow', String(s.glowIntensity / 100));
  root.classList.toggle('reduce-motion', s.reduceMotion);
}

function fill(s) {
  const form = $('#settings-form');
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el === document.activeElement && el.type !== 'checkbox') continue; // don't overwrite what the user is typing
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else el.value = String(s[el.name]);
    el.removeAttribute('aria-invalid');
  }
  $$('.field__error', form).forEach((e) => e.remove());
  $('#s-volume-out').textContent = `${s.alarmVolume}%`;
  $('#s-glow-out').textContent = `${s.glowIntensity}%`;
  $('#s-alarm').disabled = !s.soundEnabled;
  $('#s-volume').disabled = !s.soundEnabled;
  themeRadios.set(s.theme);
}

function showFieldError(el, message) {
  el.setAttribute('aria-invalid', 'true');
  const field = el.closest('.field');
  field.querySelector('.field__error')?.remove();
  const id = `${el.id}-error`;
  field.append(h('p.field__error', { id, role: 'alert' }, message));
  el.setAttribute('aria-describedby', id);
}

function clearFieldError(el) {
  el.removeAttribute('aria-invalid');
  el.removeAttribute('aria-describedby');
  el.closest('.field')?.querySelector('.field__error')?.remove();
}

let statusTimer = null;
function saved() {
  const st = $('#settings-status');
  st.textContent = 'Saved';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { st.textContent = ''; }, 1800);
}

async function save(partial, el) {
  try {
    const s = await api.settings.update(partial);
    if (el) clearFieldError(el);
    saved();
    return s;
  } catch (err) {
    if (el) showFieldError(el, err.message.replace(/^\w+ must/, 'Must'));
    else toastError(err);
    return null;
  }
}

function valueOf(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range') return el.value === '' ? NaN : Number(el.value);
  if (el.name === 'weekStart') return Number(el.value);
  return el.value;
}

function backupDescription(sum) {
  const parts = [plural(sum.tasks, 'task'), plural(sum.steps, 'step'), plural(sum.sessions, 'session')];
  let range = '';
  if (sum.firstSessionAt && sum.lastSessionAt) {
    const day = (iso) => { const ms = Date.parse(iso); return `${dateShort(ms)} ${new Date(ms).getFullYear()}`; };
    const a = day(sum.firstSessionAt);
    const b = day(sum.lastSessionAt);
    range = a === b ? ` recorded on ${a}` : ` recorded between ${a} and ${b}`;
  }
  return `${parts[0]}, ${parts[1]} and ${parts[2]}${range} (${plural(sum.pomodoros, 'Pomodoro')})`;
}

async function importDatabase() {
  const btn = $('#s-import');
  btn.disabled = true;
  try {
    if (store.timer && store.timer.status !== 'idle') {
      toastError(new Error('Finish or reset the current session before importing a backup.'));
      return;
    }
    let picked;
    try {
      picked = await api.data.pickImport();
    } catch (err) {
      toastError(new Error(`Import failed: ${err.message}`));
      return;
    }
    if (!picked.selected) return;

    const ok = await confirmAction({
      title: 'Replace your current data?',
      text: `"${picked.fileName}" contains ${backupDescription(picked.summary)}. `
        + 'Importing it replaces all tasks, steps, history and settings currently in Focus Neon. '
        + 'A safety copy of your current data is saved automatically first.',
      ok: 'Import and replace',
    });
    if (!ok) { api.data.cancelImport().catch(() => {}); return; }

    try {
      const res = await api.data.applyImport();
      toast(`Backup imported: ${backupDescription(res.summary)}. Your previous data was saved to ${res.safetyBackup}`, { timeout: 12000 });
    } catch (err) {
      toastError(new Error(`Import failed, your current data was not changed. ${err.message}`));
    }
  } finally {
    btn.disabled = false;
  }
}

export function initSettings() {
  const form = $('#settings-form');

  themeRadios = radioGroup($('.swatches'), 'themeChoice', (theme) => save({ theme }));

  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.name === 'alarmVolume') $('#s-volume-out').textContent = `${el.value}%`;
    if (el.name === 'glowIntensity') {
      $('#s-glow-out').textContent = `${el.value}%`;
      document.documentElement.style.setProperty('--glow', String(el.value / 100)); // live preview
    }
  });

  form.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.name) return;
    save({ [el.name]: valueOf(el) }, el);
  });

  form.addEventListener('submit', (e) => e.preventDefault());

  $('#s-test-sound').addEventListener('click', async () => {
    const ok = await playAlarm({ sound: $('#s-alarm').value, volume: Number($('#s-volume').value) });
    if (!ok) toastError(new Error('Sound could not be played. Check that your system volume is on.'));
  });

  $('#s-export').addEventListener('click', async () => {
    try {
      const r = await api.data.exportCsv();
      if (r.saved) toast(`Exported to ${r.filePath}`);
    } catch (err) { toastError(err); }
  });
  $('#s-backup').addEventListener('click', async () => {
    try {
      const r = await api.data.backup();
      if (r.saved) toast(`Backup saved to ${r.filePath}`);
    } catch (err) { toastError(err); }
  });
  $('#s-import').addEventListener('click', importDatabase);
  $('#s-reveal').addEventListener('click', () => api.data.revealDatabase().catch(toastError));
  $('#s-defaults').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Restore default settings?',
      text: 'Timer lengths, alarm, goal and appearance go back to their defaults. Your sessions and tasks are not affected.',
      ok: 'Restore defaults', danger: false,
    });
    if (!ok) return;
    try { await api.settings.reset(); toast('Default settings restored.'); } catch (err) { toastError(err); }
  });
  $('#s-clear').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Delete all sessions and tasks?',
      text: 'Your whole history, every task and all statistics will be permanently deleted. Settings are kept. Consider backing up the database first.',
      ok: 'Delete everything',
    });
    if (!ok) return;
    try { await api.data.clearAll(); toast('All sessions and tasks were deleted.'); } catch (err) { toastError(err); }
  });

  store.on('settings', (s) => { applyAppearance(s); fill(s); });
  registerPage('settings', {
    onShow: async () => {
      try {
        const info = await api.app.info();
        $('#s-db-path').textContent = `Your data is stored in a local SQLite database: ${info.dbPath}`;
      } catch (_) { /* non-essential */ }
    },
  });
}

export { applyAppearance };
