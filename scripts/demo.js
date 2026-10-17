'use strict';

/**
 * Opens the app with a separate, clearly-labelled DEMO database filled with
 * ~10 weeks of generated sessions, so you can explore the dashboard before you
 * have real history. Your real data folder is never touched.
 *
 *   npm run demo
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createServices } = require('../core/services');

async function seed(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const svc = await createServices({ dbPath: path.join(dataDir, 'neon-pomodoro.sqlite') });
  const titles = ['Write the quarterly report', 'Review pull requests', 'Study machine learning', 'Plan next sprint', 'Read research paper'];
  const tasks = titles.map((title, i) => svc.tasksRepo.create({ title, estimatedPomodoros: [80, null, 90, 12, 60][i] }));

  let rnd = 42;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const now = Date.now();
  const sessions = [];
  for (let d = 70; d >= 0; d -= 1) {
    const day = new Date(now); day.setDate(day.getDate() - d); day.setHours(0, 0, 0, 0);
    const weekend = [0, 6].includes(day.getDay());
    if (rand() < (weekend ? 0.6 : 0.08)) continue;
    let t = day.getTime() + (8 + Math.floor(rand() * 3)) * 3600e3 + Math.floor(rand() * 60) * 60e3;
    const blocks = Math.floor((weekend ? 2 : 4) + rand() * (weekend ? 3 : 7) + (70 - d) / 25);
    for (let b = 0; b < blocks; b += 1) {
      const end = t + 25 * 60e3;
      if (end > now) break;
      const interrupted = rand() < 0.1;
      const actual = interrupted ? Math.floor(5 + rand() * 15) * 60 : 1500;
      const task = rand() < 0.85 ? tasks[Math.floor(rand() * tasks.length)] : null;
      sessions.push({ runId: crypto.randomUUID(), taskId: task && task.id, taskTitle: task && task.title, sessionType: 'focus',
        plannedSeconds: 1500, actualSeconds: actual, startedAt: new Date(t).toISOString(),
        endedAt: new Date(t + actual * 1000).toISOString(), status: interrupted ? 'interrupted' : 'completed' });
      t += actual * 1000;
      const long = (b + 1) % 4 === 0;
      const brk = (long ? 15 : 5) * 60;
      if (t + brk * 1000 > now) break;
      sessions.push({ runId: crypto.randomUUID(), sessionType: long ? 'long_break' : 'short_break', plannedSeconds: brk,
        actualSeconds: brk, startedAt: new Date(t).toISOString(), endedAt: new Date(t + brk * 1000).toISOString(), status: 'completed' });
      t += brk * 1000 + Math.floor(rand() * 40) * 60e3;
      if (rand() < 0.15) t += 90 * 60e3; // lunch / meetings
    }
  }
  svc.db.transaction(() => sessions.forEach((s) => svc.sessionsRepo.record(s)));
  svc.tasksRepo.setStatus(tasks[3].id, 'completed');
  svc.db.close();
  return sessions.length;
}

module.exports = { seed };

if (require.main === module) {
  const dataDir = process.argv[2] || path.join(os.tmpdir(), 'neon-pomodoro-demo');
  seed(dataDir).then((n) => {
    console.log(`Demo database with ${n} generated sessions: ${dataDir}`);
    if (process.argv.includes('--no-launch')) return;
    const electron = require('electron');
    const child = spawn(electron, ['.'], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit',
      env: { ...process.env, NEON_POMODORO_DATA_DIR: dataDir },
    });
    child.on('close', (code) => process.exit(code ?? 0));
  });
}
