'use strict';

// Launches the app in "fast mode": every minute setting lasts one second, so a
// 25-minute focus session takes 25 seconds. Uses a separate data folder so
// your real history is never touched. For trying the app out and testing.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const electron = require('electron');

const dataDir = path.join(os.tmpdir(), 'focus-neon-fast-mode');
console.log(`Fast mode: 1 minute = 1 second. Data folder: ${dataDir}`);

const child = spawn(electron, ['.'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, FOCUS_NEON_SECONDS_PER_MINUTE: '1', FOCUS_NEON_DATA_DIR: dataDir },
});
child.on('close', (code) => process.exit(code ?? 0));
