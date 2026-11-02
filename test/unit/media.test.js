'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServices } = require('../../core/services');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fn-media-'));

function fakeClock(start) {
  let t = start;
  const c = () => t;
  c.set = (ms) => { t = ms; };
  c.advance = (ms) => { t += ms; };
  return c;
}

/** Small files with the right first bytes for each format. */
function fixtures(dir) {
  const w = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };
  const pad = (b) => Buffer.concat([b, Buffer.alloc(64)]);
  return {
    mp3: w('Morning Theme.mp3', pad(Buffer.from('ID3\u0004\u0000', 'latin1'))),
    wav: w('chime.wav', pad(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1'))),
    ogg: w('birds.ogg', pad(Buffer.from('OggS', 'latin1'))),
    fakeMp3: w('notes.mp3', Buffer.from('this is a text file renamed to mp3')),
    txt: w('readme.txt', Buffer.from('hello')),
    empty: w('empty.wav', Buffer.alloc(0)),
    png: w('Lake.png', pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))),
    jpg: w('Mountains.jpg', pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))),
    webp: w('city.webp', pad(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'latin1'))),
    gif: w('anim.gif', pad(Buffer.from('GIF89a', 'latin1'))),
  };
}

async function setup() {
  const dir = tmp();
  const mediaDir = path.join(dir, 'media');
  const clock = fakeClock(new Date(2026, 10, 2, 8, 0).getTime()); // Mon 2 Nov 2026, 08:00
  const svc = await createServices({ dbPath: path.join(dir, 'db.sqlite'), mediaDir, clock });
  svc.engine.init();
  return { dir, mediaDir, clock, svc, f: fixtures(dir) };
}

const files = (d) => { try { return fs.readdirSync(d).sort(); } catch (_) { return []; } };

function pomodoro(svc, clock) {
  svc.engine.setMode('focus');
  svc.engine.start();
  for (let i = 0; i < 25 * 12; i += 1) { clock.advance(5000); svc.engine.tick(); }
}

// ------------------------------------------------------------------ playlist

test('startup playlist: files are copied, validated, ordered, selectable and removable', async () => {
  const { svc, mediaDir, f } = await setup();
  const r = svc.addStartupTracks([f.mp3, f.fakeMp3, f.wav, f.txt, f.empty, f.ogg]);
  assert.deepEqual(r.added.map((t) => t.name), ['Morning Theme.mp3', 'chime.wav', 'birds.ogg']);
  assert.equal(r.rejected.length, 3);
  assert.match(r.rejected.find((x) => x.name === 'notes.mp3').reason, /does not look like a valid \.mp3/);
  assert.match(r.rejected.find((x) => x.name === 'readme.txt').reason, /not a supported sound file/);
  assert.match(r.rejected.find((x) => x.name === 'empty.wav').reason, /empty/);

  const soundDir = path.join(mediaDir, 'startup-sounds');
  assert.equal(files(soundDir).length, 3, 'only valid files are copied');
  assert.ok(fs.existsSync(f.mp3), 'the original is never moved or deleted');
  const [a, b, c] = svc.startupTracks();
  assert.ok(a.selected && b.selected && c.selected, 'new tracks are selected');
  assert.match(a.url, /^app:\/\/local\/media\/startup-sounds\/[0-9a-f-]+\.mp3$/);

  svc.mediaRepo.setSelected(b.id, false);
  svc.mediaRepo.move(c.id, -1);
  assert.deepEqual(svc.startupTracks().map((t) => [t.name, t.selected]), [['Morning Theme.mp3', true], ['birds.ogg', true], ['chime.wav', false]]);

  // removing deletes only that track's copy
  const keep = files(soundDir);
  const unrelated = path.join(soundDir, 'my-notes.txt');
  fs.writeFileSync(unrelated, 'not ours');
  svc.removeStartupTrack(a.id);
  assert.deepEqual(files(soundDir), keep.filter((n) => !a.url.endsWith(n)).concat('my-notes.txt').sort());
  assert.ok(fs.existsSync(unrelated), 'unrelated files are never deleted');
  assert.equal(svc.media.remove('startup_sound', '../db.sqlite'), false, 'paths outside the media folder are refused');
});

test('a missing track file is flagged and skipped, never crashes', async () => {
  const { svc, f } = await setup();
  svc.addStartupTracks([f.mp3, f.wav]);
  svc.settingsRepo.update({ startupSoundEnabled: true, startupSoundMode: 'launch' });
  const [first] = svc.startupTracks();
  fs.unlinkSync(svc.media.pathFor('startup_sound', first.url.split('/').pop()));
  const tracks = svc.startupTracks();
  assert.equal(tracks[0].missing, true);
  assert.equal(tracks[0].url, null);
  const plan = svc.startupPlan();
  assert.equal(plan.play, true);
  assert.deepEqual(plan.tracks.map((t) => t.name), ['chime.wav'], 'only playable, selected tracks are handed out');
  // nothing valid left -> no playback attempt
  svc.mediaRepo.setSelected(tracks[1].id, false);
  assert.deepEqual([svc.startupPlan().play, svc.startupPlan().reason], [false, 'no-tracks']);
});

// ------------------------------------------------------------------ playback rules

test('"once a day": plays at the first launch of the day until a Pomodoro is done; resets the next day', async () => {
  const { svc, clock, f } = await setup();
  svc.addStartupTracks([f.mp3]);
  assert.deepEqual([svc.startupPlan().play, svc.startupPlan().reason], [false, 'off'], 'off by default');
  svc.settingsRepo.update({ startupSoundEnabled: true });
  assert.equal(svc.settingsRepo.getAll().startupSoundMode, 'daily');

  let plan = svc.startupPlan();
  assert.equal(plan.play, true);
  assert.equal(plan.volume, 60);
  svc.markStartupPlayed();                           // the first track started
  assert.deepEqual([svc.startupPlan().play, svc.startupPlan().reason], [false, 'played-today']);

  // next day: plays again; a Pomodoro before launch stops it for that day
  clock.set(new Date(2026, 10, 3, 7, 0).getTime());
  assert.equal(svc.startupPlan().play, true, 'reset on a new calendar day');
  pomodoro(svc, clock);
  assert.deepEqual([svc.startupPlan().play, svc.startupPlan().reason], [false, 'pomodoro-done-today']);

  // "every launch" ignores both
  svc.settingsRepo.update({ startupSoundMode: 'launch' });
  plan = svc.startupPlan();
  assert.equal(plan.play, true);
  svc.markStartupPlayed();
  assert.equal(svc.startupPlan().play, true);
});

test('the daily state survives a restart', async () => {
  const dir = tmp();
  const f = fixtures(dir);
  const opts = { dbPath: path.join(dir, 'db.sqlite'), mediaDir: path.join(dir, 'media'), clock: () => new Date(2026, 10, 2, 9).getTime() };
  let svc = await createServices(opts);
  svc.addStartupTracks([f.wav]);
  svc.settingsRepo.update({ startupSoundEnabled: true, startupSoundVolume: 35 });
  svc.markStartupPlayed();
  svc.db.close();
  svc = await createServices(opts);
  assert.equal(svc.startupPlan().reason, 'played-today');
  assert.equal(svc.startupTracks().length, 1, 'playlist kept');
  assert.equal(svc.settingsRepo.getAll().startupSoundVolume, 35);
});

test('startup settings are validated', async () => {
  const { svc } = await setup();
  assert.throws(() => svc.settingsRepo.update({ startupSoundMode: 'hourly' }));
  assert.throws(() => svc.settingsRepo.update({ startupSoundVolume: 101 }));
  assert.throws(() => svc.settingsRepo.update({ wallpaperDim: 95 }));
  assert.equal(svc.settingsRepo.update({ wallpaperDim: 90 }).wallpaperDim, 90);
});

// ------------------------------------------------------------------ wallpaper

test('wallpaper: preview, apply, replace (old copy deleted), remove, damaged and unsupported files refused', async () => {
  const { svc, mediaDir, f } = await setup();
  const wallDir = path.join(mediaDir, 'wallpapers');
  assert.equal(svc.wallpaperInfo(), null);
  assert.throws(() => svc.stageWallpaper(f.gif), /not a supported image file \(jpg, jpeg, png, webp\)/);
  assert.throws(() => svc.stageWallpaper(f.mp3), /not a supported image/);

  const p1 = svc.stageWallpaper(f.png);
  assert.match(p1.token, /^pending-/);
  assert.equal(svc.wallpaperInfo(), null, 'a preview is not applied');
  const w1 = svc.applyWallpaper(p1.token, p1.name);
  assert.equal(w1.name, 'Lake.png');
  assert.equal(svc.settingsRepo.getAll().wallpaperEnabled, true, 'applying switches it on');
  assert.deepEqual(files(wallDir), [w1.url.split('/').pop()]);

  // replace: the new one is kept, the old copy deleted
  const p2 = svc.stageWallpaper(f.jpg);
  const w2 = svc.applyWallpaper(p2.token, p2.name);
  assert.equal(w2.name, 'Mountains.jpg');
  assert.deepEqual(files(wallDir), [w2.url.split('/').pop()]);
  assert.equal(svc.mediaRepo.list('wallpaper').length, 1);

  // a discarded preview leaves nothing behind
  const p3 = svc.stageWallpaper(f.webp);
  svc.discardWallpaperPreview(p3.token);
  assert.deepEqual(files(wallDir), [w2.url.split('/').pop()]);

  // missing file: reported, not a crash
  fs.unlinkSync(path.join(wallDir, w2.url.split('/').pop()));
  assert.equal(svc.wallpaperInfo().missing, true);
  svc.removeWallpaper();
  assert.equal(svc.wallpaperInfo(), null);
  assert.ok(fs.existsSync(f.png) && fs.existsSync(f.jpg), 'originals untouched');
});

test('leftover previews are cleaned at start-up; applied files and other files are kept', async () => {
  const dir = tmp();
  const f = fixtures(dir);
  const opts = { dbPath: path.join(dir, 'db.sqlite'), mediaDir: path.join(dir, 'media') };
  let svc = await createServices(opts);
  const applied = svc.applyWallpaper(svc.stageWallpaper(f.png).token, 'Lake.png');
  const stale = svc.stageWallpaper(f.jpg);                 // app closed while previewing
  fs.writeFileSync(path.join(dir, 'media', 'wallpapers', 'mine.jpg'), 'x');
  svc.db.close();
  svc = await createServices(opts);
  const left = files(path.join(dir, 'media', 'wallpapers'));
  assert.ok(!left.includes(stale.token));
  assert.ok(left.includes(applied.url.split('/').pop()));
  assert.ok(left.includes('mine.jpg'));
  assert.equal(svc.wallpaperInfo().missing, false);
});
