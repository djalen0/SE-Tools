const SHOW_SLUG = document.body.getAttribute('data-show-slug');

function dateHref(dateSlug) { return '/' + encodeURIComponent(SHOW_SLUG) + '/' + encodeURIComponent(dateSlug); }

function argbToCss(argb) {
  if (!argb) return null;
  const h = argb.replace('#', '');
  const rgb = h.length >= 6 ? h.slice(-6) : h.padStart(6, '0');
  return '#' + rgb;
}

function cssToArgb(css) {
  return 'FF' + css.replace('#', '').toUpperCase();
}

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

// SE's show-wide Data Bar (the Mode/Aim/Trim/etc. panel) placement
// default -- null means "no override, use the automatic card-width-driven
// placement" (see the "Data Bar mode" CSS rules and resolveDataBarMode in
// app.js), same convention as an individual Date's own override.
const DATA_BAR_MODES = ['side-left', 'side-right', 'bottom', 'hidden'];
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

  [['decimal', 'Decimal feet (e.g. 56.89 ft)'], ['feet_inches', 'Feet & inches (e.g. 56\' 11")']].forEach(([value, label]) => {
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
    [['whole', 'Whole inch'], ['half', 'Half inch'], ['quarter', 'Quarter inch']].forEach(([value, label]) => {
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
  [[null, 'Automatic (by card width)'], ['side-left', 'Side (left)'], ['side-right', 'Side (right)'], ['bottom', 'Bottom'], ['hidden', 'Hidden']].forEach(([value, label]) => {
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
  const cfg = CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG;
  pane.innerHTML = '';

  const enabledRow = document.createElement('label');
  enabledRow.className = 'swatchRow';
  const enabledCb = document.createElement('input');
  enabledCb.type = 'checkbox';
  enabledCb.checked = !!cfg.enabled;
  enabledCb.addEventListener('change', e => { cfg.enabled = e.target.checked; });
  enabledRow.appendChild(enabledCb);
  enabledRow.appendChild(document.createTextNode(' Enable circuit coloring'));
  pane.appendChild(enabledRow);

  const rowFillRow = document.createElement('label');
  rowFillRow.className = 'swatchRow';
  const rowFillCb = document.createElement('input');
  rowFillCb.type = 'checkbox';
  rowFillCb.checked = cfg.show_row_fill !== false;
  rowFillCb.addEventListener('change', e => { cfg.show_row_fill = e.target.checked; });
  rowFillRow.appendChild(rowFillCb);
  rowFillRow.appendChild(document.createTextNode(' Show color across whole row'));
  pane.appendChild(rowFillRow);

  const inkRow = document.createElement('label');
  inkRow.className = 'swatchRow';
  const inkCb = document.createElement('input');
  inkCb.type = 'checkbox';
  inkCb.checked = !!cfg.ink_friendly_patterns;
  inkCb.addEventListener('change', e => { cfg.ink_friendly_patterns = e.target.checked; });
  inkRow.appendChild(inkCb);
  inkRow.appendChild(document.createTextNode(' Use ink-friendly patterns (for black & white printing)'));
  pane.appendChild(inkRow);

  // Hang identity stripes listed first -- crews retune/add these per rig far
  // more often than the underlying circuit color palette below, which tends
  // to stay put once set.
  const hangHeader = document.createElement('div');
  hangHeader.className = 'panel-label';
  hangHeader.textContent = 'Hang identity stripes (matched against each card\'s title)';
  pane.appendChild(hangHeader);
  (cfg.hang_colors || []).forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'swatchRow';
    const matchInp = document.createElement('input');
    matchInp.type = 'text';
    matchInp.placeholder = 'e.g. side';
    matchInp.value = entry.match || '';
    matchInp.addEventListener('change', e => { entry.match = e.target.value; });
    row.appendChild(matchInp);
    const colorInp = document.createElement('input');
    colorInp.type = 'color';
    colorInp.value = argbToCss(entry.fill) || '#ffffff';
    colorInp.addEventListener('change', e => { entry.fill = cssToArgb(e.target.value); });
    row.appendChild(colorInp);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.hang_colors.splice(i, 1); renderConfigColorsOptions(); });
    row.appendChild(rm);
    pane.appendChild(row);
  });
  const addHangBtn = document.createElement('button');
  addHangBtn.type = 'button';
  addHangBtn.textContent = '+ hang stripe rule';
  addHangBtn.addEventListener('click', () => { (cfg.hang_colors = cfg.hang_colors || []).push({ match: '', fill: 'FFFFFFFF' }); renderConfigColorsOptions(); });
  pane.appendChild(addHangBtn);

  const paletteLabel = document.createElement('div');
  paletteLabel.className = 'panel-label';
  paletteLabel.textContent = 'Circuit colors';
  pane.appendChild(paletteLabel);
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'swatch-grid';
  (cfg.circuit_colors || []).forEach((hex, i) => {
    const item = document.createElement('div');
    item.className = 'swatch-item';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_colors[i] = cssToArgb(e.target.value); });
    item.appendChild(inp);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_colors.splice(i, 1); renderConfigColorsOptions(); });
    item.appendChild(rm);
    paletteGrid.appendChild(item);
  });
  pane.appendChild(paletteGrid);
  const addColorBtn = document.createElement('button');
  addColorBtn.type = 'button';
  addColorBtn.textContent = '+ color';
  addColorBtn.addEventListener('click', () => { (cfg.circuit_colors = cfg.circuit_colors || []).push('FFCCCCCC'); renderConfigColorsOptions(); });
  pane.appendChild(addColorBtn);

  const cycleRow = document.createElement('div');
  cycleRow.className = 'swatchRow';
  cycleRow.appendChild(document.createTextNode('Repeats after N colors:'));
  const cycleInput = document.createElement('input');
  cycleInput.type = 'number';
  cycleInput.min = 1;
  cycleInput.value = cfg.cycle_length || 4;
  cycleInput.addEventListener('change', e => { cfg.cycle_length = parseInt(e.target.value) || 1; });
  cycleRow.appendChild(cycleInput);
  pane.appendChild(cycleRow);
}

function renderConfigNumberingOptions() {
  const pane = document.getElementById('configOptionsPane');
  const cfg = CONFIG_DRAFT_CIRCUIT_COLOR_CONFIG;
  const cableName = cfg.breakout_cable_name || 'Trunk Cable';
  pane.innerHTML = '';

  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Circuit breakout numbering (which brand of breakout cable this rig uses) -- the shared default new dates start from. Converting an individual date\'s own circuit numbers still happens on that date\'s own Circuit Numbering panel.';
  pane.appendChild(note);

  const nameRow = document.createElement('div');
  nameRow.className = 'swatchRow';
  nameRow.appendChild(document.createTextNode('Breakout cable name:'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = cableName;
  nameInput.placeholder = 'Trunk Cable / Socapex / NL8...';
  nameInput.addEventListener('change', e => {
    cfg.breakout_cable_name = e.target.value.trim() || 'Trunk Cable';
    renderConfigNumberingOptions();
  });
  nameRow.appendChild(nameInput);
  pane.appendChild(nameRow);

  const bundleRow = document.createElement('div');
  bundleRow.className = 'swatchRow';
  bundleRow.appendChild(document.createTextNode('Circuits per breakout cable:'));
  const bundleInput = document.createElement('input');
  bundleInput.type = 'number';
  bundleInput.min = 1;
  bundleInput.value = cfg.hid_bundle_size || 4;
  bundleInput.addEventListener('change', e => { cfg.hid_bundle_size = parseInt(e.target.value) || 4; });
  bundleRow.appendChild(bundleInput);
  pane.appendChild(bundleRow);

  const setHeader = document.createElement('div');
  setHeader.className = 'panel-label';
  setHeader.textContent = cableName + ' stripe (next to CKT, groups every N circuits above -- same N)';
  pane.appendChild(setHeader);

  const setEnabledRow = document.createElement('label');
  setEnabledRow.className = 'swatchRow';
  const setEnabledCb = document.createElement('input');
  setEnabledCb.type = 'checkbox';
  setEnabledCb.checked = !!cfg.circuit_set_enabled;
  setEnabledCb.addEventListener('change', e => { cfg.circuit_set_enabled = e.target.checked; });
  setEnabledRow.appendChild(setEnabledCb);
  setEnabledRow.appendChild(document.createTextNode(' Show ' + cableName + ' stripe'));
  pane.appendChild(setEnabledRow);

  const setPaletteLabel = document.createElement('div');
  setPaletteLabel.className = 'panel-label';
  setPaletteLabel.textContent = 'Stripe colors';
  pane.appendChild(setPaletteLabel);
  const setPaletteGrid = document.createElement('div');
  setPaletteGrid.className = 'swatch-grid';
  (cfg.circuit_set_colors || []).forEach((hex, i) => {
    const item = document.createElement('div');
    item.className = 'swatch-item';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_set_colors[i] = cssToArgb(e.target.value); });
    item.appendChild(inp);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_set_colors.splice(i, 1); renderConfigNumberingOptions(); });
    item.appendChild(rm);
    setPaletteGrid.appendChild(item);
  });
  pane.appendChild(setPaletteGrid);
  const addSetColorBtn = document.createElement('button');
  addSetColorBtn.type = 'button';
  addSetColorBtn.textContent = '+ color';
  addSetColorBtn.addEventListener('click', () => { (cfg.circuit_set_colors = cfg.circuit_set_colors || []).push('FFCCCCCC'); renderConfigNumberingOptions(); });
  pane.appendChild(addSetColorBtn);
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
