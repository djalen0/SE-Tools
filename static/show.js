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

// SE's show-wide Data Tags default -- which metadata fields (Mode/Aim/
// Trim/Angle/etc.) are hidden by default on every Date under this show.
// The field list itself comes from design.xlsx (same template every job
// uses), independent of any particular Date's own job.json.
let DESIGN_METADATA_FIELDS = [];
let SHOW_HIDDEN_TAGS = [];

function renderShowDataTagsPanel() {
  const panel = document.getElementById('dataTagsPanel');
  panel.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default for every date in this show -- an individual date, or one hang on it, can still override a tag for itself.';
  panel.appendChild(note);
  const allTags = [{label: 'Mode', key: '__mode'}, ...DESIGN_METADATA_FIELDS];
  allTags.forEach(({label, key}) => {
    const row = document.createElement('div');
    row.className = 'swatchRow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !SHOW_HIDDEN_TAGS.includes(key);
    cb.addEventListener('change', e => {
      SHOW_HIDDEN_TAGS = e.target.checked
        ? SHOW_HIDDEN_TAGS.filter(k => k !== key)
        : [...SHOW_HIDDEN_TAGS, key];
      saveShowHiddenTags();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + label));
    panel.appendChild(row);
  });
}

function saveShowHiddenTags() {
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/hidden-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden_tags: SHOW_HIDDEN_TAGS }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Could not save data tags.');
      loadShowSettings(); // reload to undo the optimistic checkbox change
    }
  });
}

// SE's show-wide Data Bar (the Mode/Aim/Trim/etc. panel) placement
// default -- null means "no override, use the automatic card-width-driven
// placement" (see the "Data Bar mode" CSS rules and resolveDataBarMode in
// app.js), same convention as an individual Date's own override.
const DATA_BAR_MODES = ['side-left', 'side-right', 'bottom', 'hidden'];
let SHOW_DATA_BAR_MODE = null;

function renderShowDataBarPanel() {
  const panel = document.getElementById('dataBarPanel');
  panel.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default placement for every date in this show -- an individual date can still override it for itself.';
  panel.appendChild(note);
  [[null, 'Automatic (by card width)'], ['side-left', 'Side (left)'], ['side-right', 'Side (right)'], ['bottom', 'Bottom'], ['hidden', 'Hidden']].forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'showDataBarMode';
    radio.checked = SHOW_DATA_BAR_MODE === value;
    radio.addEventListener('change', () => {
      SHOW_DATA_BAR_MODE = value;
      saveShowDataBarMode();
    });
    row.appendChild(radio);
    row.appendChild(document.createTextNode(' ' + label));
    panel.appendChild(row);
  });
}

function saveShowDataBarMode() {
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/data-bar-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data_bar_mode: SHOW_DATA_BAR_MODE }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Could not save data bar mode.');
      loadShowSettings(); // reload to undo the optimistic radio change
    }
  });
}

function loadShowSettings() {
  Promise.all([
    fetch('/api/design-fields').then(r => r.ok ? r.json() : { metadata_fields: [] }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG)).then(r => r.ok ? r.json() : { hidden_tags: [], data_bar_mode: null }),
  ]).then(([design, show]) => {
    DESIGN_METADATA_FIELDS = design.metadata_fields || [];
    SHOW_HIDDEN_TAGS = show.hidden_tags || [];
    SHOW_DATA_BAR_MODE = DATA_BAR_MODES.includes(show.data_bar_mode) ? show.data_bar_mode : null;
    renderShowDataTagsPanel();
    renderShowDataBarPanel();
  });
}

document.getElementById('dataTagsToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('dataTagsPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('dataBarToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('dataBarPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});

window.addEventListener('authed', loadDates);
loadDates();
loadShowSettings();
