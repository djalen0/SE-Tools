const SHOW_SLUG = document.body.getAttribute('data-show-slug');

function dateHref(dateSlug) { return '/' + encodeURIComponent(SHOW_SLUG) + '/' + encodeURIComponent(dateSlug); }

function renderDates(dates) {
  const list = document.getElementById('dateList');
  list.innerHTML = '';
  if (!dates.length) {
    const empty = document.createElement('div');
    empty.className = 'entity-empty';
    empty.textContent = 'No dates yet -- add one below to get started.';
    list.appendChild(empty);
    return;
  }
  dates.forEach(d => {
    const a = document.createElement('a');
    a.className = 'entity-card';
    a.href = dateHref(d.slug);
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'entity-name';
    name.textContent = d.date;
    info.appendChild(name);
    if (d.venue) {
      const sub = document.createElement('div');
      sub.className = 'entity-sub';
      sub.textContent = d.venue;
      info.appendChild(sub);
    }
    const arrow = document.createElement('div');
    arrow.className = 'entity-arrow';
    arrow.textContent = '›';
    a.appendChild(info);
    a.appendChild(arrow);
    list.appendChild(a);
  });
}

function loadDates() {
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/dates').then(r => {
    if (!r.ok) { renderDates([]); return; }
    r.json().then(data => renderDates(data.dates || []));
  });
}

document.getElementById('newDateForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const date = form.date.value.trim();
  if (!date) return;
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/dates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  })
    .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
    .then(({ ok, body }) => {
      if (ok) {
        window.location.href = dateHref(body.slug);
      } else {
        alert(body.error || 'Could not create date.');
      }
    });
});

window.addEventListener('authed', loadDates);
loadDates();
