/*
 * Startup guard (a classic script, so it runs even when the page is opened
 * directly from disk, where browsers block module scripts).
 *
 * - Opened outside the desktop app (double-clicked index.html, a dev server,
 *   a browser tab): explains how to start the real app instead of showing a
 *   dead interface.
 * - Inside the app: if startup fails or never finishes, shows the error on
 *   screen instead of failing silently.
 */
(function () {
  'use strict';

  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push((e.error && e.error.stack) || e.message || String(e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
  });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function overlay(title, paragraphs, steps, detail) {
    if (document.getElementById('startup-overlay')) return;
    var box = el('div', 'startup');
    box.id = 'startup-overlay';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'startup-title');
    var card = el('div', 'startup__card');
    var h = el('h1', null, title);
    h.id = 'startup-title';
    card.appendChild(h);
    paragraphs.forEach(function (p) { card.appendChild(el('p', null, p)); });
    if (steps && steps.length) {
      var ol = el('ol', 'startup__steps');
      steps.forEach(function (s) {
        var li = el('li');
        li.appendChild(el('span', null, s[0]));
        if (s[1]) li.appendChild(el('code', null, s[1]));
        ol.appendChild(li);
      });
      card.appendChild(ol);
    }
    if (detail) {
      var pre = el('pre', 'startup__detail', detail);
      card.appendChild(pre);
    }
    box.appendChild(card);
    document.body.appendChild(box);
  }

  window.__showStartupError = function (err) {
    var detail = (err && (err.stack || err.message)) || String(err);
    overlay(
      'Focus Neon could not start',
      ['Something went wrong while loading the app. The technical details are below; please send them along so the problem can be fixed.'],
      null,
      detail + (errors.length ? '\n\n' + errors.join('\n\n') : '')
    );
  };

  function check() {
    if (!window.pomodoro) {
      var fromDisk = location.protocol === 'file:';
      overlay(
        'Open Focus Neon as a desktop app',
        [
          fromDisk
            ? 'You opened index.html directly in a browser. That file is only the app’s interface: the timer, the SQLite database and the charts run inside the desktop app, so nothing works from here.'
            : 'This page is running in an ordinary browser tab. The timer, the SQLite database and the charts run inside the desktop app, so nothing works from here.',
          'Start it one of these ways from the project folder (the one that contains package.json):',
        ],
        [
          ['macOS: double-click', 'Start Focus Neon.command'],
          ['Windows: double-click', 'Start Focus Neon.bat'],
          ['Or in a terminal:', 'npm install   then   npm start'],
          ['Node.js must be installed first (LTS version from nodejs.org).', ''],
        ]
      );
      return;
    }
    // Inside Electron: app.js marks the page when boot finishes.
    setTimeout(function () {
      if (document.documentElement.dataset.booted !== 'true') {
        window.__showStartupError(new Error('The interface did not finish loading within 10 seconds.'));
      }
    }, 10000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
