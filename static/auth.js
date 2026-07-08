// Shared across Home/Show/Date pages -- there's no sign-in page, just this
// lock icon fixed in a corner (see .auth-lock-btn in style.css). Locked
// shows a closed padlock; clicking it opens a small popover to enter the
// shared password via fetch (no page navigation). Unlocked shows an open
// padlock; clicking it signs out. Pages that need to know when the user
// signs in (to actually fetch their real data) listen for the "authed"
// event this dispatches on window.
(function () {
  const lockBtn = document.getElementById('authLockBtn');
  const popover = document.getElementById('authPopover');
  const form = document.getElementById('authForm');
  const errorEl = document.getElementById('authError');
  if (!lockBtn || !popover || !form) return;

  function setLocked(locked) {
    document.body.classList.toggle('auth-locked', locked);
    lockBtn.textContent = locked ? '\u{1F512}' : '\u{1F513}';
    lockBtn.setAttribute('aria-label', locked ? 'Locked -- click to sign in' : 'Signed in -- click to sign out');
    lockBtn.title = lockBtn.getAttribute('aria-label');
    if (locked) popover.hidden = true;
  }

  function refreshStatus() {
    return fetch('/api/auth/status').then(r => r.json()).then(d => {
      setLocked(!d.authed);
      return d.authed;
    });
  }

  lockBtn.addEventListener('click', () => {
    if (document.body.classList.contains('auth-locked')) {
      popover.hidden = !popover.hidden;
      if (!popover.hidden) form.password.focus();
    } else if (confirm('Sign out?')) {
      fetch('/api/logout', { method: 'POST' }).then(() => {
        setLocked(true);
        window.dispatchEvent(new Event('signedout'));
      });
    }
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.password.value }),
    })
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (ok) {
          errorEl.textContent = '';
          form.reset();
          popover.hidden = true;
          setLocked(false);
          window.dispatchEvent(new Event('authed'));
        } else {
          errorEl.textContent = body.error || 'Incorrect password.';
        }
      });
  });

  document.addEventListener('click', e => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== lockBtn) popover.hidden = true;
  });

  window.PA_AUTH = { refreshStatus };
  refreshStatus();
})();
