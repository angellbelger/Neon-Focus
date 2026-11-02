// Focus wallpaper: a personal image behind the Focus page only. It is drawn as
// the background of <main> while the Focus page is the one on screen (cover,
// centred, with an adjustable dark overlay), and removed for every other page.
// The image file is only requested when the wallpaper is switched on and the
// Focus page is open.

import { api, store } from './store.js';
import { $ } from './ui.js';
import { currentPage, onPageChange } from './navigation.js';

let info = null;        // { url, name, missing } of the applied wallpaper, or null
let loadedUrl = null;   // url that loaded successfully
let failedUrl = null;   // url that could not be decoded (damaged file)

function wanted() {
  const s = store.settings || {};
  return Boolean(s.wallpaperEnabled && info && info.url && !info.missing);
}

function apply() {
  const main = $('#main');
  const on = wanted() && currentPage() === 'focus' && failedUrl !== info.url;
  if (on && loadedUrl !== info.url) {
    // Load once in the background first: a damaged image never replaces the normal look.
    const url = info.url;
    const img = new Image();
    img.onload = () => { loadedUrl = url; apply(); };
    img.onerror = () => { failedUrl = url; console.warn('[wallpaper] the image could not be loaded.'); apply(); };
    img.src = url;
    main.classList.remove('has-wallpaper');
    return;
  }
  main.classList.toggle('has-wallpaper', on);
  if (on) {
    main.style.setProperty('--wallpaper-image', `url("${info.url}")`);
    main.style.setProperty('--wallpaper-dim', String((store.settings.wallpaperDim ?? 55) / 100));
  } else {
    main.style.removeProperty('--wallpaper-image');
    main.style.removeProperty('--wallpaper-dim');
  }
}

/** Re-reads the applied wallpaper (after it was chosen, replaced or removed in Settings). */
export async function refreshWallpaper() {
  try { info = await api.wallpaper.get(); } catch (_) { info = null; }
  apply();
  return info;
}

export function initWallpaper() {
  onPageChange(apply);
  store.on('settings', apply);
  refreshWallpaper();
}
