'use strict';

const fs = require('fs');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const { PERIODS } = require('../core/stats');
const { cleanId } = require('../core/database/repositories/tasks-repository');

/** Wraps a handler so errors reach the renderer as readable messages. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      return { ok: false, error: friendly(err), code: err.name };
    }
  });
}

function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/SQLITE_CONSTRAINT|constraint failed/i.test(msg)) return 'That change conflicts with saved data and was not applied.';
  if (/ENOSPC/.test(msg)) return 'The disk is full, so your data could not be saved.';
  if (/EACCES|EPERM/.test(msg)) return 'The app does not have permission to write its data file.';
  return msg;
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function registerIpc(svc, { getWindow, dbPath, onSettingsChanged, startupInfo }) {
  const { engine, tasksRepo, sessionsRepo, settingsRepo } = svc;
  const dataChanged = () => broadcast('data:changed', { at: Date.now() });

  // ---- timer
  handle('timer:getState', () => engine.getState());
  handle('timer:start', () => engine.start());
  handle('timer:pause', () => engine.pause());
  handle('timer:resume', () => engine.resume());
  handle('timer:reset', () => { const s = engine.reset(); dataChanged(); return s; });
  handle('timer:skip', () => { const s = engine.skip(); dataChanged(); return s; });
  handle('timer:setMode', (_e, mode) => engine.setMode(String(mode)));
  handle('timer:setTask', (_e, id) => engine.setTask(id === null || id === undefined ? null : cleanId(id)));

  // ---- tasks
  handle('tasks:list', (_e, status = 'all') => {
    if (!['all', 'active', 'completed'].includes(status)) throw new Error('Invalid task filter.');
    return tasksRepo.list({ status });
  });
  handle('tasks:create', (_e, t = {}) => {
    const task = tasksRepo.create({ title: t.title, description: t.description, estimatedPomodoros: t.estimatedPomodoros });
    dataChanged();
    return task;
  });
  handle('tasks:update', (_e, id, t = {}) => {
    const task = tasksRepo.update(id, { title: t.title, description: t.description, estimatedPomodoros: t.estimatedPomodoros });
    engine.emitState();
    dataChanged();
    return task;
  });
  handle('tasks:setStatus', (_e, id, status) => {
    const task = tasksRepo.setStatus(id, status);
    if (status === 'completed' && engine.selectedTaskId() === task.id && !engine.active) engine.setTask(null);
    engine.emitState();
    dataChanged();
    return task;
  });
  handle('tasks:delete', (_e, id) => {
    const taskId = cleanId(id);
    const removed = tasksRepo.delete(taskId);
    engine.onTaskRemoved(taskId);
    dataChanged();
    return removed;
  });
  handle('tasks:sessions', (_e, id) => tasksRepo.sessionsFor(id));

  // ---- stats & history
  handle('stats:report', (_e, period, anchor) => {
    if (!PERIODS.includes(period)) throw new Error('Unknown period.');
    return svc.report({ period, anchor });
  });
  handle('stats:today', () => svc.today());
  handle('history:list', (_e, f = {}) => {
    const fromIso = f.from ? new Date(Number(f.from)).toISOString() : undefined;
    const toIso = f.to ? new Date(Number(f.to)).toISOString() : undefined;
    return sessionsRepo.history({
      fromIso, toIso, type: f.type || 'all', status: f.status || 'all', limit: f.limit, offset: f.offset,
    });
  });

  // ---- settings
  handle('settings:get', () => settingsRepo.getAll());
  handle('settings:update', (_e, partial) => {
    const s = settingsRepo.update(partial);
    engine.refreshSettings();
    onSettingsChanged(s);
    broadcast('settings:changed', s);
    return s;
  });
  handle('settings:reset', () => {
    const s = settingsRepo.resetToDefaults();
    engine.refreshSettings();
    onSettingsChanged(s);
    broadcast('settings:changed', s);
    return s;
  });

  // ---- data management
  handle('data:exportCsv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Export session history',
      defaultPath: `neon-pomodoro-sessions-${stamp()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, svc.exportCsv(), 'utf8');
    return { saved: true, filePath };
  });
  handle('data:backup', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Back up database',
      defaultPath: `neon-pomodoro-backup-${stamp()}.sqlite`,
      filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
    });
    if (canceled || !filePath) return { saved: false };
    svc.db.backupTo(filePath);
    return { saved: true, filePath };
  });
  handle('data:clearAll', () => {
    svc.clearAllData();
    dataChanged();
    return true;
  });
  handle('data:reveal', () => { shell.showItemInFolder(dbPath); return true; });

  handle('app:info', () => ({
    version: app.getVersion(),
    dbPath,
    platform: process.platform,
    recoveredFrom: startupInfo.recoveredFrom || null,
    secondsPerMinute: startupInfo.secondsPerMinute,
  }));

  return { broadcast, dataChanged };
}

module.exports = { registerIpc, broadcast };
