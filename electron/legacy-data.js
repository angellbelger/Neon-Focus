'use strict';

/**
 * One-time carry-over of data from the app's previous name.
 *
 * The app was called "Neon Pomodoro" and stored its database at
 *   <appData>/Neon Pomodoro/neon-pomodoro.sqlite
 * Renaming it to "Focus Neon" moves the data folder to <appData>/Focus Neon,
 * so on first start we copy the old database across. The original is left in
 * place untouched as a safety net.
 */

const fs = require('fs');
const path = require('path');

const LEGACY_LOCATIONS = [
  { dir: 'Neon Pomodoro', file: 'neon-pomodoro.sqlite' },
];

/**
 * @param {string} appDataDir  e.g. %APPDATA%
 * @param {string} targetDbPath  the new database path
 * @returns {string|null} the legacy file that was copied, or null
 */
function carryOverLegacyDatabase(appDataDir, targetDbPath) {
  if (fs.existsSync(targetDbPath)) return null; // already have data under the new name
  for (const loc of LEGACY_LOCATIONS) {
    const source = path.join(appDataDir, loc.dir, loc.file);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
    const tmp = `${targetDbPath}.tmp`;
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, targetDbPath);
    return source;
  }
  return null;
}

module.exports = { carryOverLegacyDatabase, LEGACY_LOCATIONS };
