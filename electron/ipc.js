'use strict';

const fs = require('fs');
const path = require('path');
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

/** {from, to} in ms; either may be missing (open-ended). */
function cleanRange(r) {
  const out = {};
  if (r.from !== undefined && r.from !== null) {
    out.from = Number(r.from);
    if (!Number.isFinite(out.from)) throw new Error('Invalid start of range.');
  }
  if (r.to !== undefined && r.to !== null) {
    out.to = Number(r.to);
    if (!Number.isFinite(out.to)) throw new Error('Invalid end of range.');
  }
  if (out.from !== undefined && out.to !== undefined && out.from > out.to) throw new Error('The start date is after the end date.');
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function registerIpc(svc, { getWindow, dbPath, onSettingsChanged, startupInfo }) {
  const { engine, tasksRepo, sessionsRepo, settingsRepo, stepsRepo, tagsRepo, notesRepo, goalsRepo } = svc;
  let pendingImport = null; // validated backup waiting for the user's confirmation
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
    return svc.listTasks(status);
  });
  handle('tasks:create', (_e, t = {}) => {
    const task = tasksRepo.create({
      title: t.title, description: t.description, estimatedPomodoros: t.estimatedPomodoros,
      scheduledDate: t.scheduledDate, goalId: t.goalId,
    });
    if (Array.isArray(t.tagIds) && t.tagIds.length) tagsRepo.setTaskTags(task.id, t.tagIds);
    dataChanged();
    return task;
  });
  handle('tasks:update', (_e, id, t = {}) => {
    const task = tasksRepo.update(id, {
      title: t.title, description: t.description, estimatedPomodoros: t.estimatedPomodoros,
      scheduledDate: t.scheduledDate, goalId: t.goalId,
    });
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

  // ---- tags
  handle('tags:list', () => tagsRepo.list());
  handle('tags:create', (_e, t = {}) => { const tag = tagsRepo.create({ name: t.name, color: t.color }); dataChanged(); return tag; });
  handle('tags:update', (_e, id, t = {}) => {
    const tag = tagsRepo.update(id, { name: t.name, color: t.color });
    dataChanged();
    return tag;
  });
  handle('tags:delete', (_e, id) => { const ok = tagsRepo.delete(id); dataChanged(); return ok; });
  handle('tasks:setTags', (_e, taskId, tagIds, opts = {}) => {
    const r = tagsRepo.setTaskTags(taskId, tagIds, { applyToPast: opts.applyToPast === true });
    dataChanged();
    return r;
  });
  handle('tasks:pastSessions', (_e, taskId) => tagsRepo.pastSessionCount(taskId));

  // ---- agenda & notes
  handle('agenda:days', (_e, startDate, count) => svc.agendaDays(startDate, count));
  handle('agenda:years', () => svc.agendaYears());
  handle('notes:save', (_e, date, body) => { const n = notesRepo.save(date, body); dataChanged(); return n; });
  handle('notes:delete', (_e, date) => { const ok = notesRepo.delete(date); dataChanged(); return ok; });

  // ---- activity statistics
  handle('activity:stats', (_e, range = {}) => svc.activityStats(cleanRange(range)));
  handle('activity:detail', (_e, tagId, range = {}) => svc.activityDetail(tagId, cleanRange(range)));

  // ---- goals
  handle('goals:list', (_e, year) => svc.listGoals(year));
  handle('goals:years', () => svc.goalYears());
  handle('goals:options', () => goalsRepo.all());
  handle('goals:create', (_e, g = {}) => { const r = goalsRepo.create(g); dataChanged(); return r; });
  handle('goals:update', (_e, id, g = {}) => { const r = goalsRepo.update(id, g); dataChanged(); return r; });
  handle('goals:setCompleted', (_e, id, done) => { const r = goalsRepo.setCompleted(id, done === true); dataChanged(); return r; });
  handle('goals:delete', (_e, id) => { const r = goalsRepo.delete(id); dataChanged(); return r; });
  handle('milestones:create', (_e, goalId, title) => { goalsRepo.addMilestone(goalId, title); dataChanged(); return true; });
  handle('milestones:update', (_e, id, m = {}) => {
    goalsRepo.updateMilestone(id, { title: m.title, status: m.status, doneOn: m.doneOn });
    dataChanged();
    return true;
  });
  handle('milestones:delete', (_e, id) => { goalsRepo.deleteMilestone(id); dataChanged(); return true; });

  // ---- task steps (each call returns the task's full, ordered step list)
  handle('steps:create', (_e, taskId, title) => stepsRepo.create(taskId, title));
  handle('steps:rename', (_e, stepId, title) => stepsRepo.rename(stepId, title));
  handle('steps:setCompleted', (_e, stepId, completed) => stepsRepo.setCompleted(stepId, completed === true));
  handle('steps:delete', (_e, stepId) => stepsRepo.delete(stepId));

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
      defaultPath: `focus-neon-sessions-${stamp()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, svc.exportCsv(), 'utf8');
    return { saved: true, filePath };
  });
  handle('data:backup', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'Back up database',
      defaultPath: `focus-neon-backup-${stamp()}.sqlite`,
      filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
    });
    if (canceled || !filePath) return { saved: false };
    svc.db.backupTo(filePath);
    return { saved: true, filePath };
  });
  // Import, step 1: pick a file and validate it in memory. Nothing changes yet.
  handle('data:importPick', async () => {
    pendingImport = null;
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'Import a Focus Neon backup',
      properties: ['openFile'],
      filters: [
        { name: 'Focus Neon backup', extensions: ['sqlite', 'db', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths[0]) return { selected: false };
    const filePath = filePaths[0];
    if (path.resolve(filePath) === path.resolve(dbPath)) {
      throw new Error('That is the database the app is using right now. Choose a backup file instead.');
    }
    let bytes;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      throw new Error(`The file could not be read (${err.code || err.message}).`);
    }
    const prepared = await svc.prepareImport(bytes);
    pendingImport = { prepared, fileName: path.basename(filePath) };
    return { selected: true, fileName: pendingImport.fileName, summary: prepared.summary };
  });

  // Import, step 2: after the user confirms, back up the current data and swap.
  handle('data:importApply', () => {
    if (!pendingImport) throw new Error('Choose a backup file first.');
    const { prepared, fileName } = pendingImport;
    pendingImport = null;
    const result = svc.applyImport(prepared, { safetyDir: path.join(path.dirname(dbPath), 'backups') });
    const settings = settingsRepo.getAll();
    onSettingsChanged(settings);
    broadcast('settings:changed', settings);
    dataChanged();
    return { ...result, fileName };
  });
  handle('data:importCancel', () => { pendingImport = null; return true; });

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
    carriedOverFrom: startupInfo.carriedOverFrom || null,
    secondsPerMinute: startupInfo.secondsPerMinute,
  }));

  return { broadcast, dataChanged };
}

module.exports = { registerIpc, broadcast };
