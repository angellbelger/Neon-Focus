'use strict';

/**
 * End-to-end test: launches the real Electron app in fast mode
 * (1 minute = 1 second) against a temporary database and drives the UI.
 *
 *   npm run test:e2e            (on Linux CI wrap with xvfb-run)
 *   SCREENSHOTS=dir npm run test:e2e   to save screenshots
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.SCREENSHOTS || null;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-e2e-'));

async function launch() {
  const args = [ROOT];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const app = await electron.launch({
    args,
    env: { ...process.env, FOCUS_NEON_SECONDS_PER_MINUTE: '1', FOCUS_NEON_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.waitForSelector('#dial-ticks line', { state: 'attached' });
  await waitFor(page, () => document.querySelector('#dial-time').textContent !== '');
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  return { app, page };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function setSetting(page, selector, value) {
  await page.fill(selector, String(value));
  await page.dispatchEvent(selector, 'change');
  await page.waitForTimeout(150);
}


/** Polls a predicate in the page (page.waitForFunction needs eval, which our CSP forbids). */
async function waitFor(page, fn, arg = null, { timeout = 10000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${fn.toString().slice(0, 140)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const step = (msg) => console.log(`  ✓ ${msg}`);

/** A short sine tone as a real WAV file (16-bit mono). */
function writeWav(file, seconds, freq) {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 3000), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

/** A small real PNG: a diagonal gradient (so cover/centering is visible in screenshots). */
function writePng(file, w, h) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(255 * x / w); raw[o + 1] = Math.round(120 + 100 * y / h); raw[o + 2] = 200;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

(async () => {
  let { app, page } = await launch();

  // --- initial state
  assert.equal(await page.textContent('#dial-time'), '00:25'); // fast mode: 25 "minutes" = 25 s
  assert.equal(await page.locator('#dial-ticks line.is-lit').count(), 60);
  step('starts idle with a full dial');
  await shot(page, '01-focus-idle');

  // --- settings: short sessions for the test
  await page.click('[data-nav="settings"]');
  await setSetting(page, '#s-focus', 4);
  await setSetting(page, '#s-short', 2);
  await setSetting(page, '#s-long', 3);
  await setSetting(page, '#s-interval', 2);
  await setSetting(page, '#s-focus', 0);           // invalid
  assert.equal(await page.getAttribute('#s-focus', 'aria-invalid'), 'true');
  step('invalid setting is rejected with an inline error');
  await setSetting(page, '#s-focus', 4);
  assert.equal(await page.getAttribute('#s-focus', 'aria-invalid'), null);
  await shot(page, '05-settings');

  // --- tasks
  await page.click('[data-nav="tasks"]');
  await page.fill('#quick-title', 'Write the quarterly report');
  await page.fill('#quick-est', '3');
  await page.click('#task-quick-add button[type="submit"]');
  await page.fill('#quick-title', 'Review pull requests');
  await page.click('#task-quick-add button[type="submit"]');
  await page.waitForSelector('.task >> nth=1');
  assert.equal(await page.locator('.task').count(), 2);
  step('tasks created');
  await page.locator('.task', { hasText: 'Write the quarterly report' }).locator('.icon-btn--focus').click();
  await page.waitForSelector('.page--focus:not([hidden])');
  await waitFor(page, () => document.querySelector('#task-chip-label').textContent.includes('quarterly'));
  step('task selected for focus from the task list');

  // --- count alarm oscillators
  await page.evaluate(() => {
    window.__osc = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function patched() { window.__osc += 1; return orig.call(this); };
  });

  // --- full focus session
  assert.equal(await page.textContent('#dial-time'), '00:04');
  await page.click('#btn-main');
  await waitFor(page, () => document.body.dataset.status === 'running');
  await page.waitForTimeout(1300);
  const mid = await page.textContent('#dial-time');
  assert.ok(['00:03', '00:02'].includes(mid), `countdown at ${mid}`);
  const litMid = await page.locator('#dial-ticks line.is-lit').count();
  assert.ok(litMid < 60 && litMid > 20, `lit ticks ${litMid}`);
  step(`countdown running (${mid}, ${litMid} tubes lit)`);
  await shot(page, '02-focus-running');
  await waitFor(page, () => document.body.dataset.mode === 'short_break' && document.body.dataset.status === 'idle', null, { timeout: 8000 });
  await waitFor(page, () => document.querySelector('#today-pomodoros').textContent === '1');
  const oscAfterFocus = await page.evaluate(() => window.__osc);
  assert.ok(oscAfterFocus > 0, 'alarm should play after focus');
  assert.ok(await page.isVisible('#focus-banner'));
  assert.match(await page.textContent('#focus-banner-text'), /Focus session complete.*short break is ready/);
  step(`focus completed: 1 Pomodoro, alarm played (${oscAfterFocus} oscillators), banner shown`);
  await shot(page, '03-focus-complete');

  // --- break via banner action; break completion also alarms, no Pomodoro
  await page.click('#focus-banner-action');
  await waitFor(page, () => document.body.dataset.mode === 'focus' && document.body.dataset.status === 'idle', null, { timeout: 6000 });
  const oscAfterBreak = await page.evaluate(() => window.__osc);
  assert.ok(oscAfterBreak > oscAfterFocus, 'alarm should play after break');
  assert.equal(await page.textContent('#today-pomodoros'), '1');
  step('short break completed with alarm and did not add a Pomodoro');

  // --- pause preserves remaining time
  await page.click('#btn-main');
  await page.waitForTimeout(1200);
  await page.click('#btn-main'); // pause
  await waitFor(page, () => document.body.dataset.status === 'paused');
  const p1 = await page.evaluate(() => window.pomodoro.timer.getState().then((s) => s.elapsedMs));
  await page.waitForTimeout(1500);
  const p2 = await page.evaluate(() => window.pomodoro.timer.getState().then((s) => s.elapsedMs));
  assert.equal(p1, p2);
  step(`pause holds elapsed time (${p1} ms)`);

  // --- navigation keeps the timer; mini timer in the rail
  await page.click('#btn-main'); // resume
  await page.click('[data-nav="history"]');
  assert.ok(await page.isVisible('#rail-mini'));
  step('timer keeps running while on another page (rail mini timer visible)');
  await page.click('#rail-mini');
  // --- the screen locks, the display sleeps and the window goes to the background mid-session:
  //     the countdown keeps running, completes on time and the alarm still plays
  const oscBeforeLock = await page.evaluate(() => window.__osc);
  const elapsedAtLock = await page.evaluate(() => window.pomodoro.timer.getState().then((s) => s.elapsedMs));
  await app.evaluate(({ powerMonitor, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].hide();
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('suspend');
  });
  await page.waitForTimeout(600);
  const whileLocked = await page.evaluate(() => window.pomodoro.timer.getState());
  assert.equal(whileLocked.status, 'running', 'locking / sleep does not pause');
  assert.ok(whileLocked.elapsedMs >= elapsedAtLock + 400, `still counting while locked (${elapsedAtLock} -> ${whileLocked.elapsedMs})`);
  assert.equal(whileLocked.notice, null);
  await waitFor(page, () => document.body.dataset.mode === 'long_break', null, { timeout: 8000 });
  const oscWhileLocked = await page.evaluate(() => window.__osc);
  assert.ok(oscWhileLocked > oscBeforeLock, 'alarm played while the window was hidden and the screen locked');
  await app.evaluate(({ powerMonitor, BrowserWindow }) => {
    powerMonitor.emit('resume');
    powerMonitor.emit('unlock-screen');
    BrowserWindow.getAllWindows()[0].show();
  });
  await waitFor(page, () => document.querySelector('#today-pomodoros').textContent === '2');
  assert.equal(await page.textContent('#dial-time'), '00:03', 'long break uses the saved 3-minute setting');
  step('second focus kept running through lock + sleep + hidden window, completed on time with the alarm; interval=2 so a long break is next');

  // --- reset records an interrupted session
  await page.click('#btn-main');
  await page.waitForTimeout(1300);
  await page.keyboard.press('r');
  await waitFor(page, () => document.body.dataset.status === 'idle');
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'long_break');
  step('reset (keyboard R) stops the session and keeps the mode');

  // --- history
  await page.click('[data-nav="history"]');
  await page.waitForSelector('#history-body tr:not(.day-row)');
  const rows = await page.locator('#history-body tr:not(.day-row)').count();
  assert.equal(rows, 4);
  const statuses = await page.locator('#history-body .status-tag').allTextContents();
  assert.deepEqual(statuses.sort(), ['Completed', 'Completed', 'Completed', 'Interrupted']);
  await page.selectOption('#hf-type', 'focus');
  await waitFor(page, () => document.querySelectorAll('#history-body tr:not(.day-row)').length === 2);
  await page.selectOption('#hf-type', 'all');
  step('history lists 4 sessions (3 completed, 1 interrupted) and filters by type');
  await page.waitForTimeout(300);
  await shot(page, '06-history');

  // --- task shows 2 Pomodoros but is not completed
  await page.click('[data-nav="tasks"]');
  await page.waitForSelector('.task');
  const pomoText = await page.locator('.task', { hasText: 'quarterly' }).locator('.pomo-count').textContent();
  assert.equal(pomoText, '2 of 3 Pomodoros');
  assert.equal(await page.locator('.task', { hasText: 'quarterly' }).getAttribute('data-status'), 'active');
  step('task shows 2 of 3 Pomodoros and stays active');
  await page.locator('.task', { hasText: 'quarterly' }).locator('[aria-label^="Session history"]').click();
  await page.waitForSelector('.task__history li');
  await shot(page, '07-tasks');

  // --- dashboard
  await page.click('[data-nav="dashboard"]');
  await page.waitForSelector('.kpi');
  const kpiPomos = await page.locator('.kpi').first().locator('.kpi__value').textContent();
  assert.equal(kpiPomos, '2');
  step('dashboard daily KPI shows 2 Pomodoros');
  for (const p of ['week', 'month', 'year']) {
    await page.click(`[data-period="${p}"]`);
    await waitFor(page, (pp) => document.querySelector(`[data-period="${pp}"]`).getAttribute('aria-checked') === 'true', p);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.kpi').first().locator('.kpi__value').textContent(), '2');
  }
  step('weekly, monthly and yearly views agree');
  await page.click('[data-period="day"]');

  // --- name and footer
  await page.click('[data-nav="focus"]');
  assert.equal(await page.title(), 'Focus Neon');
  assert.equal(await app.evaluate(({ app: a }) => a.getName()), 'Focus Neon');
  for (const p of ['focus', 'agenda', 'tasks', 'goals', 'dashboard', 'history', 'settings']) {
    await page.click(`.rail [data-nav="${p}"]`);
    await page.locator('.credit').scrollIntoViewIfNeeded();
    assert.ok(await page.isVisible('.credit'), `footer on ${p}`);
    assert.equal((await page.textContent('.credit')).trim(), 'Designed by Angell Belger');
  }
  assert.equal(await page.locator('.credit').count(), 1, 'footer is one shared element');
  step('app is named Focus Neon; footer credit shows on all seven pages');

  // --- task steps
  await page.click('[data-nav="tasks"]');
  const row = () => page.locator('.task', { hasText: 'quarterly' });
  await row().locator('.step-add__btn').click();
  for (const name of ['Speaking', 'Writing', 'Reading']) {
    await row().locator('.step-add__input').fill(name);
    await row().locator('.step-add__input').press('Enter');
    await waitFor(page, (n) => [...document.querySelectorAll('.step__title')].some((b) => b.textContent === n), name);
  }
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('step-add__input')), true, 'field stays ready for the next step');
  await row().locator('.step-add__input').press('Escape');
  assert.equal(await row().locator('.step').count(), 3);
  // complete
  await row().locator('.step', { hasText: 'Speaking' }).locator('.step__check').click();
  await waitFor(page, () => document.querySelector('.step[data-done="true"]') !== null);
  assert.equal(await row().locator('.steps-toggle').textContent(), '1 of 3 steps');
  // rename
  await row().locator('.step__title', { hasText: 'Writing' }).click();
  await row().locator('.step__edit').fill('Writing - 2 pages');
  await row().locator('.step__edit').press('Enter');
  await waitFor(page, () => [...document.querySelectorAll('.step__title')].some((b) => b.textContent === 'Writing - 2 pages'));
  // delete
  await row().locator('.step', { hasText: 'Reading' }).hover();
  await row().locator('.step', { hasText: 'Reading' }).locator('.step__delete').click();
  await waitFor(page, () => document.querySelectorAll('.task .step').length === 2);
  // other task stays separate
  await page.locator('.task', { hasText: 'Review pull requests' }).locator('.step-add__btn').click();
  await page.locator('.task', { hasText: 'Review pull requests' }).locator('.step-add__input').fill('Check CI');
  await page.locator('.task', { hasText: 'Review pull requests' }).locator('.step-add__input').press('Enter');
  await page.keyboard.press('Escape');
  await waitFor(page, () => document.querySelectorAll('.task .step').length === 3);
  assert.equal(await page.locator('.task', { hasText: 'Review pull requests' }).locator('.step').count(), 1);
  // collapse / expand
  await row().locator('.steps-toggle').click();
  assert.equal(await row().locator('.step').count(), 0);
  await row().locator('.steps-toggle').click();
  assert.equal(await row().locator('.step').count(), 2);
  step('steps: add (Enter keeps the field open), complete, rename, delete, collapse; kept per task');
  await shot(page, '09-steps');

  // --- persistence across restart
  await app.close();
  ({ app, page } = await launch());
  await page.click('[data-nav="history"]');
  await page.waitForSelector('#history-body tr:not(.day-row)');
  assert.equal(await page.locator('#history-body tr:not(.day-row)').count(), 4);
  await page.click('[data-nav="focus"]');
  assert.equal(await page.textContent('#today-pomodoros'), '2');
  await page.click('[data-nav="tasks"]');
  await page.waitForSelector('.step');
  const persisted = await page.evaluate(() => [...document.querySelectorAll('.task')].map((t) => ({
    task: t.querySelector('.task__title').textContent,
    steps: [...t.querySelectorAll('.step')].map((st) => `${st.querySelector('.step__title').textContent}:${st.dataset.done}`),
  })));
  const q = persisted.find((x) => x.task.includes('quarterly'));
  assert.deepEqual(q.steps, ['Speaking:true', 'Writing - 2 pages:false']);
  assert.deepEqual(persisted.find((x) => x.task.includes('Review')).steps, ['Check CI:false']);
  step('history, settings and task steps persist after restart');

  // --- backup, then import it back (native file dialogs are stubbed in the main process)
  const backupFile = path.join(dataDir, 'my-backup.sqlite');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backupFile);
  await page.click('[data-nav="settings"]');
  await page.click('#s-backup');
  await waitFor(page, () => /Backup saved/.test(document.querySelector('#toasts').textContent));
  assert.ok(fs.statSync(backupFile).size > 0);
  step('existing "Back up database" still works');

  // change data after the backup
  await page.click('[data-nav="tasks"]');
  await page.fill('#quick-title', 'Added after the backup');
  await page.click('#task-quick-add button[type="submit"]');
  await page.waitForSelector('.task >> text=Added after the backup');

  // invalid file first
  const junk = path.join(dataDir, 'not-a-backup.sqlite');
  fs.writeFileSync(junk, 'this is not a database '.repeat(100));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, junk);
  await page.click('[data-nav="settings"]');
  await page.click('#s-import');
  await waitFor(page, () => /Import failed: The selected file is not a SQLite database/.test(document.querySelector('#toasts').textContent));
  assert.equal(await page.isVisible('#confirm'), false, 'no confirmation for an invalid file');
  step('invalid backup file is rejected with a clear message; nothing changes');

  // valid backup: confirm, then restore
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backupFile);
  await page.click('#s-import');
  await page.waitForSelector('#confirm[open]');
  const warn = await page.textContent('#confirm-text');
  assert.match(warn, /2 tasks, 3 steps and 4 sessions/);
  assert.match(warn, /replaces all tasks/);
  await page.click('#confirm-ok');
  await waitFor(page, () => /Backup imported/.test(document.querySelector('#toasts').textContent));
  const safety = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.startsWith('focus-neon-before-import-'));
  assert.equal(safety.length, 1, 'automatic safety backup created');
  await page.click('[data-nav="tasks"]');
  await page.waitForSelector('.step');
  assert.equal(await page.locator('.task', { hasText: 'Added after the backup' }).count(), 0);
  assert.equal(await page.locator('.task').count(), 2);
  assert.equal(await page.locator('.task .step').count(), 3);
  await page.click('[data-nav="focus"]');
  assert.equal(await page.textContent('#today-pomodoros'), '2');
  step('import restores the backup (tasks, steps, history) after a confirmation and an automatic safety copy');
  await page.click('[data-nav="settings"]');
  await shot(page, '10-settings-import');

  // import survives a restart
  await app.close();
  ({ app, page } = await launch());
  await page.click('[data-nav="tasks"]');
  await page.waitForSelector('.step');
  assert.equal(await page.locator('.task').count(), 2);
  step('imported data persists after restart');

  // ================================================================ Agenda, tags, goals, activity
  const todayKey = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const addDaysKey = (key, n) => { const [y, m, d] = key.split('-').map(Number); const dt = new Date(y, m - 1, d + n); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; };
  const tomorrowKey = addDaysKey(todayKey, 1);
  const mondayOf = (key) => { const [y, m, d] = key.split('-').map(Number); return addDaysKey(key, -((new Date(y, m - 1, d).getDay() + 6) % 7)); };
  const thisMonday = mondayOf(todayKey);

  // tags: create in the manager, reuse on two tasks
  await page.click('[data-nav="tasks"]');
  await page.click('#tags-manage');
  await page.fill('#tag-manager-new', 'English');
  await page.click('#tag-manager-create');
  await page.waitForSelector('#tag-manager-list .tag-admin__name');
  await page.fill('#tag-manager-new', 'Work');
  await page.press('#tag-manager-new', 'Enter');
  await waitFor(page, () => document.querySelectorAll('#tag-manager-list .tag-admin__row').length === 2);
  await page.fill('#tag-manager-new', 'english');
  await page.click('#tag-manager-create');
  await waitFor(page, () => /already exists/.test(document.querySelector('#tag-manager-error').textContent));
  await page.click('#tag-manager button[value="close"]');
  step('tags created in the tag manager; duplicate names are refused');

  // tasks with dates: one today tagged English, one tomorrow, one untagged "English" by title only
  const addTask = async (title, date) => {
    await page.fill('#quick-title', title);
    await page.fill('#quick-date', date);
    await page.click('#task-quick-add button[type="submit"]');
    await page.waitForSelector(`.task >> text=${title}`);
  };
  await addTask('English Listening Practice', todayKey);
  await addTask('English Writing Practice', tomorrowKey);
  await addTask('English but no tag', todayKey);
  const tagTask = async (title, tagName) => {
    await page.locator('.task', { hasText: title }).locator('[aria-label^="Tags of"]').click();
    await page.waitForSelector('#tag-picker[open]');
    await page.locator('#tag-picker-list label', { hasText: tagName }).locator('input').check();
    await page.click('#tag-picker-save');
    await waitFor(page, () => !document.querySelector('#tag-picker').open);
  };
  await tagTask('English Listening Practice', 'English');
  await tagTask('English Writing Practice', 'English');
  await waitFor(page, () => [...document.querySelectorAll('.task')].filter((t) => t.querySelector('.tag')?.textContent === 'English').length === 2);
  step('one tag reused on two tasks; chips shown in Tasks');

  // agenda shows tasks on their dates
  await page.click('[data-nav="agenda"]');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  const order = await page.locator('.ag-day').evaluateAll((els) => els.map((e) => e.dataset.date));
  assert.equal(order.length, 7);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6].map((n) => addDaysKey(thisMonday, n)), 'Monday to Sunday of the current week');
  const weekdays = await page.locator('.ag-day').evaluateAll((els) => els.map((e) => new Date(`${e.dataset.date}T12:00`).getDay()));
  assert.deepEqual(weekdays, [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(await page.locator('.ag-day[data-today="true"]').count(), 1, 'exactly one day carries the today accent');
  assert.equal(await page.locator('.ag-day[data-today="true"]').getAttribute('data-date'), todayKey);
  const todayVisible = await page.locator('.ag-day[data-today="true"] .ag-day__num').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  assert.ok(todayVisible, "today's date is in view without scrolling");
  assert.match(await page.textContent('#ag-week-title'), /^This week · W\d+$/);
  step(`Agenda opens on the calendar week Monday ${thisMonday} – Sunday ${addDaysKey(thisMonday, 6)}, today (${todayKey}) highlighted and in view`);
  const dayTitles = async (key) => page.locator(`.ag-day[data-date="${key}"] .ag-task__title`).allTextContents();
  assert.ok((await dayTitles(todayKey)).includes('English Listening Practice'));
  assert.ok((await dayTitles(todayKey)).includes('English but no tag'));
  if (await page.locator(`.ag-day[data-date="${tomorrowKey}"]`).count() === 0) await page.click('#ag-next');
  await page.waitForSelector(`.ag-day[data-date="${tomorrowKey}"]`);
  assert.ok((await dayTitles(tomorrowKey)).includes('English Writing Practice'));
  assert.equal(await page.locator(`.ag-day[data-date="${tomorrowKey}"] .tag`).first().textContent(), 'English');
  await page.click('#ag-today');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  step('tasks appear in the Agenda on their scheduled days, with their tags');

  // complete from the agenda -> Tasks shows it completed (and back)
  await page.locator(`.ag-day[data-date="${todayKey}"] .ag-task`, { hasText: 'English but no tag' }).locator('.ag-task__check').click();
  await waitFor(page, (k) => document.querySelector(`.ag-day[data-date="${k}"] .ag-task[data-status="completed"]`) !== null, todayKey);
  await page.click('[data-nav="tasks"]');
  await page.click('[data-task-filter="completed"]');
  await page.waitForSelector('.task >> text=English but no tag');
  await page.locator('.task', { hasText: 'English but no tag' }).locator('.task__check').click();
  await page.click('[data-task-filter="all"]');
  await waitFor(page, () => [...document.querySelectorAll('.task')].some((t) => t.textContent.includes('English but no tag') && t.dataset.status === 'active'));
  await page.click('[data-nav="agenda"]');
  await waitFor(page, (k) => [...document.querySelectorAll(`.ag-day[data-date="${k}"] .ag-task`)].some((t) => t.textContent.includes('English but no tag') && t.dataset.status === 'active'), todayKey);
  step('completing in either section updates the other');

  // TTP / H.E. update as sessions are recorded
  const dayStats = (k) => page.evaluate((key) => window.pomodoro.agenda.days(key, 1).then((r) => r.days[0]), k);
  const before = await dayStats(todayKey);
  const ttpText = () => page.textContent(`.ag-day[data-date="${todayKey}"] .ag-day__stats dd`);
  assert.equal(await ttpText(), String(before.ttp));
  const runPomodoroOn = async (title) => {
    await page.evaluate(async (t) => {
      const tasks = await window.pomodoro.tasks.list('all');
      const task = tasks.find((x) => x.title === t);
      const s = await window.pomodoro.timer.getState();
      if (s.status !== 'idle') await window.pomodoro.timer.reset();
      if ((await window.pomodoro.timer.getState()).mode !== 'focus') await window.pomodoro.timer.setMode('focus');
      await window.pomodoro.timer.setTask(task ? task.id : null);
      await window.pomodoro.timer.start();
    }, title);
    await waitFor(page, () => window.pomodoro.timer.getState().then((s) => s.status === 'idle' && s.mode !== 'focus'), null, { timeout: 15000 });
  };
  await runPomodoroOn('English Listening Practice');
  await waitFor(page, (n) => document.querySelector(`.ag-day[data-date="${n.k}"] .ag-day__stats dd`).textContent === String(n.v), { k: todayKey, v: before.ttp + 1 });
  await runPomodoroOn('English but no tag');
  const after = await dayStats(todayKey);
  assert.equal(after.ttp, before.ttp + 2);
  assert.equal(after.hoursSeconds - before.hoursSeconds, 4, 'only the English-tagged session adds to H.E. (4 s in fast mode)');
  // the week box covers the whole Monday–Sunday week (future days included) and updates live
  const week = await page.evaluate((m) => window.pomodoro.agenda.days(m, 7), thisMonday);
  assert.equal(week.from, thisMonday);
  assert.equal(week.to, addDaysKey(thisMonday, 6));
  assert.ok(week.week.ttp >= after.ttp);
  await waitFor(page, (v) => document.querySelector('#ag-week-tally .tally__row--ttp dd').textContent === `${v}P`, week.week.ttp);
  step(`TTP updates live (${before.ttp} -> ${after.ttp}); H.E. counts only the English-tagged session; week box = whole-week total (${week.week.ttp}P)`);

  // "Weeks start on" in Settings drives the Agenda week (single source of truth)
  const sundayOf = (key) => { const [y, m, d] = key.split('-').map(Number); return addDaysKey(key, -new Date(y, m - 1, d).getDay()); };
  const thisSunday = sundayOf(todayKey);
  const weekDates = () => page.locator('.ag-day').evaluateAll((els) => els.map((e) => e.dataset.date));
  await page.click('[data-nav="settings"]');
  await page.selectOption('#s-weekstart', '0');
  await waitFor(page, () => window.pomodoro.settings.get().then((s) => s.weekStart === 0));
  await page.click('[data-nav="agenda"]');
  await waitFor(page, (k) => document.querySelector('.ag-day')?.dataset.date === k, thisSunday);
  assert.deepEqual(await weekDates(), [0, 1, 2, 3, 4, 5, 6].map((n) => addDaysKey(thisSunday, n)), 'Sunday to Saturday');
  assert.deepEqual(await page.locator('.ag-day').evaluateAll((els) => els.map((e) => new Date(`${e.dataset.date}T12:00`).getDay())), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(await page.locator('.ag-day[data-today="true"]').getAttribute('data-date'), todayKey);
  const sunWeek = await page.evaluate((k) => window.pomodoro.agenda.days(k, 7), thisSunday);
  await waitFor(page, (v) => document.querySelector('#ag-week-tally .tally__row--ttp dd').textContent === `${v}P`, sunWeek.week.ttp);
  assert.equal(await page.locator('#ag-cal .minical__dow').first().textContent(), new Date(2026, 0, 4).toLocaleDateString('en-GB', { weekday: 'narrow' }), 'mini calendar starts on Sunday too');
  // changing the setting while the Agenda is open reorganises it at once
  await page.evaluate(() => window.pomodoro.settings.update({ weekStart: 1 }));
  await waitFor(page, (k) => document.querySelector('.ag-day')?.dataset.date === k, thisMonday);
  assert.deepEqual(await weekDates(), [0, 1, 2, 3, 4, 5, 6].map((n) => addDaysKey(thisMonday, n)), 'back to Monday to Sunday');
  await waitFor(page, (v) => document.querySelector('#ag-week-tally .tally__row--ttp dd').textContent === `${v}P`, week.week.ttp);
  assert.equal(await page.inputValue('#s-weekstart'), '1', 'Settings shows the same value');
  step(`"Weeks start on" Sunday -> Agenda ${thisSunday}..${addDaysKey(thisSunday, 6)} (week box ${sunWeek.week.ttp}P); back to Monday live -> ${thisMonday}..${addDaysKey(thisMonday, 6)}`);

  // daily notes: create, edit, delete; persist after restart
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-tool--note`);
  await page.fill(`.ag-day[data-date="${todayKey}"] .ag-note__input`, "New Year's Eve with my daughter.");
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note .btn--accent`);
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.fill(`.ag-day[data-date="${todayKey}"] .ag-note__input`, "New Year's Eve with my daughter. Fireworks!");
  await page.press(`.ag-day[data-date="${todayKey}"] .ag-note__input`, 'Control+Enter');
  await waitFor(page, (k) => document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`)?.textContent.endsWith('Fireworks!'), todayKey);
  const css = (sel, prop = 'color') => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
  const plannerEmerald = await page.evaluate(() => { const el = document.createElement('span'); el.style.color = 'var(--emerald-note)'; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c; });
  assert.equal(plannerEmerald, 'rgb(52, 211, 153)');
  assert.equal(await css(`.ag-day[data-date="${todayKey}"] .ag-note__text`), plannerEmerald, 'daily note text in the planner emerald');
  assert.match(await css(`.ag-day[data-date="${todayKey}"] .ag-note__text`, 'borderLeftColor'), /52, 211, 153|srgb 0\.2039\d* 0\.8274\d* 0\.6\b/, 'note margin line emerald');
  const otherDay = await page.locator('.ag-day .ag-tool--note').count();
  if (otherDay) assert.equal(await css('.ag-day .ag-tool--note span'), plannerEmerald, '"+ Note" icon emerald');
  step('daily note created and edited; note, its margin line and the "+ Note" icon use the planner emerald');

  // year navigation: only years with data
  await page.evaluate(() => window.pomodoro.tasks.create({ title: 'Old planner entry', scheduledDate: '2024-05-10' }));
  const quote = 'Those who, though they do not have the crown, possess the pride of a king, will sooner or later ascend to the throne.';
  await page.evaluate((q) => window.pomodoro.agenda.saveNote('2024-01-01', q), quote);
  await page.click('[data-nav="tasks"]');
  await page.click('[data-nav="agenda"]');
  await waitFor(page, () => document.querySelectorAll('#ag-years .planner').length >= 2);
  const yearsShown = await page.locator('#ag-years .planner__year').allTextContents();
  const nowYear = String(new Date().getFullYear());
  assert.deepEqual(yearsShown, [nowYear, '2024'], 'newest planner first; no empty years such as 2025');
  assert.equal(await page.locator('#ag-years .planner', { hasText: '2024' }).locator('.planner__note').textContent(), quote, "2024 shows its 1 January note");
  assert.equal(await page.locator('#ag-years .planner', { hasText: nowYear }).locator('button.planner__note').count(), 0, 'no note, no placeholder');
  assert.equal((await page.locator('#ag-years .planner', { hasText: nowYear }).locator('.planner__note').textContent()), '');
  const cardHeights = () => page.locator('#ag-years .planner--card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  let heights = await cardHeights();
  assert.equal(new Set(heights).size, 1, `collapsed planner cards share one height (${heights})`);
  const noteColor = await page.locator('#ag-years button.planner__note').evaluate((el) => getComputedStyle(el).color);
  assert.match(noteColor, /52, 211, 153/, 'emerald planner note');
  assert.equal((await page.textContent('#agenda-heading')).trim(), `Cambridge ${nowYear}`);
  await page.locator('#ag-years .planner', { hasText: '2024' }).click();
  await page.waitForSelector('.ag-day[data-date="2024-12-31"]');
  // opening the 2024 planner shows its whole note; clicking the card collapses it again
  await waitFor(page, () => document.querySelector('#ag-years .planner[aria-current="true"]')?.dataset.expanded === 'true');
  heights = await cardHeights();
  const openIdx = await page.locator('#ag-years .planner--card').evaluateAll((els) => els.findIndex((e) => e.getAttribute('aria-current') === 'true'));
  assert.ok(heights[openIdx] > Math.min(...heights), 'expanded note makes its card taller');
  await page.locator('#ag-years .planner[aria-current="true"] button.planner__note').click();
  await waitFor(page, () => document.querySelector('#ag-years .planner[aria-current="true"]').dataset.expanded === 'false');
  heights = await cardHeights();
  assert.equal(new Set(heights).size, 1, 'collapsed again: all cards equal');
  await page.locator('#ag-years .planner[aria-current="true"] .planner__open').click();
  await waitFor(page, () => document.querySelector('#ag-years .planner[aria-current="true"]').dataset.expanded === 'true');
  assert.equal(await page.locator('#ag-years .planner[aria-current="true"] button.planner__note').textContent(), quote, 'full note, unchanged');
  await page.locator('#ag-years .planner[aria-current="true"] button.planner__note').click();
  assert.equal(await page.locator('.ag-day').first().getAttribute('data-date'), '2024-12-30', 'a past planner opens on its last week (Mon 30 Dec 2024 – Sun 5 Jan 2025)');
  assert.equal(await page.locator('.ag-day').last().getAttribute('data-date'), '2025-01-05');
  assert.equal(await page.locator('.ag-day[data-today="true"]').count(), 0);
  assert.match(await page.textContent('#ag-week-title'), /^Week 1$/, 'ISO week 1 of 2025');
  assert.equal(await page.locator('#ag-years .planner[aria-current="true"] .planner__year').textContent(), '2024');
  assert.equal((await page.textContent('#agenda-heading')).trim(), 'Cambridge 2024', 'heading follows the selected planner');
  await page.click('#ag-today');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  assert.equal(await page.locator('.ag-day').first().getAttribute('data-date'), thisMonday);
  assert.equal((await page.textContent('#agenda-heading')).trim(), `Cambridge ${nowYear}`);
  // a week away from today does not stick: reopening the Agenda lands on the current week
  await page.click('#ag-prev');
  await page.waitForSelector(`.ag-day[data-date="${addDaysKey(thisMonday, -7)}"]`);
  await page.click('[data-nav="tasks"]');
  await page.click('[data-nav="agenda"]');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  assert.equal(await page.locator('.ag-day').first().getAttribute('data-date'), thisMonday, 'reopening shows the current week');
  const creditColor = await page.locator('.credit').evaluate((el) => getComputedStyle(el).color);
  assert.match(creditColor, /62, 242, 255/, 'cyan footer credit');
  step(`planners newest first (${yearsShown.join(', ')}), equal-height cards, emerald 1 January note expands/collapses, "Cambridge <year>" heading, cyan credit`);
  await shot(page, '11-agenda');

  // goals: create with milestones, neon progress; activity goal from the English tag
  await page.click('[data-nav="goals"]');
  await page.click('#goal-new');
  await page.fill('#goal-editor-form [name="title"]', 'Complete my research project');
  await page.fill('#goal-editor-form [name="start"]', '2026-01');
  await page.fill('#goal-editor-form [name="plan"]', 'Read, write, review.');
  await page.click('#goal-editor-form button[value="save"]');
  await page.waitForSelector('.goal >> text=Complete my research project');
  const goal = () => page.locator('.goal', { hasText: 'Complete my research project' });
  for (const m of ['Literature review', 'Experiments', 'Writing', 'Submission', 'PhD application']) {
    if (await goal().locator('.ms__edit').count() === 0) await goal().locator('.ms-add__btn').click();
    await goal().locator('.ms__edit').fill(m);
    await goal().locator('.ms__edit').press('Enter');
    await waitFor(page, (t) => [...document.querySelectorAll('.ms__title')].some((x) => x.textContent === t), m);
  }
  await page.keyboard.press('Escape');
  for (const m of ['Literature review', 'Experiments', 'Writing']) {
    await goal().locator('.ms', { hasText: m }).locator('.ms__mark').click();
    await waitFor(page, (t) => [...document.querySelectorAll('.ms')].some((x) => x.textContent.includes(t) && x.dataset.status === 'done'), m);
  }
  await goal().locator('.ms', { hasText: 'PhD application' }).hover();
  await goal().locator('.ms', { hasText: 'PhD application' }).locator('.ms__btn', { hasText: 'Drop' }).click();
  await waitFor(page, () => /75%/.test([...document.querySelectorAll('.goal')].find((g) => g.textContent.includes('research project')).querySelector('.evo__pct').textContent));
  const fillColor = await goal().locator('.evo__fill').evaluate((el) => getComputedStyle(el).backgroundImage);
  assert.match(fillColor, /57, 255, 20/, 'neon-green bar');
  const msColor = await goal().locator('.ms[data-status="done"] .ms__mark').first().evaluate((el) => getComputedStyle(el).color);
  assert.match(msColor, /255, 42, 95/, 'ruby milestone markers');
  assert.equal(await goal().locator('.ms__title').first().evaluate((el) => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'white milestone text');
  assert.equal(await goal().locator('.goal__title').evaluate((el) => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'goal name in white');
  assert.match(await goal().locator('.goal__diamond').evaluate((el) => getComputedStyle(el).color), /255, 42, 95/, 'main milestone diamond in neon ruby');
  step('goal created; ruby milestones done/dropped drive the neon-green bar to 75%');

  await page.click('#goal-new');
  await page.fill('#goal-editor-form [name="title"]', 'Study English for 200 hours');
  await page.check('#goal-editor-form [name="mode"][value="activity"]');
  await page.selectOption('#goal-editor-form [name="tag"]', { label: 'English' });
  await page.fill('#goal-editor-form [name="hours"]', '200');
  await page.click('#goal-editor-form button[value="save"]');
  await page.waitForSelector('.goal >> text=Study English for 200 hours');
  const detail = await page.locator('.goal', { hasText: 'Study English for 200 hours' }).locator('.evo__detail').textContent();
  assert.match(detail, /of 200 h on English/);
  await page.locator('.goal', { hasText: 'Complete my research project' }).locator('button', { hasText: 'Mark as achieved' }).click();
  await page.click('[data-goal-filter="completed"]');
  await waitFor(page, () => document.querySelectorAll('.goal').length === 1 && document.querySelector('.goal').textContent.includes('research'));
  await page.click('[data-goal-filter="all"]');
  await page.evaluate(() => window.pomodoro.goals.create({ year: 2021, title: 'Old goal' }));
  await page.evaluate(() => window.pomodoro.goals.create({ year: 2027, title: 'Future goal' }));
  await waitFor(page, () => document.querySelectorAll('#goal-years .planner').length >= 3);
  const goalYears = await page.locator('#goal-years .planner__year').allTextContents();
  assert.deepEqual(goalYears, [...goalYears].sort().reverse(), 'Goals years newest first');
  assert.equal(goalYears[0], '2027');
  assert.equal(goalYears[goalYears.length - 1], '2021');
  step('activity goal tracks English time; goals can be marked achieved and filtered; years newest first');
  await shot(page, '12-goals');

  // activity statistics: English across tasks; untagged session excluded
  await page.click('[data-nav="dashboard"]');
  await page.click('[data-dash-view="activity"]');
  await page.click('[data-act-range="today"]');
  await page.waitForSelector('#act-body tr');
  const engRow = page.locator('#act-body tr', { hasText: 'English' });
  assert.equal(await engRow.locator('td').first().textContent(), '1');
  assert.equal(await page.locator('#act-foot tr', { hasText: 'No tag' }).locator('td').first().textContent(), String(after.ttp - 1));
  await page.click('[data-act-range="custom"]');
  await page.fill('#act-from', '2020-01-01');
  await page.dispatchEvent('#act-from', 'change');
  await waitFor(page, () => /2020/.test(document.querySelector('#act-range-label').textContent));
  await page.click('[data-act-range="all"]');
  await waitFor(page, () => /All recorded history/.test(document.querySelector('#act-range-label').textContent));
  assert.equal(await page.locator('#act-detail .act-figures dd').first().textContent(), '1');
  step('Activity Statistics: per-tag totals, untagged excluded, ranges incl. custom and all time');
  await shot(page, '13-activity');
  await page.click('[data-dash-view="overview"]');

  // --- Settings → Tags in the Agenda: several tags, each by its own name (never H.E.), live
  const research = await page.evaluate(() => window.pomodoro.tags.create({ name: 'Research' }));
  const sessionsBeforeLegacy = await page.evaluate(() => window.pomodoro.history.list({}).then((r) => (r.rows || r).length));
  await page.click('[data-nav="agenda"]');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  const box = () => page.evaluate(() => {
    const rows = (sel) => [...document.querySelectorAll(`${sel} .tally__row--tag`)].map((r) => [r.querySelector('.tally__name').textContent, r.querySelector('dd').textContent]);
    return {
      ttp: parseInt(document.querySelector('#ag-week-tally .tally__row--ttp dd').textContent, 10),
      yttp: parseInt(document.querySelector('#ag-year-tally .tally__row--ttp dd').textContent, 10),
      rows: rows('#ag-week-tally'),
      yrows: rows('#ag-year-tally'),
      legacy: document.querySelector('#ag-week-legacy').hidden ? null : document.querySelector('#ag-week-legacy').textContent,
    };
  });
  const tagRowNames = () => box().then((b) => b.rows.map((r) => r[0]).join());
  const base = await box();
  assert.deepEqual(base.rows.map((r) => r[0]), ['English'], 'until chosen: the tag named English, shown as "English"');
  assert.equal(base.legacy, null);
  assert.equal(await page.locator('.agenda__side dt, .ag-day__stats dt').evaluateAll((els) => els.filter((e) => /H\.E\./.test(e.textContent)).length), 0, 'no fixed H.E. label anywhere');
  // a tag created now shows up in Settings by itself
  await page.click('[data-nav="settings"]');
  const german = await page.evaluate(() => window.pomodoro.tags.create({ name: 'German' }));
  await page.waitForSelector(`#s-agenda-tags [data-tag-id="${german.id}"]`);
  assert.equal(await page.getAttribute(`#s-agenda-tags [data-tag-id="${german.id}"]`, 'aria-pressed'), 'false');
  await page.click(`#s-agenda-tags [data-tag-id="${german.id}"]`);
  await page.click(`#s-agenda-tags [data-tag-id="${research.id}"]`);
  await waitFor(page, () => window.pomodoro.settings.get().then((st) => Array.isArray(st.hoursTagIds) && st.hoursTagIds.length === 3));
  await page.click('[data-nav="agenda"]');
  await waitFor(page, () => document.querySelectorAll('#ag-year-tally .tally__row--tag').length === 3);
  let b2 = await box();
  assert.deepEqual(b2.rows.map((r) => r[0]), ['English', 'German', 'Research']);
  assert.deepEqual(b2.yrows.map((r) => r[0]), ['English', 'German', 'Research']);
  assert.equal(b2.rows[0][1], base.rows[0][1], 'English hours unchanged');
  assert.equal(b2.ttp, base.ttp, 'TTP is still every Pomodoro');
  assert.deepEqual(await page.locator(`.ag-day[data-date="${todayKey}"] .ag-day__stats dt`).allTextContents(), ['TTP', 'English'], 'a day lists the selected tags that have time that day');
  const tallyBox = await page.locator('#ag-week-tally').boundingBox();
  const weekBox = await page.locator('.weekbox:not(.weekbox--year)').boundingBox();
  assert.ok(tallyBox.x + tallyBox.width <= weekBox.x + weekBox.width + 0.5, 'rows fit inside the box');
  await shot(page, '14-agenda-tags');
  // none selected: only TTP
  await page.click('[data-nav="settings"]');
  for (const id of await page.locator('#s-agenda-tags [aria-pressed="true"]').evaluateAll((els) => els.map((e) => e.dataset.tagId))) {
    await page.click(`#s-agenda-tags [data-tag-id="${id}"]`);
    await waitFor(page, (k) => document.querySelector(`#s-agenda-tags [data-tag-id="${k}"]`)?.getAttribute('aria-pressed') === 'false', id);
  }
  await waitFor(page, () => window.pomodoro.settings.get().then((st) => Array.isArray(st.hoursTagIds) && st.hoursTagIds.length === 0));
  await page.click('[data-nav="agenda"]');
  await waitFor(page, () => document.querySelectorAll('#ag-week-tally .tally__row--tag, #ag-year-tally .tally__row--tag').length === 0);
  assert.deepEqual(await page.locator(`.ag-day[data-date="${todayKey}"] .ag-day__stats dt`).allTextContents(), ['TTP']);
  // just Research for the legacy checks below
  await page.click('[data-nav="settings"]');
  await page.click(`#s-agenda-tags [data-tag-id="${research.id}"]`);
  await page.click('[data-nav="agenda"]');
  await waitFor(page, () => document.querySelector('#ag-week-tally .tally__name')?.textContent === 'Research');
  assert.equal(await tagRowNames(), 'Research');
  assert.deepEqual((await box()).rows, [['Research', '0 min']]);
  step('Settings → Tags in the Agenda: English + German + Research, each by name in both boxes and every day; none = TTP only; new tags selectable at once');

  // --- Legacy data: add, duplicate refused, edit, delete — through Settings
  const thisWeek = await page.evaluate(() => window.pomodoro.legacy.weeks(new Date().getFullYear()).then((r) => r.current));
  await page.click('[data-nav="settings"]');
  await page.click('#s-legacy');
  await page.waitForSelector('#legacy-manager[open]');
  assert.equal(await page.inputValue('#lg-year'), String(thisWeek.year));
  assert.equal(await page.inputValue('#lg-week'), String(thisWeek.week), 'opens on the current week');
  await page.fill('#lg-value', '12');
  await page.click('#lg-save');
  await page.waitForSelector('#lg-list .legacy-row[data-kind="pomodoros"]');
  await page.selectOption('#lg-kind', 'tag_hours');
  await page.selectOption('#lg-tag', String(research.id));
  await page.fill('#lg-value', '2:30');
  assert.equal(await page.textContent('#lg-hint'), '= 2 h 30 min');
  await page.click('#lg-save');
  await page.waitForSelector('#lg-list .legacy-row[data-kind="tag_hours"]');
  // a second TTP for the same week is refused, with a shortcut to edit the first
  await page.selectOption('#lg-kind', 'pomodoros');
  await page.fill('#lg-value', '5');
  await page.click('#lg-save');
  await page.waitForSelector('#lg-error:not([hidden])');
  assert.match(await page.textContent('#lg-error-text'), /already has a TTP total/);
  await page.click('#lg-edit-existing');
  assert.equal(await page.inputValue('#lg-value'), '12');
  assert.equal(await page.textContent('#lg-save'), 'Save changes');
  await page.fill('#lg-value', '15');
  await page.click('#lg-save');
  await waitFor(page, () => document.querySelector('#lg-list .legacy-row[data-kind="pomodoros"] .legacy-row__value')?.textContent === '15P');
  assert.equal((await page.evaluate(() => window.pomodoro.legacy.list())).length, 2, 'no duplicate was created');
  assert.ok(await page.locator('.legacy-list__title .legacy-mark').isVisible());
  await page.click('#legacy-form button[value="close"]');

  await page.click('[data-nav="agenda"]');
  await waitFor(page, (v) => parseInt(document.querySelector('#ag-week-tally .tally__row--ttp dd').textContent, 10) === v, base.ttp + 15);
  let withLegacy = await box();
  assert.deepEqual(withLegacy.rows, [['Research', '2 h 30 min']]);
  await waitFor(page, (v) => parseInt(document.querySelector('#ag-year-tally .tally__row--ttp dd').textContent, 10) === v, base.yttp + 15);
  withLegacy = await box();
  assert.deepEqual(withLegacy.yrows, [['Research', '2 h 30 min']], 'the so-far box includes it too');
  assert.match(withLegacy.legacy, /Legacy\s*incl\. 15P · Research 2 h 30 min/);
  assert.equal(await page.evaluate(() => window.pomodoro.history.list({}).then((r) => (r.rows || r).length)), sessionsBeforeLegacy, 'sessions untouched');
  const dayTtpSum = await page.locator('.ag-day .ag-day__stats div:first-child dd').evaluateAll((els) => els.reduce((n, e) => n + Number(e.textContent), 0));
  assert.equal(dayTtpSum, base.ttp, 'day rows keep tracked data only');
  step(`Legacy data via Settings: TTP 15 + 2 h 30 min Research for W${thisWeek.week}; duplicate refused -> edited; week and year boxes include it with a "Legacy" marker`);

  // Activity Statistics marks figures that include legacy records
  await page.click('[data-nav="dashboard"]');
  await page.click('[data-dash-view="activity"]');
  await page.click('[data-act-range="week"]');
  await waitFor(page, () => [...document.querySelectorAll('#act-body tr')].some((r) => r.textContent.includes('Research') && r.querySelector('.legacy-mark')));
  assert.ok(await page.locator('#act-foot .legacy-mark').count() >= 1);
  await page.click('[data-dash-view="overview"]');

  // delete the hours record from the manager
  await page.click('[data-nav="settings"]');
  await page.click('#s-legacy');
  await page.waitForSelector('#lg-list .legacy-row[data-kind="tag_hours"]');
  await page.click('#lg-list .legacy-row[data-kind="tag_hours"] .legacy-row__del');
  await page.click('#confirm-ok');
  await waitFor(page, () => !document.querySelector('#lg-list .legacy-row[data-kind="tag_hours"]'));
  await page.click('#legacy-form button[value="close"]');
  const english = (await page.evaluate(() => window.pomodoro.tags.list())).find((t) => t.name === 'English');
  await page.click(`#s-agenda-tags [data-tag-id="${english.id}"]`);
  await page.click(`#s-agenda-tags [data-tag-id="${research.id}"]`);
  await waitFor(page, (id) => window.pomodoro.settings.get().then((st) => JSON.stringify(st.hoursTagIds) === JSON.stringify([id])), english.id);
  await page.click('[data-nav="agenda"]');
  await waitFor(page, () => document.querySelector('#ag-week-tally .tally__name')?.textContent === 'English');
  withLegacy = await box();
  assert.equal(withLegacy.ttp, base.ttp + 15);
  assert.deepEqual(withLegacy.rows, base.rows, 'back to English; the deleted legacy hours are gone');
  step('Activity Statistics marks legacy figures; a legacy record deleted; tags back to English only');

  // --- previous years: Dashboard navigation and the Agenda's per-year "so far" box include legacy data
  const lastYear = new Date().getFullYear() - 1;
  const oldIds = await page.evaluate(async ({ y, tagId }) => [
    (await window.pomodoro.legacy.save({ year: y, week: 10, kind: 'pomodoros', value: 40 })).id,
    (await window.pomodoro.legacy.save({ year: y, week: 10, kind: 'tag_hours', tagId, value: 5 * 3600 })).id,
  ], { y: lastYear, tagId: english.id });
  await page.click('[data-nav="dashboard"]');
  await page.click('[data-dash-view="overview"]');
  await page.click('[data-period="year"]');
  await waitFor(page, (y) => [...document.querySelectorAll('#dash-year option')].some((o) => o.value === String(y)), lastYear);
  assert.equal(await page.isDisabled('#dash-prev'), false, 'earlier years are reachable');
  await page.selectOption('#dash-year', String(lastYear));
  await waitFor(page, (y) => document.querySelector('#dash-range').textContent.includes(String(y)), lastYear);
  assert.equal(await page.isVisible('#dash-body'), true, 'a year with only legacy data shows its statistics');
  const kpiPomodoros = await page.locator('#dash-kpis .kpi').first().locator('.kpi__value').textContent();
  assert.equal(kpiPomodoros, '40');
  assert.ok(await page.locator('#dash-kpis .kpi').first().locator('.legacy-mark').isVisible());
  assert.match(await page.textContent('#dash-legacy'), /Includes 40 Pomodoros and 5h 00m of tag hours entered as weekly totals, shown in the month of each week/);
  const y1 = await page.evaluate((y) => window.pomodoro.stats.report('year', new Date(y, 5, 1).getTime()), lastYear);
  assert.equal(y1.buckets[2].pomodoros, 40, 'March bar of last year');
  assert.equal(y1.summary.pomodoros, 40);
  await shot(page, '15-dashboard-last-year');
  // the arrows also move between years; back to the current one
  await page.click('#dash-next');
  await waitFor(page, (y) => document.querySelector('#dash-range').textContent.includes(String(y)), lastYear + 1);
  assert.equal(await page.inputValue('#dash-year'), String(lastYear + 1));
  await page.click('[data-period="day"]');

  await page.click('[data-nav="agenda"]');
  await page.locator('#ag-years .planner', { hasText: String(lastYear) }).first().click();
  await waitFor(page, (y) => document.querySelector('#ag-year-title').textContent === `${y} in total`, lastYear);
  await waitFor(page, () => document.querySelector('#ag-year-tally .tally__row--ttp dd').textContent === '40P');
  assert.deepEqual((await box()).yrows, [['English', '5 h']], 'that year only: legacy English hours');
  await page.click('#ag-today');
  await waitFor(page, (y) => document.querySelector('#ag-year-title').textContent === `${y} so far`, lastYear + 1);
  await waitFor(page, (v) => parseInt(document.querySelector('#ag-year-tally .tally__row--ttp dd').textContent, 10) === v, base.yttp + 15);
  await page.evaluate((ids) => Promise.all(ids.map((id) => window.pomodoro.legacy.remove(id))), oldIds);
  step(`previous year ${lastYear}: Dashboard year list + arrows reach it (40 Pomodoros, 5 h, March), Agenda "${lastYear} in total" = 40P / English 5 h; current planner back to "so far"`);

  // --- Startup sound: playlist in Settings, played once per launch, in order, skipping broken tracks
  const mediaSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-media-src-'));
  const toneA = writeWav(path.join(mediaSrc, 'Morning A.wav'), 0.5, 440);
  const broken = path.join(mediaSrc, 'Broken.mp3');
  fs.writeFileSync(broken, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 7)])); // looks like MP3, cannot be decoded
  const toneB = writeWav(path.join(mediaSrc, 'Morning B.wav'), 0.5, 660);
  const longTone = writeWav(path.join(mediaSrc, 'Long C.wav'), 6, 520);
  const notes = path.join(mediaSrc, 'notes.txt');
  fs.writeFileSync(notes, 'not audio');
  const wallPng = writePng(path.join(mediaSrc, 'Lake view.png'), 320, 180);
  const pickFiles = (list) => app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, list);

  await page.click('[data-nav="settings"]');
  assert.equal(await page.isChecked('#s-startup-on'), false, 'off by default');
  await pickFiles([toneA, broken, notes, toneB, longTone]);
  await page.click('#s-startup-add');
  await waitFor(page, () => document.querySelectorAll('#s-startup-list .track').length === 4);
  assert.deepEqual(await page.locator('#s-startup-list .track__name').allTextContents(), ['Morning A.wav', 'Broken.mp3', 'Morning B.wav', 'Long C.wav']);
  assert.match(await page.textContent('#s-startup-error'), /"notes\.txt" is not a supported sound file/);
  assert.equal(await page.locator('#s-startup-list .track[data-selected="true"]').count(), 4, 'new tracks are selected');
  // deselect the long one (it stays in the playlist, visibly dimmed)
  await page.locator('#s-startup-list .track', { hasText: 'Long C.wav' }).locator('input[type="checkbox"]').uncheck();
  await waitFor(page, () => document.querySelector('#s-startup-list .track:last-child').dataset.selected === 'false');
  assert.equal(await page.locator('#s-startup-list .track:last-child').evaluate((el) => getComputedStyle(el).opacity), '0.6');
  assert.match(await page.textContent('#s-startup-count'), /3 of 4 selected/);
  // preview: plays that one track; the alarm takes over at once
  await page.locator('#s-startup-list .track', { hasText: 'Long C.wav' }).locator('.track__play').click();
  await waitFor(page, () => document.querySelector('#s-startup-list .track[data-playing="true"] .track__name')?.textContent === 'Long C.wav');
  await page.click('#s-test-sound');
  await waitFor(page, () => !document.querySelector('#s-startup-list .track[data-playing="true"]'));
  // switch on, every launch, volume 40
  await page.check('#s-startup-on');
  await page.selectOption('#s-startup-mode', 'launch');
  await setSetting(page, '#s-startup-volume', 40);
  await waitFor(page, () => window.pomodoro.settings.get().then((st) => st.startupSoundEnabled && st.startupSoundMode === 'launch' && st.startupSoundVolume === 40));
  step('Startup sound playlist: 4 tracks added (notes.txt refused), one deselected and dimmed, preview stopped by the alarm, every launch at 40%');

  await app.close();
  ({ app, page } = await launch());
  await waitFor(page, () => document.documentElement.dataset.startupSound === 'played');
  await waitFor(page, () => (window.__startupSoundLog || []).some((e) => e.event === 'done'), null, { timeout: 15000 });
  const playLog = await page.evaluate(() => window.__startupSoundLog.map((e) => `${e.event}:${e.name || ''}`));
  assert.deepEqual(playLog.filter((e) => /^(start|skip|end)/.test(e)),
    ['start:Morning A.wav', 'end:Morning A.wav', 'skip:Broken.mp3', 'start:Morning B.wav', 'end:Morning B.wav'],
    'selected tracks in order, one at a time; the broken one skipped; the deselected one not played');
  assert.deepEqual(await page.evaluate(() => window.pomodoro.startupSound.claim()), { play: false, reason: 'already-claimed', tracks: [] }, 'never twice in one launch');
  step(`launch: startup playlist played automatically in order (${playLog.filter((e) => e.startsWith('start')).length} tracks, broken one skipped), only once`);

  // once a day: it already played today, so the next launch is quiet
  await page.click('[data-nav="settings"]');
  await page.selectOption('#s-startup-mode', 'daily');
  await waitFor(page, () => window.pomodoro.settings.get().then((st) => st.startupSoundMode === 'daily'));
  await app.close();
  ({ app, page } = await launch());
  await waitFor(page, () => document.documentElement.dataset.startupSound === 'played-today');
  assert.equal((await page.evaluate(() => window.__startupSoundLog || [])).length, 0);
  step('"Once a day": not played again on the same day (persisted across restarts)');

  // remove a track: its copy goes, the original stays
  await page.click('[data-nav="settings"]');
  const mediaDir = path.join(dataDir, 'media', 'startup-sounds');
  const beforeRemove = fs.readdirSync(mediaDir).length;
  await page.locator('#s-startup-list .track', { hasText: 'Broken.mp3' }).locator('.track__remove').click();
  await page.click('#confirm-ok');
  await waitFor(page, () => document.querySelectorAll('#s-startup-list .track').length === 3);
  assert.equal(fs.readdirSync(mediaDir).length, beforeRemove - 1);
  assert.ok(fs.existsSync(broken), 'the original file is untouched');
  await page.uncheck('#s-startup-on');
  step('track removed (its stored copy deleted, the original kept); startup sound switched off');

  // --- Focus wallpaper: preview, apply, Focus page only, darken, off, persists, remove
  await pickFiles([notes]);
  await page.click('#s-wall-pick');
  await waitFor(page, () => !document.querySelector('#s-wall-error').hidden);
  assert.match(await page.textContent('#s-wall-error'), /not a supported image file/);
  await pickFiles([wallPng]);
  await page.click('#s-wall-pick');
  await waitFor(page, () => document.querySelector('#s-wall-preview').dataset.state === 'pending');
  assert.match(await page.textContent('#s-wall-caption'), /Preview: Lake view\.png/);
  assert.equal(await page.evaluate(() => window.pomodoro.wallpaper.get()), null, 'a preview is not applied');
  await page.click('#s-wall-apply');
  await waitFor(page, () => document.querySelector('#s-wall-preview').dataset.state === 'current');
  assert.equal(await page.isChecked('#s-wall-on'), true, 'applying switches it on');
  await setSetting(page, '#s-wall-dim', 40);

  const mainBg = () => page.evaluate(() => {
    const m = document.querySelector('#main');
    return { on: m.classList.contains('has-wallpaper'), img: getComputedStyle(m).backgroundImage, size: getComputedStyle(m).backgroundSize, dim: m.style.getPropertyValue('--wallpaper-dim') };
  });
  await page.click('[data-nav="focus"]');
  await waitFor(page, () => document.querySelector('#main').classList.contains('has-wallpaper'));
  let bg = await mainBg();
  assert.match(bg.img, /app:\/\/local\/media\/wallpapers\/[0-9a-f-]+\.png/);
  assert.equal(bg.size, 'cover, cover, cover');
  assert.equal(bg.dim, '0.4');
  assert.ok(await page.isVisible('#btn-main'), 'timer controls still visible');
  await shot(page, '16-focus-wallpaper');
  for (const other of ['dashboard', 'agenda', 'tasks', 'goals', 'history', 'settings']) {
    await page.click(`[data-nav="${other}"]`);
    bg = await mainBg();
    assert.equal(bg.on, false, `no wallpaper on ${other}`);
    assert.equal(bg.img, 'none', `${other} background untouched`);
  }
  await page.uncheck('#s-wall-on');
  await page.click('[data-nav="focus"]');
  await page.waitForTimeout(200);
  assert.equal((await mainBg()).on, false, 'switched off');
  await page.click('[data-nav="settings"]');
  await page.check('#s-wall-on');
  await app.close();
  ({ app, page } = await launch());
  await waitFor(page, () => document.querySelector('#main').classList.contains('has-wallpaper'));
  step('Focus wallpaper: refused .txt, previewed, applied, cover + 40% darken on Focus only (6 other pages untouched), switch off/on, kept after restart');

  await page.click('[data-nav="settings"]');
  await page.click('#s-wall-remove');
  await page.click('#confirm-ok');
  await waitFor(page, () => document.querySelector('#s-wall-preview').dataset.state === 'none');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'media', 'wallpapers')), [], 'its stored copy is deleted');
  assert.ok(fs.existsSync(wallPng));
  await page.click('[data-nav="focus"]');
  assert.equal((await mainBg()).on, false);
  step('wallpaper removed: Focus back to normal, stored copy deleted, original kept');

  // everything persists after a restart
  await app.close();
  ({ app, page } = await launch());
  await page.click('[data-nav="agenda"]');
  await waitFor(page, (k) => document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`)?.textContent.endsWith('Fireworks!'), todayKey);
  assert.equal((await page.evaluate(() => window.pomodoro.legacy.list())).map((r) => `${r.kind}:${r.value}`).join(), 'pomodoros:15', 'legacy record persists');
  await page.click('[data-nav="goals"]');
  await page.waitForSelector('.goal >> text=Complete my research project');
  // delete the note
  await page.click('[data-nav="agenda"]');
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__del`);
  await page.click('#confirm-ok');
  await waitFor(page, (k) => !document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`), todayKey);
  step('notes, goals, tags and legacy data persist after restart; note deleted');

  // --- restore of a running session after a hard kill
  await page.click('[data-nav="focus"]');
  await page.evaluate(() => window.pomodoro.timer.skip());          // long break -> focus
  await page.click('#btn-main');
  await page.waitForTimeout(1500);
  app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  ({ app, page } = await launch());
  await waitFor(page, () => document.body.dataset.status === 'paused');
  assert.ok(await page.isVisible('#focus-banner'));
  step('running session restored as paused after a crash');
  await shot(page, '08-restored');

  await app.close();
  console.log('\nAll end-to-end checks passed.');
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
