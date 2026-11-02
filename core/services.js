'use strict';

/**
 * Wires the database, repositories, timer engine and statistics together.
 * Electron's main process exposes a narrow, validated subset of this over IPC.
 */

const fs = require('fs');
const path = require('path');
const { Database, ImportError } = require('./database/database');
const { SettingsRepository } = require('./database/repositories/settings-repository');
const { TasksRepository } = require('./database/repositories/tasks-repository');
const { SessionsRepository } = require('./database/repositories/sessions-repository');
const { StateRepository } = require('./database/repositories/state-repository');
const { StepsRepository } = require('./database/repositories/steps-repository');
const { TagsRepository } = require('./database/repositories/tags-repository');
const { NotesRepository } = require('./database/repositories/notes-repository');
const { GoalsRepository } = require('./database/repositories/goals-repository');
const { LegacyRepository } = require('./database/repositories/legacy-repository');
const { MediaRepository } = require('./database/repositories/media-repository');
const { MediaStore } = require('./media-store');
const {
  localDate, cleanDate, startOfLocalDate, addDaysToDate, weekRange, weeksInYear, weekOfDate,
} = require('./dates');
const { TimerEngine } = require('./timer-engine');
const stats = require('./stats');

const iso = (ms) => new Date(ms).toISOString();

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function createServices({ dbPath, mediaDir = null, clock = () => Date.now(), secondsPerMinute = 60, engineOptions = {} } = {}) {
  const db = await Database.open(dbPath);
  const settingsRepo = new SettingsRepository(db, clock);
  const tasksRepo = new TasksRepository(db, clock);
  const sessionsRepo = new SessionsRepository(db);
  const stateRepo = new StateRepository(db);
  const stepsRepo = new StepsRepository(db, clock);
  const tagsRepo = new TagsRepository(db, clock);
  const notesRepo = new NotesRepository(db, clock);
  const goalsRepo = new GoalsRepository(db, clock);
  const legacyRepo = new LegacyRepository(db, clock);
  const mediaRepo = new MediaRepository(db, clock);
  const media = new MediaStore(mediaDir);
  try { media.cleanPending('wallpaper'); } catch (_) { /* best effort */ }
  const engine = new TimerEngine({
    db, stateRepo, sessionsRepo, tasksRepo, settingsRepo, clock, secondsPerMinute, ...engineOptions,
  });

  function report({ period, anchor }) {
    const settings = settingsRepo.getAll();
    const anchorMs = Number.isFinite(Number(anchor)) ? Number(anchor) : clock();
    const cur = stats.periodRange(period, anchorMs, settings.weekStart);
    const prev = stats.previousRange(period, anchorMs, settings.weekStart);
    const rows = sessionsRepo.overlapping(iso(prev.start), iso(cur.end));
    const tasksCompleted = tasksRepo.completedBetween(iso(cur.start), iso(cur.end)).length;
    const tasksCompletedPrev = tasksRepo.completedBetween(iso(prev.start), iso(prev.end)).length;
    // Legacy weekly totals for both periods, placed on their week's anchor day
    // (same rule as the Agenda and Activity Statistics, same week setting).
    const legacy = legacyIn(prev.start, cur.end).map((l) => ({
      anchorMs: startOfLocalDate(weekRange(l.year, l.week, settings.weekStart).anchor),
      pomodoros: l.kind === 'pomodoros' ? l.value : 0,
      seconds: l.kind === 'tag_hours' && l.tag_id ? l.value : 0,
    }));
    const r = stats.buildReport({
      period, anchor: anchorMs, sessions: rows, legacy, tasksCompleted, tasksCompletedPrev, settings, now: clock(),
    });
    r.firstSessionAt = sessionsRepo.firstStartedAt();
    r.firstRecordAt = firstRecordAt();
    r.years = productivityYears();
    return r;
  }

  /** Earliest moment with productivity data: the first session or the first legacy week. */
  function firstRecordAt() {
    const candidates = [];
    const s = sessionsRepo.firstStartedAt();
    if (s) candidates.push(Date.parse(s));
    const ws = settingsRepo.getAll().weekStart;
    for (const r of db.all('SELECT year, MIN(week) AS week FROM legacy_records GROUP BY year ORDER BY year LIMIT 1')) {
      candidates.push(startOfLocalDate(weekRange(r.year, r.week, ws).from));
    }
    return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
  }

  /** Years with productivity records (sessions or legacy data), plus the current year, oldest first. */
  function productivityYears() {
    const years = new Set([new Date(clock()).getFullYear()]);
    for (const r of db.all("SELECT DISTINCT substr(ended_at, 1, 4) AS y FROM sessions WHERE substr(ended_at, 6, 5) NOT IN ('01-01', '12-31')")) years.add(Number(r.y));
    for (const r of db.all("SELECT ended_at FROM sessions WHERE substr(ended_at, 6, 5) IN ('01-01', '12-31')")) {
      years.add(new Date(Date.parse(r.ended_at)).getFullYear());
    }
    for (const y of legacyRepo.years()) years.add(y);
    return [...years].filter((y) => Number.isInteger(y) && y >= 1970).sort((a, b) => a - b);
  }

  function today() {
    const r = report({ period: 'day', anchor: clock() });
    return {
      pomodoros: r.summary.pomodoros,
      focusSeconds: r.summary.focusSeconds,
      dailyGoal: r.goal.dailyGoal,
      progress: r.goal.progress,
      interrupted: r.summary.interruptedSessions + r.summary.abandonedSessions,
    };
  }

  function exportCsv() {
    const header = [
      'id', 'session_type', 'status', 'completed', 'planned_duration_seconds', 'actual_duration_seconds',
      'started_at_utc', 'ended_at_utc', 'task_id', 'task_title', 'tags',
    ];
    const tagRows = db.all('SELECT session_id, group_concat(tag_name, \'; \') AS tags FROM session_tags GROUP BY session_id');
    const tagMap = new Map(tagRows.map((r) => [r.session_id, r.tags]));
    const lines = [header.join(',')];
    for (const r of sessionsRepo.all()) {
      lines.push([
        r.id, r.session_type, r.status, r.completed, r.planned_duration_seconds, r.actual_duration_seconds,
        r.started_at, r.ended_at, r.task_id, r.display_task_title, tagMap.get(r.id) || '',
      ].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  /** Adds steps, step counts and tags to task rows. */
  function decorateTasks(tasks) {
    const ids = tasks.map((t) => t.id);
    const steps = stepsRepo.forTasks(ids);
    const tags = tagsRepo.forTasks(ids);
    return tasks.map((t) => {
      const list = steps.get(t.id) || [];
      return {
        ...t,
        steps: list,
        steps_total: list.length,
        steps_done: list.filter((s) => s.completed).length,
        tags: tags.get(t.id) || [],
      };
    });
  }

  /** Tasks with their ordered steps, step counts and tags attached. */
  function listTasks(status = 'all') {
    return decorateTasks(tasksRepo.list({ status }));
  }

  // ------------------------------------------------------------ activity time
  // Single source for Agenda (TTP, H.E.), Activity Statistics and goals:
  // completed focus sessions, attributed to the moment they ended, classified
  // by the tags snapshotted onto each session when it was recorded.

  const MIN_ISO = '0000-01-01T00:00:00.000Z';
  const MAX_ISO = '9999-12-31T23:59:59.999Z';

  function isoRange(fromMs, toMs) {
    return [
      Number.isFinite(fromMs) ? iso(fromMs) : MIN_ISO,
      Number.isFinite(toMs) ? iso(toMs) : MAX_ISO,
    ];
  }

  /**
   * The tags whose hours the Agenda shows next to TTP (Settings → Agenda →
   * Tags in the Agenda), in tag-name order. Until a list is chosen, the
   * earlier single choice (or the tag named "English") is used.
   */
  function hoursTags() {
    const s = settingsRepo.getAll();
    if (Array.isArray(s.hoursTagIds)) {
      const chosen = new Set(s.hoursTagIds);
      return tagsRepo.list().filter((t) => chosen.has(t.id)).map((t) => ({ id: t.id, name: t.name, color: t.color }));
    }
    const t = hoursTag();
    return t ? [{ id: t.id, name: t.name, color: t.color }] : [];
  }

  /** The tag whose time is shown as H.E. in the Agenda. */
  function hoursTag() {
    const id = settingsRepo.getAll().hoursTagId;
    if (id) {
      const t = tagsRepo.get(id);
      if (t) return t;
    }
    return tagsRepo.findByName('English');
  }

  // ------------------------------------------------------------ legacy data

  const weekStartSetting = () => settingsRepo.getAll().weekStart;

  /**
   * Legacy (hand-entered weekly) records that fall in [fromMs, toMs): a week
   * counts in a range when its anchor day does (see core/dates.js), using the
   * current "Weeks start on" setting. Missing bounds mean open-ended.
   */
  function legacyIn(fromMs, toMs) {
    const ws = weekStartSetting();
    const lo = Number.isFinite(fromMs) ? fromMs : -Infinity;
    const hi = Number.isFinite(toMs) ? toMs : Infinity;
    return db.all('SELECT id, year, week, kind, tag_id, value FROM legacy_records').filter((r) => {
      const a = startOfLocalDate(weekRange(r.year, r.week, ws).anchor);
      return a >= lo && a < hi;
    });
  }

  /** Totals of legacy records in a range: Pomodoros, and seconds per tag id. */
  function legacyTotals(fromMs, toMs) {
    const out = { pomodoros: 0, seconds: 0, byTag: new Map(), rows: [] };
    for (const r of legacyIn(fromMs, toMs)) {
      out.rows.push(r);
      if (r.kind === 'pomodoros') out.pomodoros += r.value;
      else if (r.tag_id) {
        out.seconds += r.value;
        out.byTag.set(r.tag_id, (out.byTag.get(r.tag_id) || 0) + r.value);
      }
    }
    return out;
  }

  /** Legacy records (optionally one year) with their dates under the current week setting. */
  function legacyList(year) {
    const ws = weekStartSetting();
    return legacyRepo.list({ year }).map((r) => {
      const range = weekRange(r.year, r.week, ws);
      return { ...r, from: range.from, to: range.to, inYear: r.week <= weeksInYear(r.year, ws) };
    });
  }

  /** The weeks of a year (per "Weeks start on") for the Legacy Data picker, plus today's week. */
  function legacyWeeks(year) {
    const ws = weekStartSetting();
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1970 || y > 2200) throw new Error('Year must be between 1970 and 2200.');
    const weeks = [];
    for (let w = 1; w <= weeksInYear(y, ws); w += 1) {
      const r = weekRange(y, w, ws);
      weeks.push({ week: w, from: r.from, to: r.to });
    }
    return { year: y, weekStart: ws, weeks, current: weekOfDate(localDate(clock()), ws) };
  }

  function saveLegacy(input) {
    return legacyRepo.save(input, weekStartSetting());
  }

  /** Per-tag totals for completed focus sessions that ended in [from, to). */
  function activityStats({ from, to } = {}) {
    const [a, b] = isoRange(from, to);
    const rows = db.all(
      `SELECT t.id, t.name, t.color, COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(s.actual_duration_seconds), 0) AS seconds
         FROM tags t
         LEFT JOIN session_tags st ON st.tag_id = t.id
         LEFT JOIN sessions s ON s.id = st.session_id AND s.session_type = 'focus' AND s.completed = 1
                             AND s.ended_at >= ? AND s.ended_at < ?
        GROUP BY t.id ORDER BY seconds DESC, t.name COLLATE NOCASE`,
      [a, b],
    );
    const total = db.get(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(actual_duration_seconds), 0) AS seconds FROM sessions
        WHERE session_type = 'focus' AND completed = 1 AND ended_at >= ? AND ended_at < ?`, [a, b],
    );
    const untagged = db.get(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(actual_duration_seconds), 0) AS seconds FROM sessions s
        WHERE s.session_type = 'focus' AND s.completed = 1 AND s.ended_at >= ? AND s.ended_at < ?
          AND NOT EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = s.id AND st.tag_id IS NOT NULL)`, [a, b],
    );
    const first = db.get("SELECT MIN(ended_at) AS first FROM sessions WHERE session_type = 'focus' AND completed = 1").first;
    // Legacy records add on top: hours to their tag, weekly TTP to the total.
    const legacy = legacyTotals(from, to);
    const tags = rows.map((r) => {
      const legacySeconds = legacy.byTag.get(r.id) || 0;
      return { ...r, sessions: r.sessions || 0, seconds: r.seconds + legacySeconds, legacySeconds };
    }).sort((x, y) => y.seconds - x.seconds || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
    return {
      tags,
      total: {
        sessions: total.sessions + legacy.pomodoros,
        seconds: total.seconds + legacy.seconds,
        legacyPomodoros: legacy.pomodoros,
        legacySeconds: legacy.seconds,
      },
      untagged,
      firstSessionAt: first,
    };
  }

  /** One tag in detail: totals, per-task breakdown and per-month series. */
  function activityDetail(tagId, { from, to } = {}) {
    const tag = tagsRepo.get(tagId);
    if (!tag) throw new Error('That tag no longer exists.');
    const [a, b] = isoRange(from, to);
    const rows = db.all(
      `SELECT s.id, s.ended_at, s.actual_duration_seconds AS seconds, COALESCE(tk.title, s.task_title, 'Deleted task') AS task
         FROM session_tags st JOIN sessions s ON s.id = st.session_id
         LEFT JOIN tasks tk ON tk.id = s.task_id
        WHERE st.tag_id = ? AND s.session_type = 'focus' AND s.completed = 1 AND s.ended_at >= ? AND s.ended_at < ?
        ORDER BY s.ended_at`,
      [tag.id, a, b],
    );
    const byTask = new Map();
    const byMonth = new Map();
    let seconds = 0;
    for (const r of rows) {
      seconds += r.seconds;
      const t = byTask.get(r.task) || { task: r.task, sessions: 0, seconds: 0 };
      t.sessions += 1; t.seconds += r.seconds; byTask.set(r.task, t);
      const d = new Date(Date.parse(r.ended_at));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const m = byMonth.get(key) || { month: key, sessions: 0, seconds: 0 };
      m.sessions += 1; m.seconds += r.seconds; byMonth.set(key, m);
    }
    // Legacy hours for this tag: added to the total, the months (by week anchor) and a "Legacy records" line.
    const ws = weekStartSetting();
    let legacySeconds = 0;
    for (const r of legacyIn(from, to)) {
      if (r.kind !== 'tag_hours' || r.tag_id !== tag.id) continue;
      legacySeconds += r.value;
      const key = weekRange(r.year, r.week, ws).anchor.slice(0, 7);
      const m = byMonth.get(key) || { month: key, sessions: 0, seconds: 0 };
      m.seconds += r.value; m.legacySeconds = (m.legacySeconds || 0) + r.value; byMonth.set(key, m);
    }
    seconds += legacySeconds;
    if (legacySeconds) byTask.set('\u0000legacy', { task: 'Legacy records', legacy: true, sessions: 0, seconds: legacySeconds });
    return {
      tag,
      sessions: rows.length,
      seconds,
      legacySeconds,
      firstAt: rows.length ? rows[0].ended_at : null,
      lastAt: rows.length ? rows[rows.length - 1].ended_at : null,
      byTask: [...byTask.values()].sort((x, y) => y.seconds - x.seconds),
      byMonth: [...byMonth.values()].sort((x, y) => x.month.localeCompare(y.month)),
    };
  }

  /** Seconds of completed focus with a tag between two timestamps, plus legacy hours on that tag (for goals). */
  function tagSeconds(tagId, fromMs, toMs) {
    const [a, b] = isoRange(fromMs, toMs);
    const tracked = db.get(
      `SELECT COALESCE(SUM(s.actual_duration_seconds), 0) AS seconds FROM session_tags st JOIN sessions s ON s.id = st.session_id
        WHERE st.tag_id = ? AND s.session_type = 'focus' AND s.completed = 1 AND s.ended_at >= ? AND s.ended_at < ?`,
      [tagId, a, b],
    ).seconds;
    return tracked + (legacyTotals(fromMs, toMs).byTag.get(tagId) || 0);
  }

  // ------------------------------------------------------------ agenda

  /**
   * A run of days (default one week) starting at a local date: each day's
   * scheduled tasks, its note, TTP (completed Pomodoros that ended that day)
   * and H.E. (seconds of those Pomodoros tagged with the hours tag).
   */
  function agendaDays(startDate, count = 7) {
    const first = cleanDate(startDate, 'Start date');
    const n = Math.min(Math.max(Number(count) || 7, 1), 42);
    const last = addDaysToDate(first, n - 1);
    const fromMs = startOfLocalDate(first);
    const toMs = startOfLocalDate(addDaysToDate(last, 1));
    const tags = hoursTags();                 // tags shown next to TTP (Settings)
    const tagIds = new Set(tags.map((t) => t.id));

    const tasks = decorateTasks(tasksRepo.scheduledBetween(first, last));
    const notes = new Map(notesRepo.between(first, last).map((x) => [x.note_date, x]));
    const sessions = db.all(
      `SELECT s.id, s.ended_at, s.actual_duration_seconds AS seconds,
              (SELECT group_concat(st.tag_id) FROM session_tags st WHERE st.session_id = s.id AND st.tag_id IS NOT NULL) AS tag_ids
         FROM sessions s
        WHERE s.session_type = 'focus' AND s.completed = 1 AND s.ended_at >= ? AND s.ended_at < ?`,
      [iso(fromMs), iso(toMs)],
    );

    const zero = () => Object.fromEntries(tags.map((t) => [t.id, 0]));
    const days = [];
    const index = new Map();
    for (let i = 0; i < n; i += 1) {
      const date = addDaysToDate(first, i);
      const day = { date, tasks: [], note: notes.get(date) || null, ttp: 0, hoursSeconds: 0, focusSeconds: 0, tagSeconds: zero() };
      index.set(date, day);
      days.push(day);
    }
    for (const t of tasks) index.get(t.scheduled_date)?.tasks.push(t);
    for (const s of sessions) {
      const day = index.get(localDate(Date.parse(s.ended_at)));
      if (!day) continue;
      day.ttp += 1;
      day.focusSeconds += s.seconds;
      for (const id of String(s.tag_ids || '').split(',').filter(Boolean).map(Number)) {
        if (tagIds.has(id)) day.tagSeconds[id] += s.seconds;
      }
    }
    const firstTag = tags[0] || null;
    for (const d of days) d.hoursSeconds = firstTag ? d.tagSeconds[firstTag.id] : 0;

    const week = days.reduce((acc, d) => ({
      ttp: acc.ttp + d.ttp, focusSeconds: acc.focusSeconds + d.focusSeconds,
      tasks: acc.tasks + d.tasks.length, tasksDone: acc.tasksDone + d.tasks.filter((t) => t.status === 'completed').length,
    }), { ttp: 0, focusSeconds: 0, tasks: 0, tasksDone: 0 });
    // Legacy weeks inside this run of days (the week box): added to the
    // totals only; day rows show tracked data.
    const legacy = legacyTotals(fromMs, toMs);
    week.ttp += legacy.pomodoros;
    week.tags = tags.map((t) => {
      const legacySeconds = legacy.byTag.get(t.id) || 0;
      return { ...t, seconds: days.reduce((sum, d) => sum + d.tagSeconds[t.id], 0) + legacySeconds, legacySeconds };
    });
    week.hoursSeconds = firstTag ? week.tags[0].seconds : 0;
    const legacyTagSeconds = week.tags.reduce((sum, t) => sum + t.legacySeconds, 0);
    week.legacy = {
      pomodoros: legacy.pomodoros,
      hoursSeconds: firstTag ? week.tags[0].legacySeconds : 0,
      tagSeconds: legacyTagSeconds,
      records: legacy.rows.length,
    };
    return { from: first, to: last, days, week, tags, hoursTag: firstTag };
  }

  /** The note written on 1 January of each year (one note per day), keyed by year. */
  function yearOpeningNotes() {
    const out = {};
    for (const r of db.all("SELECT note_date, body FROM daily_notes WHERE substr(note_date, 6, 5) = '01-01' ORDER BY note_date")) {
      out[Number(r.note_date.slice(0, 4))] = r.body;
    }
    return out;
  }

  /** Years that have tasks, notes, sessions or goals, plus the current year. */
  function agendaYears() {
    const years = new Set([new Date(clock()).getFullYear()]);
    for (const r of db.all('SELECT DISTINCT substr(scheduled_date, 1, 4) AS y FROM tasks WHERE scheduled_date IS NOT NULL')) years.add(Number(r.y));
    for (const r of db.all('SELECT DISTINCT substr(note_date, 1, 4) AS y FROM daily_notes')) years.add(Number(r.y));
    for (const y of goalsRepo.years()) years.add(y);
    for (const y of legacyRepo.years()) years.add(y);
    // Session years in local time. Only sessions near New Year can differ
    // between UTC and local time, so only those are converted one by one.
    for (const r of db.all("SELECT DISTINCT substr(ended_at, 1, 4) AS y FROM sessions WHERE substr(ended_at, 6, 5) NOT IN ('01-01', '12-31')")) years.add(Number(r.y));
    for (const r of db.all("SELECT ended_at FROM sessions WHERE substr(ended_at, 6, 5) IN ('01-01', '12-31')")) {
      years.add(new Date(Date.parse(r.ended_at)).getFullYear());
    }
    return [...years].filter((y) => Number.isInteger(y) && y >= 1970).sort((a, b) => a - b);
  }

  // ------------------------------------------------------------ goals

  function goalProgress(g, milestones, linked) {
    switch (g.progress_mode) {
      case 'milestones': {
        const counted = milestones.filter((m) => m.status !== 'dropped');
        const done = counted.filter((m) => m.status === 'done').length;
        return { percent: counted.length ? (done / counted.length) * 100 : 0, label: `${done} of ${counted.length} milestones` };
      }
      case 'tasks': {
        const l = linked || { total: 0, done: 0 };
        return { percent: l.total ? (l.done / l.total) * 100 : 0, label: `${l.done} of ${l.total} linked tasks done` };
      }
      case 'activity': {
        const fromMs = new Date(g.year, 0, 1).getTime();
        const toMs = new Date(g.year + 1, 0, 1).getTime();
        const seconds = g.tag_id ? tagSeconds(g.tag_id, fromMs, toMs) : 0;
        const target = (g.target_minutes || 0) * 60;
        return { percent: target ? (seconds / target) * 100 : 0, seconds, targetSeconds: target };
      }
      default:
        return { percent: g.manual_progress, label: 'Updated manually' };
    }
  }

  function listGoals(year) {
    const goals = goalsRepo.list(year);
    const ids = goals.map((g) => g.id);
    const ms = goalsRepo.milestonesFor(ids);
    const linked = goalsRepo.linkedTaskCounts(ids);
    const tags = new Map(tagsRepo.list().map((t) => [t.id, t]));
    return goals.map((g) => {
      const milestones = ms.get(g.id) || [];
      const p = goalProgress(g, milestones, linked.get(g.id));
      return {
        ...g,
        milestones,
        linked: linked.get(g.id) || { total: 0, done: 0 },
        tag: g.tag_id && tags.get(g.tag_id) ? { id: g.tag_id, name: tags.get(g.tag_id).name, color: tags.get(g.tag_id).color } : null,
        progress: { ...p, percent: Math.max(0, Math.min(100, Math.round(p.percent))) },
      };
    });
  }

  function goalYears() {
    const ys = new Set(goalsRepo.years());
    ys.add(new Date(clock()).getFullYear());
    return [...ys].sort((a, b) => a - b);
  }

  /** Validates a backup in memory. Nothing is changed. */
  function prepareImport(bytes) {
    return Database.prepareImport(bytes);
  }

  /**
   * Replaces all data with a validated backup (from prepareImport).
   * 1. refuses while a session is in progress,
   * 2. saves a safety copy of the current database into safetyDir,
   * 3. swaps the database atomically, then reloads the timer from the new data.
   */
  function applyImport(prepared, { safetyDir }) {
    if (!prepared || !prepared.bytes) throw new ImportError('Choose a backup file first.');
    if (engine.active) {
      throw new ImportError('Finish or reset the current session before importing a backup.');
    }
    fs.mkdirSync(safetyDir, { recursive: true });
    const d = new Date(clock());
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `focus-neon-before-import-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.sqlite`;
    const safetyBackup = path.join(safetyDir, name);
    db.backupTo(safetyBackup);
    if (!fs.existsSync(safetyBackup) || fs.statSync(safetyBackup).size === 0) {
      throw new ImportError('A safety copy of your current data could not be saved, so nothing was imported.');
    }

    db.replaceWith(prepared.bytes);

    engine.active = null;
    engine.lastCompletion = null;
    engine.notice = null;
    engine.settings = settingsRepo.getAll();
    engine.init(); // restores any session saved in the backup as paused
    return { safetyBackup, summary: prepared.summary };
  }

  // ------------------------------------------------------------ startup sound & Focus wallpaper

  function trackView(r) {
    const missing = !media.exists('startup_sound', r.stored_name);
    return {
      id: r.id, name: r.original_name, bytes: r.bytes, mime: r.mime, selected: r.selected, missing,
      url: missing ? null : media.url('startup_sound', r.stored_name),
    };
  }

  /** The startup playlist in playback order; a track whose file is gone is flagged, not dropped. */
  function startupTracks() {
    return mediaRepo.list('startup_sound').map(trackView);
  }

  /** Copies picked audio files into the playlist. Bad files are skipped with a reason; the rest are added. */
  function addStartupTracks(paths = []) {
    const added = [];
    const rejected = [];
    for (const p of paths) {
      let stored = null;
      try {
        stored = media.importFile('startup_sound', p);
        added.push(trackView(mediaRepo.addTrack(stored)));
      } catch (err) {
        if (stored) media.remove('startup_sound', stored.storedName); // copied but not recorded
        rejected.push({ name: path.basename(String(p)), reason: err.message });
      }
    }
    return { added, rejected, tracks: startupTracks() };
  }

  function removeStartupTrack(id) {
    const r = mediaRepo.get(id);
    if (!r || r.kind !== 'startup_sound') throw new Error('That track is no longer in the playlist.');
    mediaRepo.delete(r.id);
    media.remove('startup_sound', r.stored_name); // only this track's own copy
    return startupTracks();
  }

  const STARTUP_KEY = 'startupSoundLastPlayedOn';

  /**
   * Decides whether the startup playlist plays now. Settings → Startup sound:
   * off -> never; "every launch" -> always; "once a day" -> only if it has
   * not played today and no Pomodoro has been completed today (local day).
   */
  function startupPlan() {
    const s = settingsRepo.getAll();
    const no = (reason) => ({ play: false, reason, tracks: [], volume: s.startupSoundVolume });
    if (!s.startupSoundEnabled) return no('off');
    const tracks = startupTracks().filter((t) => t.selected && !t.missing);
    if (!tracks.length) return no('no-tracks');
    const day = localDate(clock());
    if (s.startupSoundMode === 'daily') {
      if (stateRepo.getValue(STARTUP_KEY, null) === day) return no('played-today');
      if (today().pomodoros > 0) return no('pomodoro-done-today');
    }
    return { play: true, reason: s.startupSoundMode, tracks, volume: s.startupSoundVolume, day };
  }

  /** Called when the first startup track actually starts playing. */
  function markStartupPlayed() {
    const day = localDate(clock());
    stateRepo.setValue(STARTUP_KEY, day);
    return day;
  }

  function wallpaperInfo() {
    const r = mediaRepo.list('wallpaper')[0];
    if (!r) return null;
    const missing = !media.exists('wallpaper', r.stored_name);
    return { id: r.id, name: r.original_name, bytes: r.bytes, missing, url: missing ? null : media.url('wallpaper', r.stored_name) };
  }

  /** Copies a picked image as a preview (not applied yet). */
  function stageWallpaper(filePath) {
    const stored = media.importFile('wallpaper', filePath, { pending: true });
    return { token: stored.storedName, name: stored.originalName, bytes: stored.bytes, url: media.url('wallpaper', stored.storedName) };
  }

  /** Applies a previewed image: it replaces the current wallpaper, whose copy is then deleted. */
  function applyWallpaper(token, originalName) {
    const pendingPath = media.pathFor('wallpaper', token);
    if (!pendingPath || !/^pending-/.test(token)) throw new Error('Choose an image first.');
    const bytes = fs.statSync(pendingPath).size;
    const finalName = media.promote('wallpaper', token);
    const ext = finalName.split('.').pop();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
    const previous = mediaRepo.setWallpaper({ storedName: finalName, originalName: String(originalName || finalName).slice(0, 255), mime, bytes });
    if (previous && previous.stored_name !== finalName) media.remove('wallpaper', previous.stored_name);
    settingsRepo.update({ wallpaperEnabled: true });
    return wallpaperInfo();
  }

  function discardWallpaperPreview(token) {
    if (!/^pending-/.test(token || '')) return false;
    return media.remove('wallpaper', token);
  }

  function removeWallpaper() {
    const r = mediaRepo.list('wallpaper')[0];
    if (!r) return null;
    mediaRepo.delete(r.id);
    media.remove('wallpaper', r.stored_name);
    return null;
  }

  /** Deletes all sessions, tasks, tags, notes, goals and timer state. Settings are kept. */
  function clearAllData() {
    db.transaction(() => {
      db.run('DELETE FROM active_session');
      db.run('DELETE FROM session_tags');
      db.run('DELETE FROM sessions');
      db.run('DELETE FROM task_steps');
      db.run('DELETE FROM task_tags');
      db.run('DELETE FROM tasks');
      db.run('DELETE FROM goal_milestones');
      db.run('DELETE FROM goals');
      db.run('DELETE FROM legacy_records');
      db.run('DELETE FROM tags');
      db.run('DELETE FROM daily_notes');
      db.run('DELETE FROM app_state');
    });
    engine.active = null;
    engine.lastCompletion = null;
    engine.notice = null;
    engine.emitState();
  }

  return {
    db, settingsRepo, tasksRepo, sessionsRepo, stateRepo, stepsRepo, tagsRepo, notesRepo, goalsRepo, legacyRepo, engine,
    legacyList, legacyWeeks, saveLegacy, legacyTotals, productivityYears, firstRecordAt,
    mediaRepo, media, startupTracks, addStartupTracks, removeStartupTrack, startupPlan, markStartupPlayed,
    wallpaperInfo, stageWallpaper, applyWallpaper, discardWallpaperPreview, removeWallpaper,
    report, today, exportCsv, clearAllData, listTasks, decorateTasks, prepareImport, applyImport,
    activityStats, activityDetail, tagSeconds, hoursTag, hoursTags, agendaDays, agendaYears, yearOpeningNotes, listGoals, goalYears,
  };
}

module.exports = { createServices };
