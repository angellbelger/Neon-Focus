// Settings → Startup sound (playlist) and Settings → Focus wallpaper.
// The switches, mode and sliders are ordinary settings (saved by settings.js);
// this module handles the playlist and the wallpaper image.

import { api, store } from './store.js';
import { $, h, toast, toastError, confirmAction } from './ui.js';
import { previewTrack, onPlayerChange, setPlayerVolume } from './startup-sound.js';
import { refreshWallpaper } from './wallpaper.js';

let tracks = [];
let playingUrl = null;
let pending = null;     // wallpaper being previewed: { token, url, name }
let current = null;     // applied wallpaper: { url, name, missing }

function sizeLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.hidden = !message;
}

// ------------------------------------------------------------------ playlist

function renderTracks() {
  const list = $('#s-startup-list');
  const selected = tracks.filter((t) => t.selected && !t.missing).length;
  $('#s-startup-count').textContent = tracks.length ? `· ${selected} of ${tracks.length} selected` : '';
  $('#s-startup-empty').hidden = tracks.length > 0;
  let n = 0;
  list.replaceChildren(...tracks.map((t, i) => {
    const order = t.selected && !t.missing ? (n += 1) : null;
    const playing = playingUrl && t.url === playingUrl;
    return h('li.track', { dataset: { id: String(t.id), selected: String(t.selected), missing: String(t.missing), playing: String(Boolean(playing)) } },
      h('label.track__pick', { title: t.selected ? 'Plays at start-up' : 'Not played at start-up' },
        h('input', {
          type: 'checkbox', checked: t.selected, disabled: t.missing,
          'aria-label': `Play "${t.name}" at start-up`,
          onchange: (e) => setSelected(t, e.target.checked),
        }),
        h('span.track__order', { 'aria-hidden': 'true' }, order ? String(order) : '–')),
      h('span.track__info', {},
        h('span.track__name', { title: t.name }, t.name),
        h('span.track__meta', {}, t.missing ? 'File missing' : `${sizeLabel(t.bytes)}${t.selected ? '' : ' · not played'}`)),
      h('span.track__actions', {},
        h('button.icon-btn.icon-btn--small.track__play', {
          type: 'button', disabled: t.missing,
          'aria-label': playing ? `Stop "${t.name}"` : `Preview "${t.name}"`,
          title: playing ? 'Stop' : 'Preview',
          onclick: () => previewTrack(t.url, Number($('#s-startup-volume').value)),
        }, h('span', { 'aria-hidden': 'true' }, playing ? '■' : '▶')),
        h('button.icon-btn.icon-btn--small', { type: 'button', disabled: i === 0, 'aria-label': `Move "${t.name}" up`, title: 'Move up', onclick: () => move(t, -1) }, h('span', { 'aria-hidden': 'true' }, '↑')),
        h('button.icon-btn.icon-btn--small', { type: 'button', disabled: i === tracks.length - 1, 'aria-label': `Move "${t.name}" down`, title: 'Move down', onclick: () => move(t, 1) }, h('span', { 'aria-hidden': 'true' }, '↓')),
        h('button.icon-btn.icon-btn--small.track__remove', { type: 'button', 'aria-label': `Remove "${t.name}"`, title: 'Remove', onclick: () => remove(t) }, h('span', { 'aria-hidden': 'true' }, '✕'))));
  }));
}

async function loadTracks() {
  try { tracks = await api.startupSound.list(); } catch (err) { toastError(err); }
  renderTracks();
}

async function addTracks() {
  const btn = $('#s-startup-add');
  btn.disabled = true;
  showError('#s-startup-error', '');
  try {
    const r = await api.startupSound.add();
    tracks = r.tracks;
    renderTracks();
    if (r.added.length) toast(`Added ${r.added.length === 1 ? `"${r.added[0].name}"` : `${r.added.length} sounds`} to the startup playlist.`);
    if (r.rejected.length) showError('#s-startup-error', r.rejected.map((x) => x.reason).join(' '));
  } catch (err) {
    showError('#s-startup-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function setSelected(t, on) {
  try { tracks = await api.startupSound.select(t.id, on); renderTracks(); } catch (err) { toastError(err); loadTracks(); }
}

async function move(t, dir) {
  try { tracks = await api.startupSound.move(t.id, dir); renderTracks(); } catch (err) { toastError(err); }
}

async function remove(t) {
  const ok = await confirmAction({
    title: 'Remove this sound?',
    text: `"${t.name}" will be removed from the startup playlist and its copy in Focus Neon deleted. The original file on your computer is not touched.`,
    ok: 'Remove sound',
  });
  if (!ok) return;
  try {
    if (playingUrl === t.url) previewTrack(t.url); // stop it
    tracks = await api.startupSound.remove(t.id);
    renderTracks();
    toast(`Removed "${t.name}".`);
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ wallpaper

function renderWallpaper() {
  const shown = pending || (current && !current.missing ? current : null);
  const fig = $('#s-wall-preview');
  fig.dataset.state = pending ? 'pending' : shown ? 'current' : current && current.missing ? 'missing' : 'none';
  const img = $('#s-wall-img');
  if (shown) img.style.setProperty('--preview-image', `url("${shown.url}")`);
  else img.style.removeProperty('--preview-image');
  img.style.setProperty('--wallpaper-dim', String(Number($('#s-wall-dim').value || 55) / 100));
  $('#s-wall-caption').textContent = pending
    ? `Preview: ${pending.name}. Not applied yet.`
    : current && current.missing ? `The image "${current.name}" is missing. Choose it again or remove it.`
      : current ? `${current.name}${store.settings && !store.settings.wallpaperEnabled ? ' (switched off)' : ''}`
        : 'No wallpaper chosen';
  $('#s-wall-pick').textContent = current || pending ? 'Choose another image' : 'Choose image';
  $('#s-wall-apply').hidden = !pending;
  $('#s-wall-cancel').hidden = !pending;
  $('#s-wall-remove').hidden = Boolean(pending) || !current;
}

async function loadWallpaper() {
  try { current = await api.wallpaper.get(); } catch (_) { current = null; }
  renderWallpaper();
}

async function pickWallpaper() {
  showError('#s-wall-error', '');
  try {
    const staged = await api.wallpaper.pick();
    if (!staged) return;
    pending = staged;
    renderWallpaper();
  } catch (err) { showError('#s-wall-error', err.message); }
}

async function applyWallpaper() {
  try {
    current = await api.wallpaper.apply();
    pending = null;
    renderWallpaper();
    await refreshWallpaper();
    toast('Wallpaper applied. It shows on the Focus page.');
  } catch (err) { showError('#s-wall-error', err.message); }
}

async function cancelWallpaper() {
  pending = null;
  renderWallpaper();
  api.wallpaper.discard().catch(() => {});
}

async function removeWallpaper() {
  const ok = await confirmAction({
    title: 'Remove the wallpaper?',
    text: 'The Focus page goes back to its normal background and the copy of the image in Focus Neon is deleted. The original file on your computer is not touched.',
    ok: 'Remove wallpaper',
  });
  if (!ok) return;
  try {
    await api.wallpaper.remove();
    current = null;
    renderWallpaper();
    await refreshWallpaper();
    toast('Wallpaper removed.');
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ init

export function initMediaSettings() {
  $('#s-startup-add').addEventListener('click', addTracks);
  $('#s-wall-pick').addEventListener('click', pickWallpaper);
  $('#s-wall-apply').addEventListener('click', applyWallpaper);
  $('#s-wall-cancel').addEventListener('click', cancelWallpaper);
  $('#s-wall-remove').addEventListener('click', removeWallpaper);

  // live feedback while dragging (the value is saved on release by settings.js)
  $('#s-startup-volume').addEventListener('input', (e) => {
    $('#s-startup-volume-out').textContent = `${e.target.value}%`;
    setPlayerVolume(Number(e.target.value));
  });
  $('#s-wall-dim').addEventListener('input', (e) => {
    $('#s-wall-dim-out').textContent = `${e.target.value}%`;
    $('#s-wall-img').style.setProperty('--wallpaper-dim', String(Number(e.target.value) / 100));
  });

  onPlayerChange((st) => {
    playingUrl = st.mode === 'preview' ? st.previewUrl : null;
    if (st.failed) showError('#s-startup-error', 'That sound could not be played. The file may be damaged or in a format this computer cannot play.');
    renderTracks();
  });

  store.on('settings', (s) => {
    $('#s-startup-volume-out').textContent = `${s.startupSoundVolume}%`;
    $('#s-wall-dim-out').textContent = `${s.wallpaperDim}%`;
    renderWallpaper();
  });

  loadTracks();
  loadWallpaper();
}

/** Refresh when Settings opens (files may have gone missing since). */
export function refreshMediaSettings() {
  loadTracks();
  loadWallpaper();
}
