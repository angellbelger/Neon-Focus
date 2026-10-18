'use strict';

const { cleanId } = require('./tasks-repository');
const { cleanDate, localDate } = require('../../dates');

const MODES = ['milestones', 'tasks', 'activity', 'manual'];
const MILESTONE_STATUS = ['pending', 'done', 'dropped'];

function cleanTitle(v, what = 'goal') {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Give the ${what} a name.`);
  const t = v.trim();
  if (t.length > 200) throw new Error(`The ${what} name can be up to 200 characters.`);
  return t;
}

function cleanYear(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1970 || n > 2200) throw new Error('Choose a valid year.');
  return n;
}

function cleanMonth(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new Error('Start must be a month, like 2026-01.');
  return v;
}

function optDate(v, label) {
  if (v === null || v === undefined || v === '') return null;
  return cleanDate(v, label);
}

/**
 * Yearly goals ("Metas e objetivos") and their milestones ("Etapas").
 * Progress is calculated in services.js from milestones, linked tasks,
 * activity time or a manual value, depending on progress_mode.
 */
class GoalsRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() { return new Date(this.clock()).toISOString(); }

  years() {
    return this.db.all('SELECT DISTINCT year FROM goals ORDER BY year').map((r) => r.year);
  }

  list(year) {
    return this.db.all('SELECT * FROM goals WHERE year = ? ORDER BY completed_at IS NOT NULL, created_at, id', [cleanYear(year)]);
  }

  all() {
    return this.db.all('SELECT id, title, year, completed_at FROM goals ORDER BY year DESC, title');
  }

  get(id) {
    return this.db.get('SELECT * FROM goals WHERE id = ?', [cleanId(id)]);
  }

  milestonesFor(goalIds) {
    const map = new Map();
    if (!goalIds.length) return map;
    const rows = this.db.all(
      `SELECT * FROM goal_milestones WHERE goal_id IN (${goalIds.map(() => '?').join(',')}) ORDER BY goal_id, position, id`,
      goalIds,
    );
    for (const r of rows) {
      if (!map.has(r.goal_id)) map.set(r.goal_id, []);
      map.get(r.goal_id).push(r);
    }
    return map;
  }

  linkedTaskCounts(goalIds) {
    const map = new Map();
    if (!goalIds.length) return map;
    const rows = this.db.all(
      `SELECT goal_id, COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE goal_id IN (${goalIds.map(() => '?').join(',')}) GROUP BY goal_id`,
      goalIds,
    );
    for (const r of rows) map.set(r.goal_id, { total: r.total, done: r.done || 0 });
    return map;
  }

  fields(g, existing = {}) {
    const mode = g.progressMode === undefined ? existing.progress_mode || 'milestones' : g.progressMode;
    if (!MODES.includes(mode)) throw new Error('Unknown progress type.');
    const manual = g.manualProgress === undefined ? existing.manual_progress ?? 0 : Number(g.manualProgress);
    if (!Number.isInteger(manual) || manual < 0 || manual > 100) throw new Error('Progress must be between 0 and 100%.');
    let tagId = g.tagId === undefined ? existing.tag_id ?? null : (g.tagId === null || g.tagId === '' ? null : cleanId(g.tagId));
    let targetMinutes = g.targetHours === undefined ? existing.target_minutes ?? null
      : (g.targetHours === null || g.targetHours === '' ? null : Math.round(Number(g.targetHours) * 60));
    if (targetMinutes !== null && (!Number.isFinite(targetMinutes) || targetMinutes < 1 || targetMinutes > 1000000)) {
      throw new Error('Target hours must be a positive number.');
    }
    if (mode === 'activity') {
      if (!tagId) throw new Error('Choose the tag whose time counts towards this goal.');
      if (!targetMinutes) throw new Error('Set a target in hours.');
      if (!this.db.get('SELECT id FROM tags WHERE id = ?', [tagId])) throw new Error('That tag no longer exists.');
    }
    const plan = g.actionPlan === undefined ? existing.action_plan ?? '' : String(g.actionPlan ?? '');
    if (plan.length > 4000) throw new Error('The action plan can be up to 4000 characters.');
    return {
      year: g.year === undefined ? existing.year : cleanYear(g.year),
      title: g.title === undefined ? existing.title : cleanTitle(g.title),
      action_plan: plan,
      start_month: g.startMonth === undefined ? existing.start_month ?? null : cleanMonth(g.startMonth),
      target_date: g.targetDate === undefined ? existing.target_date ?? null : optDate(g.targetDate, 'Completion date'),
      progress_mode: mode,
      manual_progress: manual,
      tag_id: tagId,
      target_minutes: targetMinutes,
    };
  }

  create(g) {
    const f = this.fields(g);
    if (!f.year || !f.title) throw new Error('A goal needs a name and a year.');
    const now = this.nowIso();
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO goals (year, title, action_plan, start_month, target_date, progress_mode, manual_progress, tag_id, target_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.year, f.title, f.action_plan, f.start_month, f.target_date, f.progress_mode, f.manual_progress, f.tag_id, f.target_minutes, now, now],
    );
    return this.get(lastInsertRowid);
  }

  update(id, g) {
    const existing = this.get(id);
    if (!existing) throw new Error('That goal no longer exists.');
    const f = this.fields(g, existing);
    this.db.run(
      `UPDATE goals SET year = ?, title = ?, action_plan = ?, start_month = ?, target_date = ?, progress_mode = ?,
              manual_progress = ?, tag_id = ?, target_minutes = ?, updated_at = ? WHERE id = ?`,
      [f.year, f.title, f.action_plan, f.start_month, f.target_date, f.progress_mode, f.manual_progress, f.tag_id, f.target_minutes, this.nowIso(), existing.id],
    );
    return this.get(existing.id);
  }

  setCompleted(id, completed) {
    const g = this.get(id);
    if (!g) throw new Error('That goal no longer exists.');
    this.db.run('UPDATE goals SET completed_at = ?, updated_at = ? WHERE id = ?',
      [completed ? this.nowIso() : null, this.nowIso(), g.id]);
    return this.get(g.id);
  }

  /** Deletes a goal and its milestones; linked tasks are kept (goal_id -> NULL). */
  delete(id) {
    const { changes } = this.db.run('DELETE FROM goals WHERE id = ?', [cleanId(id)]);
    return changes > 0;
  }

  // ---------------------------------------------------------- milestones

  milestone(id) {
    const m = this.db.get('SELECT * FROM goal_milestones WHERE id = ?', [cleanId(id)]);
    if (!m) throw new Error('That milestone no longer exists.');
    return m;
  }

  addMilestone(goalId, title) {
    const g = this.get(goalId);
    if (!g) throw new Error('That goal no longer exists.');
    const { n, maxPos } = this.db.get(
      'SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM goal_milestones WHERE goal_id = ?', [g.id],
    );
    if (n >= 50) throw new Error('A goal can have up to 50 milestones.');
    const now = this.nowIso();
    this.db.run(
      'INSERT INTO goal_milestones (goal_id, title, status, position, created_at, updated_at) VALUES (?, ?, \'pending\', ?, ?, ?)',
      [g.id, cleanTitle(title, 'milestone'), maxPos + 1, now, now],
    );
    return g.id;
  }

  updateMilestone(id, { title, status, doneOn }) {
    const m = this.milestone(id);
    let st = status === undefined ? m.status : status;
    if (!MILESTONE_STATUS.includes(st)) throw new Error('Unknown milestone status.');
    let date = doneOn === undefined ? m.done_on : optDate(doneOn, 'Milestone date');
    if (status !== undefined && status !== m.status) {
      date = st === 'done' ? (doneOn ? date : localDate(this.clock())) : (st === 'pending' ? null : date);
    }
    this.db.run('UPDATE goal_milestones SET title = ?, status = ?, done_on = ?, updated_at = ? WHERE id = ?',
      [title === undefined ? m.title : cleanTitle(title, 'milestone'), st, date, this.nowIso(), m.id]);
    return m.goal_id;
  }

  deleteMilestone(id) {
    const m = this.milestone(id);
    this.db.run('DELETE FROM goal_milestones WHERE id = ?', [m.id]);
    return m.goal_id;
  }
}

module.exports = { GoalsRepository, GOAL_MODES: MODES };
