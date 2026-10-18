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
  await waitFor(page, () => document.body.dataset.mode === 'long_break', null, { timeout: 8000 });
  await waitFor(page, () => document.querySelector('#today-pomodoros').textContent === '2');
  assert.equal(await page.textContent('#dial-time'), '00:03', 'long break uses the saved 3-minute setting');
  step('second focus completed; interval=2 so a long break is next');

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
  for (const p of ['focus', 'dashboard', 'tasks', 'history', 'settings']) {
    await page.click(`.rail [data-nav="${p}"]`);
    await page.locator('.credit').scrollIntoViewIfNeeded();
    assert.ok(await page.isVisible('.credit'), `footer on ${p}`);
    assert.equal((await page.textContent('.credit')).trim(), 'Designed by Angell Belger');
  }
  assert.equal(await page.locator('.credit').count(), 1, 'footer is one shared element');
  step('app is named Focus Neon; footer credit shows on all five pages');

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
