// Shared renderer state: the latest timer snapshot, settings and today's numbers.
// The timer itself runs in the main process; this is only a mirror.

const api = window.pomodoro;

const listeners = { timer: new Set(), settings: new Set(), today: new Set(), data: new Set() };

export const store = {
  timer: null,
  settings: null,
  today: null,

  on(topic, fn) {
    listeners[topic].add(fn);
    return () => listeners[topic].delete(fn);
  },

  emit(topic) {
    for (const fn of listeners[topic]) {
      try { fn(store[topic]); } catch (err) { console.error(err); }
    }
  },

  setTimer(s) { store.timer = s; store.emit('timer'); },
  setSettings(s) { store.settings = s; store.emit('settings'); },

  async refreshToday() {
    store.today = await api.stats.today();
    store.emit('today');
  },

  /** Remaining ms right now, derived from the main-process snapshot. */
  remainingMs() {
    const s = store.timer;
    if (!s) return 0;
    const elapsed = s.status === 'running' ? s.elapsedMs + (Date.now() - s.snapshotAt) : s.elapsedMs;
    return Math.max(0, s.plannedMs - elapsed);
  },

  progress() {
    const s = store.timer;
    if (!s || !s.plannedMs) return 0;
    return 1 - store.remainingMs() / s.plannedMs;
  },
};

export { api };
