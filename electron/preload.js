'use strict';

/**
 * The only bridge between the UI and the main process. The renderer gets a
 * small set of named operations — never raw SQL, file system or Node access.
 */

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.data;
  const err = new Error((res && res.error) || 'Something went wrong.');
  err.code = res && res.code;
  throw err;
}

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('pomodoro', {
  timer: {
    getState: () => call('timer:getState'),
    start: () => call('timer:start'),
    pause: () => call('timer:pause'),
    resume: () => call('timer:resume'),
    reset: () => call('timer:reset'),
    skip: () => call('timer:skip'),
    setMode: (mode) => call('timer:setMode', mode),
    setTask: (taskId) => call('timer:setTask', taskId),
    onState: (cb) => subscribe('timer:state', cb),
    onCompleted: (cb) => subscribe('timer:completed', cb),
    onNotice: (cb) => subscribe('timer:notice', cb),
  },
  tasks: {
    list: (status) => call('tasks:list', status),
    create: (task) => call('tasks:create', task),
    update: (id, task) => call('tasks:update', id, task),
    setStatus: (id, status) => call('tasks:setStatus', id, status),
    remove: (id) => call('tasks:delete', id),
    sessions: (id) => call('tasks:sessions', id),
  },
  stats: {
    report: (period, anchor) => call('stats:report', period, anchor),
    today: () => call('stats:today'),
  },
  history: {
    list: (filters) => call('history:list', filters),
  },
  settings: {
    get: () => call('settings:get'),
    update: (partial) => call('settings:update', partial),
    reset: () => call('settings:reset'),
    onChanged: (cb) => subscribe('settings:changed', cb),
  },
  data: {
    exportCsv: () => call('data:exportCsv'),
    backup: () => call('data:backup'),
    clearAll: () => call('data:clearAll'),
    revealDatabase: () => call('data:reveal'),
    onChanged: (cb) => subscribe('data:changed', cb),
  },
  app: {
    info: () => call('app:info'),
    onNavigate: (cb) => subscribe('app:navigate', cb),
  },
});
