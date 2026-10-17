// Small UI utilities: element builder, toasts, confirmation dialog, radio groups.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** h('div.class', {attrs}, children...) — text is always set as textContent. */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') throw new Error('Use children, not html.');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Builds an inline SVG icon from path data. */
export function icon(paths, viewBox = '0 0 24 24') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  play: 'M8 5.5v13l10.5-6.5z',
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M5 7h14', 'M10 11v6M14 11v6', 'M7 7l1 13h8l1-13', 'M9.5 7V4.5h5V7'],
  history: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4.5v3.8h3.8', 'M12 8v4.3l2.8 1.7'],
};

export function toast(message, { type = 'info', timeout = 4200 } = {}) {
  const host = $('#toasts');
  const t = h(`div.toast${type === 'error' ? '.toast--error' : ''}`, { role: type === 'error' ? 'alert' : null }, message);
  host.append(t);
  setTimeout(() => {
    t.classList.add('toast--leaving');
    setTimeout(() => t.remove(), 320);
  }, timeout);
}

export function toastError(err) {
  toast(err && err.message ? err.message : String(err), { type: 'error', timeout: 6500 });
}

/** Promise<boolean> confirmation using the native <dialog>. */
export function confirmAction({ title, text, ok = 'Confirm', danger = true }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'btn--danger' : 'btn--accent'}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

/**
 * Wires an ARIA radiogroup of buttons with arrow-key support.
 * @param {HTMLElement} group
 * @param {string} attr  data attribute holding the value (e.g. 'period')
 * @param {(value:string)=>void} onChange
 */
export function radioGroup(group, attr, onChange) {
  const buttons = () => $$('[role="radio"]', group);
  const set = (value, focus = false) => {
    for (const b of buttons()) {
      const on = b.dataset[attr] === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
  };
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (!b || b.disabled) return;
    onChange(b.dataset[attr]);
  });
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const list = buttons().filter((b) => !b.disabled);
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = list[(i + dir + list.length) % list.length];
    onChange(next.dataset[attr]);
    next.focus();
  });
  return { set };
}

/** True when the keyboard event target is a text-entry control. */
export function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}
