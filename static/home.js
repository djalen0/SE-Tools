function slugHref(slug) { return '/' + encodeURIComponent(slug); }

function renderShows(shows) {
  const list = document.getElementById('showList');
  list.innerHTML = '';
  if (!shows.length) {
    const empty = document.createElement('div');
    empty.className = 'entity-empty';
    empty.textContent = 'No shows yet -- add one below to get started.';
    list.appendChild(empty);
    return;
  }
  shows.forEach(show => {
    const a = document.createElement('a');
    a.className = 'entity-card';
    a.href = slugHref(show.slug);
    const name = document.createElement('div');
    name.className = 'entity-name';
    name.textContent = show.name;
    const arrow = document.createElement('div');
    arrow.className = 'entity-arrow';
    arrow.textContent = '›';
    a.appendChild(name);
    a.appendChild(arrow);
    list.appendChild(a);
  });
}

function loadShows() {
  fetch('/api/shows').then(r => {
    if (!r.ok) { renderShows([]); return; }
    r.json().then(renderShows);
  });
}

document.getElementById('newShowForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  fetch('/api/shows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
    .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
    .then(({ ok, body }) => {
      if (ok) {
        window.location.href = slugHref(body.slug);
      } else {
        alert(body.error || 'Could not create show.');
      }
    });
});

window.addEventListener('authed', loadShows);
loadShows();
