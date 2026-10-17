'use strict';

const { SETTINGS_SCHEMA, defaultSettings, validateSetting, parseStored } = require('../../settings-schema');

class SettingsRepository {
  constructor(db, clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  getAll() {
    const settings = defaultSettings();
    const rows = this.db.all('SELECT setting_key, setting_value FROM settings');
    for (const row of rows) {
      if (SETTINGS_SCHEMA[row.setting_key]) {
        settings[row.setting_key] = parseStored(row.setting_key, row.setting_value);
      }
    }
    return settings;
  }

  /** Validates every key first, then writes them all in one transaction. */
  update(partial) {
    if (!partial || typeof partial !== 'object') throw new Error('Settings update must be an object.');
    const clean = {};
    for (const [key, value] of Object.entries(partial)) clean[key] = validateSetting(key, value);
    const now = new Date(this.clock()).toISOString();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(clean)) {
        this.db.run(
          `INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
          [key, JSON.stringify(value), now],
        );
      }
    });
    return this.getAll();
  }

  resetToDefaults() {
    this.db.run('DELETE FROM settings');
    return this.getAll();
  }
}

module.exports = { SettingsRepository };
