// Page switching. Pages are kept in the DOM; the timer is unaffected because
// it lives in the main process.

import { $, $$ } from './ui.js';

const PAGES = ['focus', 'agenda', 'tasks', 'goals', 'dashboard', 'history', 'settings'];
const hooks = new Map();
let current = null;
const changeListeners = new Set();

export function registerPage(name, { onShow, onHide } = {}) {
  hooks.set(name, { onShow, onHide });
}

export function currentPage() { return current; }

export function onPageChange(fn) { changeListeners.add(fn); }

export function navigate(page, { focus = true } = {}) {
  if (!PAGES.includes(page)) return;
  if (page === current) return;
  const prev = current;
  current = page;

  for (const section of $$('.page')) section.hidden = section.dataset.page !== page;
  for (const btn of $$('.rail [data-nav]')) {
    if (btn.id === 'rail-mini') continue;
    if (btn.dataset.nav === page) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  if (prev && hooks.get(prev)?.onHide) hooks.get(prev).onHide();
  if (hooks.get(page)?.onShow) hooks.get(page).onShow();
  for (const fn of changeListeners) fn(page);

  try { sessionStorage.setItem('page', page); } catch (_) { /* ignore */ }

  if (focus) {
    const main = $('#main');
    main.scrollTop = 0;
    const heading = $(`.page[data-page="${page}"] h1`);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
}

export function initNavigation() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-nav]');
    if (target) navigate(target.dataset.nav);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      navigate(PAGES[Number(e.key) - 1]);
    }
  });
  let start = 'focus';
  try { start = sessionStorage.getItem('page') || 'focus'; } catch (_) { /* ignore */ }
  navigate(PAGES.includes(start) ? start : 'focus', { focus: false });
}
