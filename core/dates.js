'use strict';

/**
 * Local calendar dates as 'YYYY-MM-DD' strings. The Agenda, daily notes and
 * task dates use these; session timestamps stay in UTC and are converted.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) { return String(n).padStart(2, '0'); }

/** Local date string for a timestamp (ms). */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Validates 'YYYY-MM-DD' (a real calendar day). Returns it or throws. */
function cleanDate(value, label = 'Date') {
  if (typeof value !== 'string') throw new Error(`${label} must be a date.`);
  const m = DATE_RE.exec(value);
  if (!m) throw new Error(`${label} must look like 2026-10-17.`);
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) throw new Error(`${label} is not a real day.`);
  if (y < 1970 || y > 2200) throw new Error(`${label} is out of range.`);
  return value;
}

/** Local midnight (ms) of a 'YYYY-MM-DD' string. */
function startOfLocalDate(value) {
  const m = DATE_RE.exec(cleanDate(value));
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Adds n calendar days to a 'YYYY-MM-DD' string. */
function addDaysToDate(value, n) {
  const ms = startOfLocalDate(value);
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return localDate(d.getTime());
}

module.exports = { localDate, cleanDate, startOfLocalDate, addDaysToDate, DATE_RE };
