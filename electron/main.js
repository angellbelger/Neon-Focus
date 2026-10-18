'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, protocol, net, powerMonitor, Notification, nativeTheme, Menu,
} = require('electron');
const { createServices } = require('../core/services');
const { registerIpc, broadcast } = require('./ipc');
const { createTray } = require('./tray');
const { carryOverLegacyDatabase } = require('./legacy-data');

const APP_NAME = 'Focus Neon';
const APP_ID = 'com.belger.focusneon';

const ROOT = path.join(__dirname, '..');

// Testing aid: FOCUS_NEON_SECONDS_PER_MINUTE=1 makes "25 minutes" last 25 seconds.
const SECONDS_PER_MINUTE = Number(process.env.FOCUS_NEON_SECONDS_PER_MINUTE) || 60;
app.setName(APP_NAME);
if (process.env.FOCUS_NEON_DATA_DIR) app.setPath('userData', path.resolve(process.env.FOCUS_NEON_DATA_DIR));
// Windows uses this id for notifications and taskbar grouping.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  credits: 'Designed by Angell Belger',
  copyright: 'Designed by Angell Belger',
});

// One instance only: two processes would mean two timers on one database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** URL path prefix -> directory. Anything outside these roots is refused. */
const ROUTES = [
  ['/vendor/chartjs/', path.join(ROOT, 'node_modules', 'chart.js', 'dist')],
  ['/vendor/fonts/jetbrains-mono/', path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files')],
  ['/vendor/fonts/space-grotesk/', path.join(ROOT, 'node_modules', '@fontsource', 'space-grotesk', 'files')],
  ['/', path.join(ROOT, 'src')],
];

function resolveAppUrl(url) {
  const { pathname } = new URL(url);
  const decoded = decodeURIComponent(pathname);
  for (const [prefix, dir] of ROUTES) {
    if (decoded.startsWith(prefix)) {
      const target = path.normalize(path.join(dir, decoded.slice(prefix.length) || 'index.html'));
      if (target === dir || !target.startsWith(dir + path.sep)) return null;
      return target;
    }
  }
  return null;
}

let mainWindow = null;
let tray = null;
let services = null;
let tickTimer = null;
let quitting = false;

function getWindow() { return mainWindow; }

function showWindow(page) {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (page) mainWindow.webContents.send('app:navigate', page);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#05060b',
    title: APP_NAME,
    icon: path.join(ROOT, 'assets', 'icons', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,              // the alarm must play while hidden
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  mainWindow.loadURL('app://local/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep running in the tray/menu bar when the window is closed.
  mainWindow.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // No navigation away from the app, no new windows.
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://local/')) e.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const MODE_LABEL = { focus: 'Focus', short_break: 'Short break', long_break: 'Long break' };

function notifyCompletion(c) {
  const settings = services.settingsRepo.getAll();
  if (!settings.notificationsEnabled || !Notification.isSupported()) return;
  const title = c.sessionType === 'focus' ? 'Focus session complete' : `${MODE_LABEL[c.sessionType]} over`;
  const next = MODE_LABEL[c.nextMode].toLowerCase();
  const body = c.autoStarted ? `Your ${next} has started.` : `Your ${next} is ready when you are.`;
  const n = new Notification({ title, body, silent: true }); // the app plays its own alarm
  n.on('click', () => showWindow('focus'));
  n.show();
}

async function boot() {
  const dbPath = path.join(app.getPath('userData'), 'focus-neon.sqlite');
  let carriedOverFrom = null;
  if (!process.env.FOCUS_NEON_DATA_DIR) {
    try {
      carriedOverFrom = carryOverLegacyDatabase(app.getPath('appData'), dbPath);
    } catch (err) {
      console.error('[app] could not copy data from the previous app name:', err);
    }
  }
  services = await createServices({ dbPath, secondsPerMinute: SECONDS_PER_MINUTE });
  const { engine } = services;

  protocol.handle('app', (request) => {
    const file = resolveAppUrl(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  registerIpc(services, {
    getWindow,
    dbPath,
    startupInfo: { recoveredFrom: services.db.recoveredFrom, carriedOverFrom, secondsPerMinute: SECONDS_PER_MINUTE },
    onSettingsChanged: (s) => tray && tray.applySettings(s),
  });

  engine.on('state', (s) => {
    broadcast('timer:state', s);
    if (tray) tray.update(s);
  });
  engine.on('completed', (c) => {
    broadcast('timer:completed', c);
    broadcast('data:changed', { at: Date.now() });
    notifyCompletion(c);
  });
  engine.on('notice', (n) => broadcast('timer:notice', n));

  engine.init();

  // The tick only checks the clock against stored timestamps; its frequency
  // does not affect accuracy.
  tickTimer = setInterval(() => {
    try {
      engine.tick();
      if (tray) tray.update(engine.getState());
    } catch (err) {
      console.error('[timer] tick failed:', err);
    }
  }, 250);

  powerMonitor.on('suspend', () => engine.suspend());
  powerMonitor.on('resume', () => engine.tick());

  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  tray = createTray({ engine, settings: services.settingsRepo.getAll(), showWindow, quit: () => app.quit() });
}

app.on('second-instance', () => showWindow());

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
  if (tickTimer) clearInterval(tickTimer);
  if (services) {
    try {
      services.engine.tick();
      const a = services.engine.active;
      if (a && a.state === 'running') services.stateRepo.heartbeat(new Date().toISOString());
      services.db.close();
    } catch (err) {
      console.error('[app] shutdown save failed:', err);
    }
  }
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.whenReady().then(boot).catch((err) => {
  console.error(err);
  const { dialog } = require('electron');
  dialog.showErrorBox('Focus Neon could not start', String(err && err.stack || err));
  app.exit(1);
});
