// Startup sound: the playlist chosen in Settings → Startup sound, played when
// the app starts. The main process decides whether it plays this launch
// (enabled? "once a day" already played or Pomodoro done today?) and hands it
// out only once per launch, so a reloaded window never plays it twice.
//
// One <audio> element plays everything here — startup tracks one after
// another and the previews in Settings — so two of these sounds can never
// overlap. Alarms win: playAlarm() stops this player first.

import { api, store } from './store.js';

let player = null;
let mode = null;        // 'startup' | 'preview' | null
let queue = [];
let index = 0;
let seq = 0;            // invalidates callbacks of a track that was skipped or stopped
let started = false;    // startup playback is attempted once per page load
let previewUrl = null;
const listeners = new Set();

/** Small in-window trace of what played (track names only), for troubleshooting. */
function log(event, name = null) {
  try { (window.__startupSoundLog ||= []).push({ event, name, at: Date.now() }); } catch (_) { /* never matters */ }
}

function el() {
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
  }
  return player;
}

function gain(volume) {
  const v = Math.max(0, Math.min(100, Number(volume))) / 100;
  return v * v; // same perceptual curve as the alarm
}

function notify() {
  for (const fn of listeners) { try { fn({ mode, previewUrl }); } catch (_) { /* ui only */ } }
}

/** Subscribe to play/stop changes (used by the preview buttons). */
export function onPlayerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Stops startup playback and any preview at once. */
export function stopStartupAudio() {
  if (mode) log('stop', mode);
  seq += 1;
  if (player) {
    player.onended = null; player.onerror = null; player.onplaying = null;
    player.pause();
    player.removeAttribute('src');
    try { player.load(); } catch (_) { /* nothing loaded */ }
  }
  mode = null;
  queue = [];
  previewUrl = null;
  notify();
}

function playTrack(url, volume, { onEnd, onFail, onStart }) {
  const my = ++seq;
  const a = el();
  const live = () => my === seq;
  a.onended = () => { if (live()) onEnd(); };
  a.onerror = () => { if (live()) { seq += 1; onFail(); } };
  a.onplaying = () => { if (live() && onStart) onStart(); };
  a.src = url;
  a.volume = gain(volume);
  const p = a.play();
  if (p && p.catch) p.catch(() => { if (live()) { seq += 1; onFail(); } });
}

let reportedStart = false;

function playNext() {
  if (mode !== 'startup') return;
  if (index >= queue.length) { log('done'); stopStartupAudio(); return; }
  const track = queue[index];
  index += 1;
  playTrack(track.url, store.settings ? store.settings.startupSoundVolume : 60, {
    onEnd: () => { log('end', track.name); playNext(); },
    onFail: () => { log('skip', track.name); console.warn(`[startup sound] skipped "${track.name}": it could not be played.`); playNext(); },
    onStart: () => {
      log('start', track.name);
      if (reportedStart) return;
      reportedStart = true;
      api.startupSound.played().catch(() => {}); // remembers the day for "once a day"
    },
  });
}

/** Called once from app start-up. Plays the selected tracks in order, if this launch should. */
export async function playStartupSound() {
  if (started) return { play: false, reason: 'already-started' };
  started = true;
  let plan;
  try { plan = await api.startupSound.claim(); } catch (_) { return { play: false, reason: 'error' }; }
  if (!plan || !plan.play || !plan.tracks || !plan.tracks.length) return plan || { play: false };
  if (mode) return { play: false, reason: 'busy' }; // something is already playing (e.g. an alarm preview)
  mode = 'startup';
  queue = plan.tracks.slice();
  index = 0;
  notify();
  playNext();
  return plan;
}

/** Plays one track as a preview (Settings). Calling it again for the same track stops it. */
export function previewTrack(url, volume) {
  if (previewUrl === url) { stopStartupAudio(); return false; }
  stopStartupAudio();
  mode = 'preview';
  previewUrl = url;
  notify();
  playTrack(url, volume, {
    onEnd: stopStartupAudio,
    onFail: () => { stopStartupAudio(); listeners.forEach((fn) => { try { fn({ mode: null, previewUrl: null, failed: url }); } catch (_) { /* ui */ } }); },
  });
  return true;
}

export function isPlaying() { return mode; }

export function initStartupSound() {
  // Volume follows the slider while a track plays; switching the feature off stops startup playback.
  store.on('settings', (s) => {
    if (player && mode) player.volume = gain(s.startupSoundVolume);
    if (mode === 'startup' && !s.startupSoundEnabled) stopStartupAudio();
  });
}

/** Live volume while dragging the slider (before it is saved). */
export function setPlayerVolume(volume) {
  if (player && mode) player.volume = gain(volume);
}
