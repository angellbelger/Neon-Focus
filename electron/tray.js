'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const LABEL = { focus: 'Focus', short_break: 'Short break', long_break: 'Long break' };

function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Menu-bar / system-tray presence: remaining time and quick controls. */
function createTray({ engine, settings, showWindow, quit }) {
  let tray;
  try {
    const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icons', file));
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
  } catch (err) {
    console.warn('[tray] unavailable:', err.message);
    return null;
  }

  let showTimer = settings.trayTimer;
  let lastMenuKey = '';
  let lastTitle = '';

  function buildMenu(s) {
    const running = s.status === 'running';
    const active = s.status !== 'idle';
    return Menu.buildFromTemplate([
      { label: `${LABEL[s.mode]}: ${fmt(s.plannedMs - s.elapsedMs)}`, enabled: false },
      { type: 'separator' },
      {
        label: running ? 'Pause' : active ? 'Resume' : `Start ${LABEL[s.mode].toLowerCase()}`,
        click: () => (running ? engine.pause() : engine.start()),
      },
      { label: 'Reset', enabled: active, click: () => engine.reset() },
      { label: 'Skip to next', click: () => engine.skip() },
      { type: 'separator' },
      { label: 'Open Neon Pomodoro', click: () => showWindow('focus') },
      { label: 'Dashboard', click: () => showWindow('dashboard') },
      { type: 'separator' },
      { label: 'Quit', role: 'quit', click: quit },
    ]);
  }

  function update(s) {
    const remaining = fmt(s.plannedMs - s.elapsedMs);
    const title = showTimer && s.status !== 'idle' ? ` ${remaining}` : '';
    if (title !== lastTitle) {
      if (process.platform === 'darwin') tray.setTitle(title, { fontType: 'monospacedDigit' });
      lastTitle = title;
    }
    tray.setToolTip(`Neon Pomodoro — ${LABEL[s.mode]} ${s.status === 'idle' ? 'ready' : remaining}`);
    const key = `${s.status}|${s.mode}|${Math.ceil((s.plannedMs - s.elapsedMs) / 60000)}`;
    if (key !== lastMenuKey) {
      tray.setContextMenu(buildMenu(s));
      lastMenuKey = key;
    }
  }

  function applySettings(next) {
    showTimer = next.trayTimer;
    lastTitle = null;
    update(engine.getState());
  }

  tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
  update(engine.getState());
  return { update, applySettings, tray };
}

module.exports = { createTray };
