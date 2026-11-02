'use strict';

/**
 * Single source of truth for user settings: defaults, types and limits.
 * Every value coming from the renderer is validated here before it is stored.
 */

const SETTINGS_SCHEMA = {
  focusMinutes:         { type: 'int',  min: 1, max: 180, default: 25 },
  shortBreakMinutes:    { type: 'int',  min: 1, max: 60,  default: 5 },
  longBreakMinutes:     { type: 'int',  min: 1, max: 90,  default: 15 },
  longBreakInterval:    { type: 'int',  min: 1, max: 12,  default: 4 },
  autoStartBreaks:      { type: 'bool', default: false },
  autoStartFocus:       { type: 'bool', default: false },
  soundEnabled:         { type: 'bool', default: true },
  alarmSound:           { type: 'enum', values: ['chime', 'bell', 'digital', 'pulse'], default: 'chime' },
  alarmVolume:          { type: 'int',  min: 0, max: 100, default: 70 },
  notificationsEnabled: { type: 'bool', default: true },
  dailyGoal:            { type: 'int',  min: 1, max: 48,  default: 8 },
  weekStart:            { type: 'enum', values: [0, 1], default: 1 },
  theme:                { type: 'enum', values: ['cyan', 'violet', 'emerald'], default: 'cyan' },
  glowIntensity:        { type: 'int',  min: 0, max: 100, default: 60 },
  reduceMotion:         { type: 'bool', default: false },
  trayTimer:            { type: 'bool', default: true },
  // Earlier single choice (the tag shown as H.E.); only used while hoursTagIds is unset.
  hoursTagId:           { type: 'optInt', min: 1, max: 1e9, default: null },
  // Tags whose hours the Agenda shows next to TTP, by name. null = not chosen
  // yet (falls back to hoursTagId, else the tag named "English"); [] = TTP only.
  hoursTagIds:          { type: 'idList', max: 20, default: null },
  // Startup sound: a playlist played when the app starts.
  startupSoundEnabled:  { type: 'bool', default: false },
  startupSoundMode:     { type: 'enum', values: ['daily', 'launch'], default: 'daily' },
  startupSoundVolume:   { type: 'int',  min: 0, max: 100, default: 60 },
  // Focus wallpaper (Focus page only) and how much it is darkened for readability.
  wallpaperEnabled:     { type: 'bool', default: false },
  wallpaperDim:         { type: 'int',  min: 0, max: 90, default: 55 },
};

function defaultSettings() {
  const out = {};
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) out[key] = spec.default;
  return out;
}

class SettingsValidationError extends Error {
  constructor(key, message) {
    super(message);
    this.name = 'SettingsValidationError';
    this.key = key;
  }
}

/** Validates and normalises one value. Throws SettingsValidationError. */
function validateSetting(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) throw new SettingsValidationError(key, `Unknown setting "${key}".`);
  switch (spec.type) {
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw new SettingsValidationError(key, `${key} must be a whole number.`);
      }
      if (n < spec.min || n > spec.max) {
        throw new SettingsValidationError(key, `${key} must be between ${spec.min} and ${spec.max}.`);
      }
      return n;
    }
    case 'optInt': {
      if (value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new SettingsValidationError(key, `${key} must be empty or a valid id.`);
      }
      return n;
    }
    case 'idList': {
      if (value === null) return null;
      if (!Array.isArray(value)) throw new SettingsValidationError(key, `${key} must be a list of tags.`);
      const out = [];
      for (const v of value) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1e9) throw new SettingsValidationError(key, `${key} must contain valid tag ids.`);
        if (!out.includes(n)) out.push(n);
      }
      if (out.length > spec.max) throw new SettingsValidationError(key, `Choose up to ${spec.max} tags.`);
      return out;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new SettingsValidationError(key, `${key} must be on or off.`);
      return value;
    case 'enum': {
      const match = spec.values.find((v) => v === value || String(v) === String(value));
      if (match === undefined) {
        throw new SettingsValidationError(key, `${key} must be one of: ${spec.values.join(', ')}.`);
      }
      return match;
    }
    default:
      throw new SettingsValidationError(key, `Unsupported type for ${key}.`);
  }
}

/** Parses a stored (JSON string) value; falls back to the default if invalid. */
function parseStored(key, raw) {
  try {
    return validateSetting(key, JSON.parse(raw));
  } catch (_) {
    return SETTINGS_SCHEMA[key].default;
  }
}

module.exports = { SETTINGS_SCHEMA, defaultSettings, validateSetting, parseStored, SettingsValidationError };
