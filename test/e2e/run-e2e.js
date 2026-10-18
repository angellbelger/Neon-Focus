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
  assert.equal(order[0], todayKey, 'today is at the top');
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6].map((n) => addDaysKey(todayKey, -n)), 'then the six previous days, newest first');
  step('Agenda opens with today at the top, then the previous six days in descending order');
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
  step(`TTP updates live (${before.ttp} -> ${after.ttp}); H.E. counts only the English-tagged session`);

  // daily notes: create, edit, delete; persist after restart
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-tool--note`);
  await page.fill(`.ag-day[data-date="${todayKey}"] .ag-note__input`, "New Year's Eve with my daughter.");
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note .btn--accent`);
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.fill(`.ag-day[data-date="${todayKey}"] .ag-note__input`, "New Year's Eve with my daughter. Fireworks!");
  await page.press(`.ag-day[data-date="${todayKey}"] .ag-note__input`, 'Control+Enter');
  await waitFor(page, (k) => document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`)?.textContent.endsWith('Fireworks!'), todayKey);
  step('daily note created and edited');

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
  assert.equal(await page.locator('.ag-day').first().getAttribute('data-date'), '2024-12-31', 'a past planner opens on its last day');
  assert.equal(await page.locator('#ag-years .planner[aria-current="true"] .planner__year').textContent(), '2024');
  assert.equal((await page.textContent('#agenda-heading')).trim(), 'Cambridge 2024', 'heading follows the selected planner');
  await page.click('#ag-today');
  await page.waitForSelector(`.ag-day[data-date="${todayKey}"]`);
  assert.equal(await page.locator('.ag-day').first().getAttribute('data-date'), todayKey);
  assert.equal((await page.textContent('#agenda-heading')).trim(), `Cambridge ${nowYear}`);
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

  // everything persists after a restart
  await app.close();
  ({ app, page } = await launch());
  await page.click('[data-nav="agenda"]');
  await waitFor(page, (k) => document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`)?.textContent.endsWith('Fireworks!'), todayKey);
  await page.click('[data-nav="goals"]');
  await page.waitForSelector('.goal >> text=Complete my research project');
  // delete the note
  await page.click('[data-nav="agenda"]');
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__text`);
  await page.click(`.ag-day[data-date="${todayKey}"] .ag-note__del`);
  await page.click('#confirm-ok');
  await waitFor(page, (k) => !document.querySelector(`.ag-day[data-date="${k}"] .ag-note__text`), todayKey);
  step('notes, goals and tags persist after restart; note deleted');

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
