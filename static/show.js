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

// Server sends dates newest-first already (see list_dates, app.py) --
// kept here so the sort toggle below can flip the view instantly with a
// plain array reverse, no re-fetch needed.
let LAST_DATES = [];
let DATES_OLDEST_FIRST = false;

function renderSortToggleLabel() {
  const btn = document.getElementById('dateSortToggleBtn');
  btn.textContent = DATES_OLDEST_FIRST ? 'Oldest first' : 'Newest first';
}

function loadDates() {
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/dates').then(r => {
    if (!r.ok) { LAST_DATES = []; renderDates([]); return; }
    r.json().then(data => {
      LAST_DATES = data.dates || [];
      renderDates(DATES_OLDEST_FIRST ? [...LAST_DATES].reverse() : LAST_DATES);
    });
  });
}

document.getElementById('dateSortToggleBtn').addEventListener('click', () => {
  DATES_OLDEST_FIRST = !DATES_OLDEST_FIRST;
  renderSortToggleLabel();
  renderDates(DATES_OLDEST_FIRST ? [...LAST_DATES].reverse() : LAST_DATES);
});

// <input type=date> defaults to empty -- pre-filling it with today (in the
// visitor's own local timezone, not the server's) means one tap on the
// date field already lands on the day most likely wanted, rather than
// forcing every date to be picked from scratch.
(function setDefaultDateValue() {
  const input = document.getElementById('newDateInput');
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  input.value = `${now.getFullYear()}-${mm}-${dd}`;
})();

// <input type=date> submits ISO (YYYY-MM-DD) -- converted to M/D/YYYY here
// (split on '-' rather than `new Date(...)`, which parses a bare ISO date
// as UTC midnight and can land on the wrong day once local getMonth()/
// getDate() re-interpret it in a negative-UTC-offset timezone) so newly
// created dates stay in the same free-text display format list_dates'
// own parser (app.py) and every existing date already use.
function isoDateToDisplay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// Same venue-search-fills-Address flow as the Date page's own header
// fields (openVenueSearch/selectVenueResult in app.js) -- just writing
// straight into this form's own inputs instead of STATE/saveState, since
// there's no date (and so nothing to save) until the form is submitted.
const VENUE_SEARCH_MIN_QUERY_LEN = 3;
function openNewDateVenueSearch() {
  const wrap = document.querySelector('.new-date-venue-wrap');
  const existing = wrap.querySelector('.venue-search-dropdown');
  if (existing) { existing.remove(); return; }
  const query = document.getElementById('newDateVenueInput').value.trim();
  if (query.length < VENUE_SEARCH_MIN_QUERY_LEN) return;
  const dropdown = document.createElement('div');
  dropdown.className = 'venue-search-dropdown';
  const loading = document.createElement('div');
  loading.className = 'venue-search-empty';
  loading.textContent = 'Searching…';
  dropdown.appendChild(loading);
  wrap.appendChild(dropdown);
  fetch(`/api/venue-search?q=${encodeURIComponent(query)}`)
    .then(r => r.json())
    .then(data => {
      // The dropdown may have already been closed (click-outside, or a
      // second search fired) by the time this resolves -- nothing left to
      // fill in.
      if (!dropdown.isConnected) return;
      dropdown.innerHTML = '';
      const results = (data && data.results) || [];
      if (!results.length) {
        const empty = document.createElement('div');
        empty.className = 'venue-search-empty';
        empty.textContent = data && data.error ? 'Venue search unavailable.' : 'No matches.';
        dropdown.appendChild(empty);
        return;
      }
      results.forEach(result => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'venue-search-option';
        opt.textContent = result.name;
        if (result.address_short) {
          const sub = document.createElement('span');
          sub.className = 'venue-search-option-sub';
          sub.textContent = result.address_short;
          opt.appendChild(sub);
        }
        opt.addEventListener('click', e => {
          e.stopPropagation();
          document.getElementById('newDateVenueInput').value = result.name;
          document.getElementById('newDateAddressInput').value = result.address_short || '';
          dropdown.remove();
        });
        dropdown.appendChild(opt);
      });
    })
    .catch(() => {
      if (!dropdown.isConnected) return;
      dropdown.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'venue-search-empty';
      empty.textContent = 'Venue search unavailable.';
      dropdown.appendChild(empty);
    });
}
document.getElementById('newDateVenueSearchBtn').addEventListener('click', openNewDateVenueSearch);
document.getElementById('newDateVenueInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); openNewDateVenueSearch(); }
});
document.addEventListener('click', e => {
  if (e.target.closest('.new-date-venue-wrap')) return;
  const open = document.querySelector('.new-date-venue-wrap .venue-search-dropdown');
  if (open) open.remove();
});

document.getElementById('newDateForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const isoDate = form.date.value;
  if (!isoDate) return;
  const date = isoDateToDisplay(isoDate);
  const venue = form.venue.value.trim();
  const address = form.address.value.trim();
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/dates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, venue, address }),
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

// SE's show-wide Data Bar (the Mode/Aim/Trim/etc. panel) placement
// default -- null means "no override, use the automatic card-width-driven
// placement" (see the "Data Bar mode" CSS rules and resolveDataBarMode in
// app.js), same convention as an individual Date's own override. The
// DATA_BAR_MODES value list itself lives in config-fields.js, shared with
// app.js.
let SHOW_DATA_BAR_MODE = null;

// Circuit/hang colors and breakout numbering -- this Show's own standing
// default (show.circuit_color_config), same convention as Data Tags/Data
// Bar above; falls back to the legacy global sidecar only for a Show that
// hasn't set its own yet (see loadShowSettings).
const CIRCUIT_COLOR_CONFIG_DEFAULT = {
  enabled: false, show_row_fill: true, circuit_colors: [], cycle_length: 4, hang_colors: [],
  circuit_set_enabled: false, circuit_set_colors: [], hid_bundle_size: 4, breakout_cable_name: 'Trunk Cable',
  ink_friendly_patterns: false,
};
let CIRCUIT_COLOR_CONFIG = { ...CIRCUIT_COLOR_CONFIG_DEFAULT };

// This Show's own tape-burn-footage default -- a plain per-show field on
// show.json, no cascade of its own to resolve here (unlike Data Bar/
// Colors, which fall back further to a global default for shows that
// haven't set one).
let SHOW_TAPE_BURN_DEFAULT_FT = 0;

// How Trim values display -- decimal feet or feet/inches -- also plain
// per-show fields, same as tape burn above.
let SHOW_TRIM_UNIT_FORMAT = 'decimal';
let SHOW_TRIM_INCHES_PRECISION = 'whole';

function loadShowSettings() {
  return Promise.all([
    fetch('/api/design-fields').then(r => r.ok ? r.json() : { metadata_fields: [] }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG)).then(r => r.ok ? r.json() : { hidden_tags: [], data_bar_mode: null }),
    fetch('/api/circuit-color-config').then(r => r.ok ? r.json() : CIRCUIT_COLOR_CONFIG_DEFAULT),
  ]).then(([design, show, globalColorConfig]) => {
    DESIGN_METADATA_FIELDS = design.metadata_fields || [];
    SHOW_HIDDEN_TAGS = show.hidden_tags || [];
    SHOW_DATA_BAR_MODE = DATA_BAR_MODES.includes(show.data_bar_mode) ? show.data_bar_mode : null;
    // This Show's own circuit_color_config default (see app.py's
    // api_set_show_circuit_color_config) wins when set; a Show that hasn't
    // set one yet (null) falls back to the legacy global sidecar, same
    // cascade build_job() uses server-side.
    const colorConfig = show.circuit_color_config || globalColorConfig;
    CIRCUIT_COLOR_CONFIG = { ...CIRCUIT_COLOR_CONFIG_DEFAULT, ...colorConfig };
    SHOW_TAPE_BURN_DEFAULT_FT = show.tape_burn_default_ft || 0;
    SHOW_TRIM_UNIT_FORMAT = show.trim_unit_format === 'feet_inches' ? 'feet_inches' : 'decimal';
    SHOW_TRIM_INCHES_PRECISION = ['whole', 'half', 'quarter'].includes(show.trim_inches_precision) ? show.trim_inches_precision : 'whole';
  });
}

// --- Configure Show modal ---------------------------------------------
// Two-column dialog: a left-hand list of setting groups, and that group's
// options on the right. Checkbox/radio edits only touch the CONFIG_DRAFT_*
// variables below -- nothing is persisted until Apply/Apply & Exit, so
// Cancel/X/outside-click can discard the draft for free just by not
// calling applyConfigChanges().
const CONFIG_GROUPS = [
  { id: 'dataTags', label: 'Data Tags' },
  { id: 'dataBar', label: 'Data Bar' },
  { id: 'colors', label: 'Colors' },
  { id: 'numbering', label: 'Circuit Numbering' },
  { id: 'pickGroups', label: 'Box Groups' },
  { id: 'tapeBurn', label: 'Tape Burn' },
  { id: 'trimUnits', label: 'Trim Units' },
  { id: 'platformProfiles', label: 'Platform Profiles' },
];
let CONFIG_ACTIVE_GROUP = CONFIG_GROUPS[0].id;
let CONFIG_DRAFT_HIDDEN_TAGS = [];
let CONFIG_DRAFT_DATA_BAR_MODE = null;
let CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG = { ...CIRCUIT_COLOR_CONFIG_DEFAULT };
let CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT = 0;
let CONFIG_DRAFT_TRIM_UNIT_FORMAT = 'decimal';
let CONFIG_DRAFT_TRIM_INCHES_PRECISION = 'whole';

function renderConfigGroups() {
  const list = document.getElementById('configGroupsList');
  list.innerHTML = '';
  CONFIG_GROUPS.forEach(g => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'config-group-btn' + (g.id === CONFIG_ACTIVE_GROUP ? ' active' : '');
    btn.textContent = g.label;
    btn.addEventListener('click', () => {
      CONFIG_ACTIVE_GROUP = g.id;
      renderConfigGroups();
      renderConfigOptions();
    });
    list.appendChild(btn);
  });
}

function renderConfigOptions() {
  if (CONFIG_ACTIVE_GROUP === 'dataBar') renderConfigDataBarOptions();
  else if (CONFIG_ACTIVE_GROUP === 'colors') renderConfigColorsOptions();
  else if (CONFIG_ACTIVE_GROUP === 'numbering') renderConfigNumberingOptions();
  else if (CONFIG_ACTIVE_GROUP === 'pickGroups') renderConfigPickGroupsOptions();
  else if (CONFIG_ACTIVE_GROUP === 'tapeBurn') renderConfigTapeBurnOptions();
  else if (CONFIG_ACTIVE_GROUP === 'trimUnits') renderConfigTrimUnitsOptions();
  else if (CONFIG_ACTIVE_GROUP === 'platformProfiles') renderConfigPlatformProfilesOptions();
  else renderConfigDataTagsOptions();
}

// Show-wide default for how many feet a tape measure's burnt (missing)
// first foot(s) throw off a raw reading -- a Date, then an individual
// hang, can each override this from the Date page itself (see
// makeTapeBurnRow in app.js); this is just the bottom of that cascade.
function renderConfigTapeBurnOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default burn footage for every date/hang in this show -- an individual date or hang can still override it for itself from the Tape Burn row\'s fire icon on the Date page.';
  pane.appendChild(note);
  const row = document.createElement('div');
  row.className = 'swatchRow';
  row.appendChild(document.createTextNode('Burn (ft):'));
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.value = CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT;
  input.addEventListener('change', e => { CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT = parseFloat(e.target.value) || 0; });
  row.appendChild(input);
  pane.appendChild(row);
}

// Show-wide default for how Trim values display -- decimal feet or
// feet/inches -- a Date can override this for itself from the Date page's
// own Trim units panel; this is just the bottom of that cascade.
function renderConfigTrimUnitsOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default Trim display for every date in this show -- an individual date can still override it for itself from the Date page.';
  pane.appendChild(note);

  TRIM_UNIT_FORMAT_OPTIONS.forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'configTrimUnitFormat';
    radio.checked = CONFIG_DRAFT_TRIM_UNIT_FORMAT === value;
    radio.addEventListener('change', () => { CONFIG_DRAFT_TRIM_UNIT_FORMAT = value; renderConfigTrimUnitsOptions(); });
    row.appendChild(radio);
    row.appendChild(document.createTextNode(' ' + label));
    pane.appendChild(row);
  });

  if (CONFIG_DRAFT_TRIM_UNIT_FORMAT === 'feet_inches') {
    const precisionLabel = document.createElement('div');
    precisionLabel.className = 'panel-label';
    precisionLabel.textContent = 'Round inches to:';
    pane.appendChild(precisionLabel);
    TRIM_INCHES_PRECISION_OPTIONS.forEach(([value, label]) => {
      const row = document.createElement('label');
      row.className = 'swatchRow';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'configTrimInchesPrecision';
      radio.checked = CONFIG_DRAFT_TRIM_INCHES_PRECISION === value;
      radio.addEventListener('change', () => { CONFIG_DRAFT_TRIM_INCHES_PRECISION = value; });
      row.appendChild(radio);
      row.appendChild(document.createTextNode(' ' + label));
      pane.appendChild(row);
    });
  }
}

function renderConfigDataTagsOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default for every date in this show -- an individual date, or one hang on it, can still override a tag for itself.';
  pane.appendChild(note);
  const allTags = [{label: 'Mode', key: '__mode'}, ...DESIGN_METADATA_FIELDS];
  allTags.forEach(({label, key}) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !CONFIG_DRAFT_HIDDEN_TAGS.includes(key);
    cb.addEventListener('change', e => {
      CONFIG_DRAFT_HIDDEN_TAGS = e.target.checked
        ? CONFIG_DRAFT_HIDDEN_TAGS.filter(k => k !== key)
        : [...CONFIG_DRAFT_HIDDEN_TAGS, key];
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + label));
    pane.appendChild(row);
  });
}

function renderConfigDataBarOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Default placement for every date in this show -- an individual date can still override it for itself.';
  pane.appendChild(note);
  [[null, 'Automatic (by card width)'], ...DATA_BAR_MODE_OPTIONS].forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'configDataBarMode';
    radio.checked = CONFIG_DRAFT_DATA_BAR_MODE === value;
    radio.addEventListener('change', () => { CONFIG_DRAFT_DATA_BAR_MODE = value; });
    row.appendChild(radio);
    row.appendChild(document.createTextNode(' ' + label));
    pane.appendChild(row);
  });
}

// Circuit/hang colors and breakout numbering -- this Show's own default
// (see CIRCUIT_COLOR_CONFIG above), so these two panes mirror the Date
// page's Colors/Circuit Numbering panels (app.js's renderColorPanel/
// renderNumberingPanel) almost field-for-field, just operating on
// CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG instead of a specific Date's own
// STATE.circuit_color_config. The one thing intentionally left out is the
// "Convert to Hi-D numbering" action itself -- that mutates a Date's actual
// circuit-number text in STATE.sections, which only exists on the Date
// page; there's no specific date's sections to convert here.
function renderConfigColorsOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  renderFlatFieldList(pane, FLAT_FIELD_GROUPS.colors, CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG);
}

// Circuit/hang colors and breakout numbering -- this Show's own default
// (see CIRCUIT_COLOR_CONFIG above), rendered from the same field list as
// the Date page's Colors/Circuit Numbering panels (app.js's
// renderColorPanel/renderNumberingPanel, see config-fields.js) so the two
// stay in lockstep. The one thing intentionally left out here is the
// "Convert to Hi-D numbering" action itself -- that mutates a Date's actual
// circuit-number text in STATE.sections, which only exists on the Date
// page; there's no specific date's sections to convert here.
function renderConfigNumberingOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Circuit breakout numbering (which brand of breakout cable this rig uses) -- the shared default new dates start from. Converting an individual date\'s own circuit numbers still happens on that date\'s own Circuit Numbering panel.';
  pane.appendChild(note);
  const fieldsContainer = document.createElement('div');
  pane.appendChild(fieldsContainer);
  renderFlatFieldList(fieldsContainer, FLAT_FIELD_GROUPS.numbering, CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG);
}

// Physical pick/box groups -- same show-wide-default convention as Colors/
// Numbering above, sharing config-fields.js's field list with app.js's
// renderPickGroupsPanel.
function renderConfigPickGroupsOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Physical pick groups (badges the boxes in one hoisted stack A1, A2, ... B1, B2, ...) -- the shared default new dates start from.';
  pane.appendChild(note);
  const fieldsContainer = document.createElement('div');
  pane.appendChild(fieldsContainer);
  renderFlatFieldList(fieldsContainer, FLAT_FIELD_GROUPS.pickGroups, CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG);
}

// PA Platform Profiles -- named, global (cross-show) snapshots of the
// settings otherwise scattered across the Date page's Colors/Numbering
// panels plus a Show's own Data Tags/Data Bar defaults. Applying one is an
// immediate, confirmed action (not routed through the modal's own
// Cancel/Apply/Apply & Exit footer, which stays scoped to Data Tags/Data
// Bar) -- it's a bulk preset swap, not a fine-grained toggle edit. It only
// overwrites this show's own defaults and the global "next new date"
// carry-forward prefs/colors, never an already-existing date's own job.json.
function renderConfigPlatformProfilesOptions() {
  const pane = document.getElementById('configOptionsPane');
  pane.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Applying a profile sets this show’s Data Tags/Data Bar defaults and updates the shared Colors/Numbering/View setup used for new dates going forward. It won’t change dates that already exist.';
  pane.appendChild(note);
  const list = document.createElement('div');
  list.id = 'platformProfilesList';
  pane.appendChild(list);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'show-all-tags-btn';
  addBtn.textContent = 'Save current settings as profile…';
  addBtn.addEventListener('click', () => renderNewProfileForm(pane, addBtn));
  pane.appendChild(addBtn);
  loadAndRenderPlatformProfiles();
}

function renderNewProfileForm(pane, addBtn) {
  addBtn.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'hangs-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hangs-name-input';
  input.placeholder = 'Profile name (e.g. Hi-D)';
  input.maxLength = 60;
  row.appendChild(input);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) return;
    createPlatformProfile(name);
    row.remove();
    addBtn.style.display = '';
  });
  row.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    row.remove();
    addBtn.style.display = '';
  });
  row.appendChild(cancelBtn);
  pane.insertBefore(row, addBtn);
  input.focus();
}

function loadAndRenderPlatformProfiles() {
  fetch('/api/platform-profiles').then(r => r.ok ? r.json() : { profiles: [] }).then(data => {
    const list = document.getElementById('platformProfilesList');
    if (!list) return; // pane may have moved on to a different group by the time this resolves
    list.innerHTML = '';
    const profiles = data.profiles || [];
    if (!profiles.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-note';
      empty.textContent = 'No profiles saved yet.';
      list.appendChild(empty);
      return;
    }
    profiles.forEach(profile => {
      const row = document.createElement('div');
      row.className = 'hangs-row';
      const label = document.createElement('span');
      label.className = 'tag-override-label';
      label.textContent = profile.name;
      row.appendChild(label);
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => applyPlatformProfile(profile));
      row.appendChild(applyBtn);
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deletePlatformProfile(profile));
      row.appendChild(deleteBtn);
      list.appendChild(row);
    });
  });
}

function createPlatformProfile(name) {
  fetch('/api/platform-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, show_slug: SHOW_SLUG }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Could not save profile.');
      return;
    }
    loadAndRenderPlatformProfiles();
  });
}

function applyPlatformProfile(profile) {
  if (!confirm('Apply "' + profile.name + '"? This replaces this show’s Data Tags/Data Bar defaults and the shared Colors/Numbering/View setup used for new dates.')) return;
  fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/apply-platform-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profile.id }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Could not apply profile.');
      return;
    }
    loadShowSettings().then(() => {
      CONFIG_DRAFT_HIDDEN_TAGS = [...SHOW_HIDDEN_TAGS];
      CONFIG_DRAFT_DATA_BAR_MODE = SHOW_DATA_BAR_MODE;
      CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG = JSON.parse(JSON.stringify(CIRCUIT_COLOR_CONFIG));
    });
  });
}

function deletePlatformProfile(profile) {
  if (!confirm('Delete "' + profile.name + '"?')) return;
  fetch('/api/platform-profiles/' + encodeURIComponent(profile.id), { method: 'DELETE' }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Could not delete profile.');
      return;
    }
    loadAndRenderPlatformProfiles();
  });
}

function openConfigModal() {
  loadShowSettings().then(() => {
    CONFIG_DRAFT_HIDDEN_TAGS = [...SHOW_HIDDEN_TAGS];
    CONFIG_DRAFT_DATA_BAR_MODE = SHOW_DATA_BAR_MODE;
    CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG = JSON.parse(JSON.stringify(CIRCUIT_COLOR_CONFIG));
    CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT = SHOW_TAPE_BURN_DEFAULT_FT;
    CONFIG_DRAFT_TRIM_UNIT_FORMAT = SHOW_TRIM_UNIT_FORMAT;
    CONFIG_DRAFT_TRIM_INCHES_PRECISION = SHOW_TRIM_INCHES_PRECISION;
    renderConfigGroups();
    renderConfigOptions();
    document.getElementById('configureShowModal').hidden = false;
  });
}

function closeConfigModal() {
  document.getElementById('configureShowModal').hidden = true;
}

function applyConfigChanges() {
  return Promise.all([
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/hidden-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_tags: CONFIG_DRAFT_HIDDEN_TAGS }),
    }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/data-bar-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data_bar_mode: CONFIG_DRAFT_DATA_BAR_MODE }),
    }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/circuit-color-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ circuit_color_config: CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG }),
    }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/tape-burn-default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tape_burn_default_ft: CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT }),
    }),
    fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/trim-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trim_unit_format: CONFIG_DRAFT_TRIM_UNIT_FORMAT, trim_inches_precision: CONFIG_DRAFT_TRIM_INCHES_PRECISION }),
    }),
  ]).then(async ([tagsRes, barRes, colorsRes, tapeBurnRes, trimUnitsRes]) => {
    if (!tagsRes.ok || !barRes.ok || !colorsRes.ok || !tapeBurnRes.ok || !trimUnitsRes.ok) {
      const failed = !tagsRes.ok ? tagsRes : (!barRes.ok ? barRes : (!colorsRes.ok ? colorsRes : (!tapeBurnRes.ok ? tapeBurnRes : trimUnitsRes)));
      const body = await failed.json().catch(() => ({}));
      alert(body.error || 'Could not save settings.');
      return false;
    }
    SHOW_HIDDEN_TAGS = [...CONFIG_DRAFT_HIDDEN_TAGS];
    SHOW_DATA_BAR_MODE = CONFIG_DRAFT_DATA_BAR_MODE;
    CIRCUIT_COLOR_CONFIG = JSON.parse(JSON.stringify(CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG));
    SHOW_TAPE_BURN_DEFAULT_FT = CONFIG_DRAFT_TAPE_BURN_DEFAULT_FT;
    SHOW_TRIM_UNIT_FORMAT = CONFIG_DRAFT_TRIM_UNIT_FORMAT;
    SHOW_TRIM_INCHES_PRECISION = CONFIG_DRAFT_TRIM_INCHES_PRECISION;
    return true;
  });
}

document.getElementById('configureShowBtn').addEventListener('click', openConfigModal);
document.getElementById('configModalCloseBtn').addEventListener('click', closeConfigModal);
document.getElementById('configCancelBtn').addEventListener('click', closeConfigModal);
document.getElementById('configApplyBtn').addEventListener('click', () => { applyConfigChanges(); });
document.getElementById('configApplyExitBtn').addEventListener('click', () => {
  applyConfigChanges().then(ok => { if (ok) closeConfigModal(); });
});
document.getElementById('configureShowModal').addEventListener('click', e => {
  if (e.target.id === 'configureShowModal') closeConfigModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('configureShowModal').hidden) closeConfigModal();
});

window.addEventListener('authed', loadDates);
loadDates();
loadShowSettings();
