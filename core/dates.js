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

// ---------------------------------------------------------------- calendar weeks
// Week numbers follow Settings → "Weeks start on" (0 = Sunday … 6 = Saturday),
// exactly like the Agenda:
//  - Monday weeks use ISO 8601: week 1 holds the first Thursday of the year,
//    so it can begin in late December (and some years have a week 53);
//  - other start days count the week that holds 1 January as week 1.
// A week's "anchor" is the day that decides which year it belongs to (ISO:
// its Thursday; otherwise its last day). Weekly legacy totals are counted in
// any date range that contains their anchor, so they land in the same week,
// year and month everywhere.

const dayOfWeek = (key) => new Date(startOfLocalDate(key)).getDay();
const pad2 = (n) => String(n).padStart(2, '0');
const jan = (year, day) => `${year}-01-${pad2(day)}`;

/** First day of the week (per weekStart) that contains date `key`. */
function startOfWeek(key, weekStart = 1) {
  return addDaysToDate(key, -((dayOfWeek(key) - weekStart + 7) % 7));
}

function daysBetween(a, b) {
  return Math.round((startOfLocalDate(b) - startOfLocalDate(a)) / 86400000);
}

function firstWeekStart(year, weekStart) {
  return weekStart === 1 ? startOfWeek(jan(year, 4), 1) : startOfWeek(jan(year, 1), weekStart);
}

/** {year, week} of the calendar week that contains `key`. */
function weekOfDate(key, weekStart = 1) {
  const start = startOfWeek(cleanDate(key), weekStart);
  const anchor = addDaysToDate(start, weekStart === 1 ? 3 : 6);
  const year = Number(anchor.slice(0, 4));
  return { year, week: daysBetween(firstWeekStart(year, weekStart), start) / 7 + 1 };
}

/** Number of weeks (52 or 53) in `year`. */
function weeksInYear(year, weekStart = 1) {
  return daysBetween(firstWeekStart(year, weekStart), firstWeekStart(year + 1, weekStart)) / 7;
}

/** Dates of week `week` of `year`: { from, to, anchor } as 'YYYY-MM-DD'. */
function weekRange(year, week, weekStart = 1) {
  const from = addDaysToDate(firstWeekStart(year, weekStart), (week - 1) * 7);
  return { from, to: addDaysToDate(from, 6), anchor: addDaysToDate(from, weekStart === 1 ? 3 : 6) };
}

module.exports = {
  localDate, cleanDate, startOfLocalDate, addDaysToDate, DATE_RE,
  startOfWeek, weekOfDate, weeksInYear, weekRange,
};
