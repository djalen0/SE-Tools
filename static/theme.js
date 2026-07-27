// Persisted light/dark preference -- boolean toggle mirroring
// setSidebarCollapsed's own localStorage pattern in app.js (no ongoing
// "system preference" concept beyond the very first visit). The actual
// decision + first application happens in the inline <script> at the top
// of each template's <head> (before <body> exists, to avoid a flash of
// the wrong theme on load) -- this file only wires up whichever toggle
// button(s) the current page has and keeps them in sync with whatever
// state is already applied. The class lives on <html> (document.
// documentElement), not <body> -- see the @media print safeguard in
// style.css, which depends on it being there to out-cascade via
// !important on the very same element.
(function () {
  const THEME_KEY = 'pa-pinner-theme-dark';
  const root = document.documentElement;
  const btn = document.getElementById('themeToggleBtn');
  const btnVO = document.getElementById('themeToggleBtnVO');
  const buttons = [btn, btnVO].filter(Boolean);
  if (!buttons.length) return;

  function isDark() { return root.classList.contains('theme-dark'); }

  function applyTheme(dark) {
    root.classList.toggle('theme-dark', dark);
    try { localStorage.setItem(THEME_KEY, dark ? '1' : '0'); } catch (e) {}
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', dark ? '#14151c' : '#4f46e5');
    buttons.forEach(b => {
      b.textContent = dark ? '\u{1F319}' : '\u{2600}\u{FE0F}';
      b.setAttribute('aria-label', dark ? 'Dark mode -- click for light mode' : 'Light mode -- click for dark mode');
      b.title = b.getAttribute('aria-label');
    });
  }

  buttons.forEach(b => b.addEventListener('click', () => applyTheme(!isDark())));

  // Doesn't decide the theme -- the <head> inline script already did that
  // and applied it to <html> before first paint. This just syncs these
  // buttons' glyph/label to that already-resolved state.
  applyTheme(isDark());
})();
