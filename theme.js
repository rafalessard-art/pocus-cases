/*
 * Theme toggle for the POCUS Learning Case Series.
 *
 * The effective theme is already applied to <html data-theme> before paint by a
 * tiny inline script in each page's <head> (stored choice, else system). This
 * file adds the toggle control and keeps "auto" pages following the system.
 */
(function () {
  var KEY = 'pocus-theme';
  var root = document.documentElement;
  var mql = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function effective() {
    return root.dataset.theme || (mql.matches ? 'dark' : 'light');
  }
  function apply(theme) {
    root.dataset.theme = theme;
  }
  function icon(btn) {
    var dark = effective() === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
  }

  function mount() {
    var nav = document.querySelector('.topnav .topnav-inner') || document.querySelector('.topnav');
    if (!nav || nav.querySelector('.theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    icon(btn);
    btn.addEventListener('click', function () {
      var next = effective() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      icon(btn);
    });
    nav.appendChild(btn);

    // While the visitor hasn't chosen, follow the OS setting live.
    mql.addEventListener('change', function (e) {
      if (stored()) return;
      apply(e.matches ? 'dark' : 'light');
      icon(btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
