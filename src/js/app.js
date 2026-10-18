// Renderer entry point.

import { store, api } from './store.js';
import { toast, toastError } from './ui.js';
import { initNavigation, navigate } from './navigation.js';
import { initTimer } from './timer.js';
import { initDashboard } from './dashboard.js';
import { initTasks } from './tasks.js';
import { initAgenda } from './agenda.js';
import { initGoals } from './goals.js';
import { initHistory } from './history.js';
import { initSettings, applyAppearance } from './settings.js';
import { playAlarm, unlockAudio } from './audio.js';
import { MODE_LABEL } from './format.js';

async function boot() {
  if (!api) return; // env-check.js explains how to open the app

  const [settings, timer] = await Promise.all([api.settings.get(), api.timer.getState()]);
  store.settings = settings;
  applyAppearance(settings);

  initTimer();
  initDashboard();
  initTasks();
  initAgenda();
  initGoals();
  initHistory();
  initSettings();
  initNavigation();

  store.setSettings(settings);
  store.setTimer(timer);
  store.refreshToday().catch(toastError);

  api.timer.onState((s) => store.setTimer(s));
  api.settings.onChanged((s) => store.setSettings(s));
  api.data.onChanged(() => store.refreshToday().catch(() => {}));
  api.app.onNavigate((page) => navigate(page));

  api.timer.onCompleted(async (c) => {
    const s = store.settings;
    if (s.soundEnabled) {
      const ok = await playAlarm({ sound: s.alarmSound, volume: s.alarmVolume });
      if (!ok) toast('The alarm could not play. Check your system sound settings.', { type: 'error' });
    }
    store.refreshToday().catch(() => {});
    if (document.hidden) return;
    if (c.sessionType === 'focus') toast(`Pomodoro complete${c.taskTitle ? ` on "${c.taskTitle}"` : ''}.`);
    else toast(`${MODE_LABEL[c.sessionType]} over.`);
  });

  // Day rollover: refresh today's numbers shortly after midnight.
  let day = new Date().getDate();
  setInterval(() => {
    const d = new Date().getDate();
    if (d !== day) { day = d; store.refreshToday().catch(() => {}); }
  }, 30000);

  const unlock = () => { unlockAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  document.documentElement.dataset.booted = 'true';

  const info = await api.app.info();
  if (info.carriedOverFrom) {
    toast('Welcome to Focus Neon. Your tasks and history from Neon Pomodoro were carried over.', { timeout: 9000 });
  }
  if (info.recoveredFrom) {
    toast(`The database file was damaged and a new one was created. The old file was kept at ${info.recoveredFrom}.`, { type: 'error', timeout: 15000 });
  }
}

boot().catch((err) => {
  console.error(err);
  if (document.documentElement.dataset.booted === 'true') toastError(err);
  else if (window.__showStartupError) window.__showStartupError(err);
});
