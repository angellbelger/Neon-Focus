// Formatting helpers. Dates are shown in the user's local time zone.

export const MODE_LABEL = { focus: 'Focus', short_break: 'Short break', long_break: 'Long break' };
export const STATUS_LABEL = { completed: 'Completed', interrupted: 'Interrupted', abandoned: 'Skipped' };

const LOCALE = 'en-GB';

/** Remaining time as mm:ss (or h:mm:ss for long sessions). Rounds up. */
export function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Human duration from seconds: 1h 05m, 25m, 40s. */
export function duration(seconds) {
  const s = Math.round(seconds);
  if (s <= 0) return '0m';
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Duration split into value + unit for large figures. */
export function durationParts(seconds) {
  const s = Math.round(seconds);
  if (s < 3600) return { value: String(Math.round(s / 60)), unit: 'min' };
  const h = s / 3600;
  return { value: h >= 100 ? String(Math.round(h)) : h.toFixed(1), unit: 'h' };
}

export function time(ms) {
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

export function dateLong(ms) {
  return new Date(ms).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function dateShort(ms) {
  return new Date(ms).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}

export function weekday(ms) {
  return new Date(ms).toLocaleDateString(LOCALE, { weekday: 'short' });
}

export function monthName(ms, style = 'short') {
  return new Date(ms).toLocaleDateString(LOCALE, { month: style });
}

/** Label for a dashboard period range. */
export function periodLabel(period, range, isCurrent) {
  const { start, end } = range;
  const last = end - 1;
  switch (period) {
    case 'day': return isCurrent ? `Today, ${dateShort(start)}` : new Date(start).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    case 'week': {
      const sameMonth = new Date(start).getMonth() === new Date(last).getMonth();
      const a = sameMonth ? new Date(start).getDate() : dateShort(start);
      return `${a}–${dateShort(last)} ${new Date(last).getFullYear()}`;
    }
    case 'month': return new Date(start).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
    case 'year': return String(new Date(start).getFullYear());
    default: return '';
  }
}

/** Short label for a chart bucket. */
export function bucketLabel(unit, period, ms) {
  if (unit === 'hour') return `${String(new Date(ms).getHours()).padStart(2, '0')}:00`;
  if (unit === 'month') return monthName(ms);
  if (period === 'week') return `${weekday(ms)} ${new Date(ms).getDate()}`;
  return String(new Date(ms).getDate());
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** yyyy-mm-dd in local time (for <input type="date">). */
export function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parses yyyy-mm-dd as local midnight. */
export function parseIsoDate(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

/** Hours and minutes, e.g. "2 h 30 min", "45 min", "0 min". */
export function hoursMinutes(seconds) {
  const total = Math.round((seconds || 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** Local 'YYYY-MM-DD' -> ms at local midnight. */
export function dateKeyToMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Day of the year (1-based) and days left, like a paper planner ("290 / 75"). */
export function dayOfYear(ms) {
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), 0, 1);
  const n = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86400000) + 1;
  const days = new Date(d.getFullYear(), 1, 29).getDate() === 29 ? 366 : 365;
  return { n, left: days - n };
}
