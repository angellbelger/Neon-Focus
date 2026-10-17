'use strict';

/**
 * Wires the database, repositories, timer engine and statistics together.
 * Electron's main process exposes a narrow, validated subset of this over IPC.
 */

const { Database } = require('./database/database');
const { SettingsRepository } = require('./database/repositories/settings-repository');
const { TasksRepository } = require('./database/repositories/tasks-repository');
const { SessionsRepository } = require('./database/repositories/sessions-repository');
const { StateRepository } = require('./database/repositories/state-repository');
const { TimerEngine } = require('./timer-engine');
const stats = require('./stats');

const iso = (ms) => new Date(ms).toISOString();

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function createServices({ dbPath, clock = () => Date.now(), secondsPerMinute = 60, engineOptions = {} } = {}) {
  const db = await Database.open(dbPath);
  const settingsRepo = new SettingsRepository(db, clock);
  const tasksRepo = new TasksRepository(db, clock);
  const sessionsRepo = new SessionsRepository(db);
  const stateRepo = new StateRepository(db);
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
    const r = stats.buildReport({
      period, anchor: anchorMs, sessions: rows, tasksCompleted, tasksCompletedPrev, settings, now: clock(),
    });
    r.firstSessionAt = sessionsRepo.firstStartedAt();
    return r;
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
      'started_at_utc', 'ended_at_utc', 'task_id', 'task_title',
    ];
    const lines = [header.join(',')];
    for (const r of sessionsRepo.all()) {
      lines.push([
        r.id, r.session_type, r.status, r.completed, r.planned_duration_seconds, r.actual_duration_seconds,
        r.started_at, r.ended_at, r.task_id, r.display_task_title,
      ].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  /** Deletes all sessions, tasks and timer state. Settings are kept. */
  function clearAllData() {
    db.transaction(() => {
      db.run('DELETE FROM active_session');
      db.run('DELETE FROM sessions');
      db.run('DELETE FROM tasks');
      db.run('DELETE FROM app_state');
    });
    engine.active = null;
    engine.lastCompletion = null;
    engine.notice = null;
    engine.emitState();
  }

  return {
    db, settingsRepo, tasksRepo, sessionsRepo, stateRepo, engine,
    report, today, exportCsv, clearAllData,
  };
}

module.exports = { createServices };
