'use strict';

/**
 * Personal media files (startup sounds, Focus wallpaper), stored as copies
 * inside the app's own media folder next to the database:
 *
 *   <userData>/media/startup-sounds/<uuid>.<ext>
 *   <userData>/media/wallpapers/<uuid>.<ext>        (pending-<uuid>.<ext> while previewed)
 *
 * The original file the user picked is never touched. Every copy gets a fresh
 * random name, so deleting one can never hit an unrelated file, and every
 * path is checked to stay inside its folder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  startup_sound: {
    dir: 'startup-sounds',
    maxBytes: 50 * 1024 * 1024,
    label: 'sound',
    types: {
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
      m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
    },
  },
  wallpaper: {
    dir: 'wallpapers',
    maxBytes: 25 * 1024 * 1024,
    label: 'image',
    types: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  },
};

const NAME_RE = /^(pending-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/** First bytes of each format, so a renamed or broken file is refused up front. */
function looksLike(ext, head) {
  const s = (a, b) => head.subarray(a, b).toString('latin1');
  switch (ext) {
    case 'jpg': case 'jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'webp': return s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP';
    case 'wav': return s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE';
    case 'ogg': case 'oga': case 'opus': return s(0, 4) === 'OggS';
    case 'flac': return s(0, 4) === 'fLaC' || s(0, 3) === 'ID3';
    case 'm4a': return s(4, 8) === 'ftyp';
    case 'webm': return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case 'mp3': return s(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case 'aac': return s(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xf6) === 0xf0);
    default: return false;
  }
}

class MediaStore {
  /** @param {string|null} baseDir  e.g. <userData>/media; null disables file storage */
  constructor(baseDir) {
    this.baseDir = baseDir ? path.resolve(baseDir) : null;
  }

  spec(kind) {
    const spec = KINDS[kind];
    if (!spec) throw new Error('Unknown media type.');
    if (!this.baseDir) throw new Error('Media storage is not available.');
    return spec;
  }

  dirFor(kind) {
    return path.join(this.baseDir, this.spec(kind).dir);
  }

  /** Absolute path of a stored copy, or null if the name is not one of ours. */
  pathFor(kind, storedName) {
    if (typeof storedName !== 'string' || !NAME_RE.test(storedName)) return null;
    const dir = this.dirFor(kind);
    const p = path.join(dir, storedName);
    return path.dirname(p) === dir ? p : null;
  }

  exists(kind, storedName) {
    const p = this.pathFor(kind, storedName);
    try { return Boolean(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
  }

  /** URL the window loads the copy from (served by the app:// protocol). */
  url(kind, storedName) {
    return `app://local/media/${this.spec(kind).dir}/${encodeURIComponent(storedName)}`;
  }

  /**
   * Validates a file the user picked and copies it into the media folder.
   * Returns { storedName, originalName, mime, bytes }. Throws with a readable
   * message for unsupported, empty, too large or damaged files.
   */
  importFile(kind, sourcePath, { pending = false } = {}) {
    const spec = this.spec(kind);
    const originalName = path.basename(String(sourcePath || '')).slice(0, 255);
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (!spec.types[ext]) {
      throw new Error(`"${originalName}" is not a supported ${spec.label} file (${Object.keys(spec.types).join(', ')}).`);
    }
    let stat;
    try { stat = fs.statSync(sourcePath); } catch (_) { throw new Error(`"${originalName}" could not be found.`); }
    if (!stat.isFile() || stat.size === 0) throw new Error(`"${originalName}" is empty.`);
    if (stat.size > spec.maxBytes) throw new Error(`"${originalName}" is larger than ${spec.maxBytes / 1024 / 1024} MB.`);
    const head = Buffer.alloc(16);
    const fd = fs.openSync(sourcePath, 'r');
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (!looksLike(ext, head)) throw new Error(`"${originalName}" does not look like a valid .${ext} file. It may be damaged or renamed.`);

    const dir = this.dirFor(kind);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${pending ? 'pending-' : ''}${crypto.randomUUID()}.${ext}`;
    const target = path.join(dir, storedName);
    fs.copyFileSync(sourcePath, target, fs.constants.COPYFILE_EXCL);
    return { storedName, originalName, mime: spec.types[ext], bytes: stat.size };
  }

  /** Renames a pending (previewed) copy to its final name. */
  promote(kind, pendingName) {
    if (!/^pending-/.test(pendingName || '')) throw new Error('Nothing to apply.');
    const from = this.pathFor(kind, pendingName);
    if (!from || !fs.existsSync(from)) throw new Error('The previewed image is no longer available. Choose it again.');
    const finalName = pendingName.replace(/^pending-/, '');
    fs.renameSync(from, this.pathFor(kind, finalName));
    return finalName;
  }

  /** Deletes one stored copy (only names this store created). Missing files are fine. */
  remove(kind, storedName) {
    const p = this.pathFor(kind, storedName);
    if (!p) return false;
    try { fs.unlinkSync(p); return true; } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Removes previews left over from a previous run (pending-* only). */
  cleanPending(kind) {
    if (!this.baseDir) return 0;
    let n = 0;
    let names = [];
    try { names = fs.readdirSync(this.dirFor(kind)); } catch (_) { return 0; }
    for (const name of names) {
      if (name.startsWith('pending-') && NAME_RE.test(name) && this.remove(kind, name)) n += 1;
    }
    return n;
  }
}

module.exports = { MediaStore, MEDIA_KINDS: KINDS, looksLike };
