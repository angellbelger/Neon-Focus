'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const MODES = ['focus', 'short_break', 'long_break'];

/** Sessions shorter than this when stopped are discarded rather than recorded. */
const MIN_RECORDED_MS = 1000;

/**
 * The single source of truth for the Pomodoro timer. Lives in the Electron
 * main process, independent of any window or page.
 *
 * Reliability rules:
 *  - Elapsed time is always computed from stored timestamps
 *    (elapsed_ms + now - segment_started_at), never by decrementing a counter.
 *    tick() only *checks* the clock; a late or missing tick cannot skew time.
 *  - Completion is processed exactly once: an in-memory guard, plus the active
 *    row being deleted and the session inserted (UNIQUE run_id) in a single
 *    transaction.
 *  - If the clock jumps forward while running (system sleep, frozen process),
 *    the session is paused at the last moment we observed it running. Time we
 *    cannot vouch for is never counted.
 *  - On restart, a running session is restored as paused at its last
 *    heartbeat, unless the heartbeat proves the planned duration had elapsed.
 */
class TimerEngine extends EventEmitter {
  constructor({
    db, stateRepo, sessionsRepo, tasksRepo, settingsRepo,
    clock = () => Date.now(),
    secondsPerMinute = 60,
    gapThresholdMs = 15000,
    heartbeatMs = 5000,
  }) {
    super();
    this.db = db;
    this.stateRepo = stateRepo;
    this.sessionsRepo = sessionsRepo;
    this.tasksRepo = tasksRepo;
    this.settingsRepo = settingsRepo;
    this.clock = clock;
    this.secondsPerMinute = secondsPerMinute;
    this.gapThresholdMs = gapThresholdMs;
    this.heartbeatMs = heartbeatMs;

    this.active = null;        // in-memory mirror of active_session
    this.completing = false;   // re-entrancy guard
    this.lastTickAt = null;
    this.lastHeartbeatAt = null;
    this.lastCompletion = null;
    this.notice = null;
    this.settings = settingsRepo.getAll();
  }

  // ---------------------------------------------------------------- helpers

  static iso(ms) { return new Date(ms).toISOString(); }

  static parse(iso) { return iso ? Date.parse(iso) : null; }

  cycle() {
    const c = this.stateRepo.getValue('cycle', null);
    if (c && MODES.includes(c.mode) && Number.isInteger(c.focusDone) && c.focusDone >= 0) return c;
    return { mode: 'focus', focusDone: 0 };
  }

  selectedTaskId() {
    const id = this.stateRepo.getValue('selectedTaskId', null);
    return Number.isInteger(id) ? id : null;
  }

  plannedSecondsFor(mode) {
    const s = this.settings;
    const minutes = mode === 'focus' ? s.focusMinutes : mode === 'short_break' ? s.shortBreakMinutes : s.longBreakMinutes;
    return minutes * this.secondsPerMinute;
  }

  rowToActive(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      taskId: row.task_id,
      sessionType: row.session_type,
      plannedMs: row.planned_duration_seconds * 1000,
      startedAtMs: TimerEngine.parse(row.started_at),
      state: row.state,
      elapsedMs: row.elapsed_ms,
      segStartMs: TimerEngine.parse(row.segment_started_at),
      heartbeatMs: TimerEngine.parse(row.last_heartbeat_at),
    };
  }

  reloadActive() {
    this.active = this.rowToActive(this.stateRepo.getActive());
    return this.active;
  }

  elapsedAt(now) {
    const a = this.active;
    if (!a) return 0;
    if (a.state === 'running') return a.elapsedMs + Math.max(0, now - a.segStartMs);
    return a.elapsedMs;
  }

  taskInfo(taskId) {
    if (!taskId) return null;
    const t = this.tasksRepo.getById(taskId);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      estimatedPomodoros: t.estimated_pomodoros,
      completedPomodoros: t.completed_pomodoros,
      status: t.status,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Restores any session left over from a previous run. Call once at startup. */
  init() {
    const now = this.clock();
    this.reloadActive();
    const a = this.active;
    if (a && a.state === 'running') {
      const lastSeen = a.heartbeatMs ?? a.segStartMs;
      const elapsedAtLastSeen = a.elapsedMs + Math.max(0, lastSeen - a.segStartMs);
      if (elapsedAtLastSeen >= a.plannedMs) {
        // The app was demonstrably running when the session reached zero.
        this.complete(a.segStartMs + (a.plannedMs - a.elapsedMs));
      } else {
        this.db.transaction(() => this.stateRepo.setPaused(elapsedAtLastSeen, TimerEngine.iso(lastSeen)));
        this.reloadActive();
        this.notice = {
          kind: 'restored',
          message: 'Your last session was restored and paused where the app last saw it running.',
          at: now,
        };
      }
    } else if (a && a.state === 'paused') {
      this.notice = { kind: 'restored', message: 'Your paused session was restored.', at: now };
    }
    this.lastTickAt = now;
    this.emitState();
  }

  /** Re-reads settings (call after settings change). */
  refreshSettings() {
    this.settings = this.settingsRepo.getAll();
    this.emitState();
  }

  // ---------------------------------------------------------------- commands

  start() {
    const now = this.clock();
    if (this.active) {
      if (this.active.state === 'paused') return this.resume();
      return this.getState(); // already running: never start a second timer
    }
    const { mode } = this.cycle();
    const taskId = mode === 'focus' ? this.selectedTaskId() : null;
    const startedAt = TimerEngine.iso(now);
    this.db.transaction(() => {
      this.stateRepo.insertActive({
        runId: crypto.randomUUID(),
        taskId,
        sessionType: mode,
        plannedSeconds: this.plannedSecondsFor(mode),
        startedAt,
      });
    });
    this.reloadActive();
    this.lastTickAt = now;
    this.lastHeartbeatAt = now;
    this.lastCompletion = null;
    this.notice = null;
    this.emitState();
    return this.getState();
  }

  pause() {
    if (!this.active || this.active.state !== 'running') return this.getState();
    this.pauseAt(this.clock());
    return this.getState();
  }

  pauseAt(atMs, reason = null) {
    const elapsed = Math.min(this.elapsedAt(atMs), this.active.plannedMs - 1);
    this.db.transaction(() => this.stateRepo.setPaused(elapsed, TimerEngine.iso(atMs)));
    this.reloadActive();
    if (reason) {
      this.notice = {
        kind: 'auto-paused',
        reason,
        message: reason === 'sleep'
          ? 'Paused because your computer went to sleep. Time asleep was not counted.'
          : 'Paused automatically.',
        at: this.clock(),
      };
      this.emit('notice', this.notice);
    }
    this.emitState();
  }

  resume() {
    if (!this.active || this.active.state !== 'paused') return this.getState();
    const now = this.clock();
    this.db.transaction(() => this.stateRepo.setRunning(TimerEngine.iso(now)));
    this.reloadActive();
    this.lastTickAt = now;
    this.lastHeartbeatAt = now;
    this.notice = null;
    this.emitState();
    return this.getState();
  }

  /** Stops the current session without completing it; mode stays the same. */
  reset() {
    if (this.active) this.finishIncomplete('interrupted');
    this.lastCompletion = null;
    this.notice = null;
    this.emitState();
    return this.getState();
  }

  /** Moves on to the next mode without counting the current session. */
  skip() {
    const mode = this.active ? this.active.sessionType : this.cycle().mode;
    this.db.transaction(() => {
      if (this.active) this.finishIncomplete('abandoned');
      this.advanceCycle(mode, false);
    });
    this.lastCompletion = null;
    this.notice = null;
    this.emitState();
    return this.getState();
  }

  /** Chooses the mode of the next session. Only allowed while idle. */
  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('Unknown mode.');
    if (this.active) throw new Error('Stop or finish the current session before switching mode.');
    const c = this.cycle();
    this.stateRepo.setValue('cycle', { ...c, mode });
    this.lastCompletion = null;
    this.emitState();
    return this.getState();
  }

  /** Selects the task for focus sessions (null clears it). */
  setTask(taskId) {
    let id = null;
    if (taskId !== null && taskId !== undefined) {
      const t = this.tasksRepo.getById(taskId);
      if (!t) throw new Error('That task no longer exists.');
      id = t.id;
    }
    this.db.transaction(() => {
      this.stateRepo.setValue('selectedTaskId', id);
      if (this.active && this.active.sessionType === 'focus') this.stateRepo.setTask(id);
    });
    this.reloadActive();
    this.emitState();
    return this.getState();
  }

  /** Called when a task is deleted so the selection doesn't point at nothing. */
  onTaskRemoved(taskId) {
    if (this.selectedTaskId() === taskId) this.stateRepo.setValue('selectedTaskId', null);
    this.reloadActive();
    this.emitState();
  }

  /** System is about to sleep: pause now so sleep time is not counted. */
  suspend() {
    if (this.active && this.active.state === 'running') {
      this.tick(); // finish first if it was already due
      if (this.active && this.active.state === 'running') this.pauseAt(this.clock(), 'sleep');
    }
  }

  /** Periodic check; safe to call at any frequency. */
  tick() {
    const now = this.clock();
    const last = this.lastTickAt ?? now;
    this.lastTickAt = now;
    const a = this.active;
    if (!a || a.state !== 'running') return;

    const remainingAtSegStart = a.plannedMs - a.elapsedMs;
    const dueAt = a.segStartMs + remainingAtSegStart;

    if (now - last > this.gapThresholdMs) {
      // We weren't running for a while (sleep / suspended process).
      if (last >= dueAt) this.complete(dueAt);
      else this.pauseAt(last, 'sleep');
      return;
    }

    if (now >= dueAt) {
      this.complete(dueAt);
      return;
    }

    if (now - (this.lastHeartbeatAt ?? 0) >= this.heartbeatMs) {
      this.lastHeartbeatAt = now;
      this.stateRepo.heartbeat(TimerEngine.iso(now));
    }
  }

  // ---------------------------------------------------------------- internals

  /** Records the active session as interrupted/abandoned and clears it. */
  finishIncomplete(status) {
    const a = this.active;
    if (!a) return;
    const now = this.clock();
    const elapsed = Math.min(this.elapsedAt(now), a.plannedMs - 1);
    const task = a.taskId ? this.tasksRepo.getById(a.taskId) : null;
    this.db.transaction(() => {
      if (elapsed >= MIN_RECORDED_MS) {
        this.sessionsRepo.record({
          runId: a.runId,
          taskId: task ? task.id : null,
          taskTitle: task ? task.title : null,
          sessionType: a.sessionType,
          plannedSeconds: a.plannedMs / 1000,
          actualSeconds: Math.floor(elapsed / 1000),
          startedAt: TimerEngine.iso(a.startedAtMs),
          endedAt: TimerEngine.iso(Math.max(now, a.startedAtMs)),
          status,
        });
      }
      this.stateRepo.clearActive(a.runId);
    });
    this.active = null;
  }

  /** Marks the cycle position after a session of `type` ends. */
  advanceCycle(type, counted) {
    const c = this.cycle();
    const interval = this.settings.longBreakInterval;
    let { focusDone } = c;
    let mode;
    if (type === 'focus') {
      if (counted) {
        focusDone += 1;
        mode = focusDone >= interval ? 'long_break' : 'short_break';
      } else {
        mode = 'short_break';
      }
    } else if (type === 'long_break') {
      focusDone = 0;
      mode = 'focus';
    } else {
      mode = 'focus';
    }
    const next = { mode, focusDone };
    this.stateRepo.setValue('cycle', next);
    return next;
  }

  /** Completes the active session exactly once. endedAtMs = moment it reached zero. */
  complete(endedAtMs) {
    if (this.completing) return;
    const a = this.active;
    if (!a) return;
    this.completing = true;
    try {
      const task = a.taskId ? this.tasksRepo.getById(a.taskId) : null;
      let recorded = false;
      let next = null;
      this.db.transaction(() => {
        const stillActive = this.stateRepo.clearActive(a.runId);
        if (!stillActive) return; // someone already completed/cleared this run
        recorded = this.sessionsRepo.record({
          runId: a.runId,
          taskId: task ? task.id : null,
          taskTitle: task ? task.title : null,
          sessionType: a.sessionType,
          plannedSeconds: a.plannedMs / 1000,
          actualSeconds: a.plannedMs / 1000,
          startedAt: TimerEngine.iso(a.startedAtMs),
          endedAt: TimerEngine.iso(Math.max(endedAtMs, a.startedAtMs)),
          status: 'completed',
        });
        if (recorded) next = this.advanceCycle(a.sessionType, a.sessionType === 'focus');
      });
      this.active = null;
      if (!recorded) {
        this.emitState();
        return;
      }

      const autoStart = a.sessionType === 'focus' ? this.settings.autoStartBreaks : this.settings.autoStartFocus;
      this.lastCompletion = {
        runId: a.runId,
        sessionType: a.sessionType,
        nextMode: next.mode,
        taskTitle: task ? task.title : null,
        endedAt: endedAtMs,
        autoStarted: autoStart,
      };
      this.notice = null;
      this.emit('completed', { ...this.lastCompletion });
      if (autoStart) {
        const completion = this.lastCompletion;
        this.start();
        // keep the completion banner visible while the next one runs
        this.lastCompletion = completion;
      }
      this.emitState();
    } finally {
      this.completing = false;
    }
  }

  // ---------------------------------------------------------------- snapshot

  getState() {
    const now = this.clock();
    const c = this.cycle();
    const a = this.active;
    const mode = a ? a.sessionType : c.mode;
    const taskId = a ? a.taskId : (mode === 'focus' ? this.selectedTaskId() : null);
    const plannedMs = a ? a.plannedMs : this.plannedSecondsFor(mode) * 1000;
    return {
      status: a ? a.state : 'idle',
      mode,
      plannedMs,
      elapsedMs: Math.min(this.elapsedAt(now), plannedMs),
      snapshotAt: now,
      runId: a ? a.runId : null,
      startedAt: a ? a.startedAtMs : null,
      task: this.taskInfo(taskId),
      selectedTaskId: this.selectedTaskId(),
      focusDone: c.focusDone,
      longBreakInterval: this.settings.longBreakInterval,
      lastCompletion: this.lastCompletion,
      notice: this.notice,
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

module.exports = { TimerEngine, MODES, MIN_RECORDED_MS };
