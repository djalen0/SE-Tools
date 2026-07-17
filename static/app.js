// Pinning Sheet Editor -- webapp client. Ported from the local desktop
// editor's embedded script with no changes to the rendering/color/Hi-D
// logic (already tested there) -- only the additions needed to be a real
// webapp: upload instead of a local input/ folder, an empty state before
// anything's been uploaded, view-only mode for read-only links, and
// export streaming an actual .xlsx download instead of writing to a local
// output/ folder.

const FIELD_LABELS = {label:'Cab', model:'Model', dispersion:'Disp', angle:'Splay', circuit:'CKT', nfc:'NFC'};
let STATE = null;

// True for the duration of a PDF export (see runPrint) -- guards every
// render()-triggering listener below (the debounced window resize one,
// plus DESKTOP_MQL's and MULTI_CARD_MQL's "change" listeners) against
// firing mid-export, which would silently overwrite the export's own
// column count and zoom level with the on-screen ones, corrupting the
// very layout the browser is about to paginate. Opening the print
// dialog/preview can shrink the effective viewport enough to cross
// either matchMedia breakpoint, firing its listener immediately (these
// two aren't debounced like the resize one is), so this isn't just a
// theoretical race -- it's the actual cause of cards printing at full
// width instead of the intended column count.
let PRINT_IN_PROGRESS = false;

// Which hang is showing in Tabs view (see renderHangTabs) -- kept outside
// STATE since it's just a transient viewing position, not something worth
// persisting/exporting like the rest of the job. Clamped back into range
// on every render, so switching shows/dates or a re-upload that shrinks
// the section count can't leave it pointing past the end. Can also be the
// string 'all' -- the All tab, which shows every hang at once without
// leaving Tabs view (see render()).
let activeHangIndex = 'all';

// This Date's identity, from the URL (see date_page() in app.py, which
// passes both into the template as data-* attributes on <body>) -- every
// API call for this job is scoped under these two.
const SHOW_SLUG = document.body.getAttribute('data-show-slug');
const DATE_SLUG = document.body.getAttribute('data-date-slug');
const API_BASE = `/api/shows/${encodeURIComponent(SHOW_SLUG)}/dates/${encodeURIComponent(DATE_SLUG)}`;

// Standard "link" (chain) glyph -- marks two boxes wired to the same
// circuit (see the circuit-link-icon rendering in renderCard).
const LINK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// Read-only links: open the page as .../?view=1 to hand someone a
// look-but-don't-touch copy -- everything stays visible, but every input,
// upload, and Save control is disabled. Export is left enabled since
// downloading a copy doesn't touch the shared job.
const VIEW_ONLY = new URLSearchParams(location.search).get('view') === '1';

// The password only gates EDITING, not viewing -- every page's data loads
// for anyone (see the GET-requests-are-public carve-out in app.py's
// require_login), so an anonymous visitor should land in the exact same
// read-only shape as a ?view=1 link, not just watch every save/upload
// 401 silently. Starts locked-down (safe default) until the real status
// comes back, and stays in sync with the lock icon's own login/logout
// (see the "authed"/"signedout" events at the bottom of this file).
let AUTHED = false;
function isReadOnly() { return VIEW_ONLY || !AUTHED; }

// Which Data Tags (Mode/Aim/Trim/Angle/etc.) are hidden -- a per-device
// local override (see localHiddenTags below) sits on top of a three-level
// shared cascade, most-specific wins: one hang's own override (section's
// own hidden_tags_overrides, part of the saved job) beats this Date's
// override (STATE.hidden_tags_overrides) beats the Show's own standing
// default (SHOW_META.hidden_tags, set by the SE from the Show page and
// shared by every Date under it). A level that doesn't mention a given
// key just falls through to the next one down.
let SHOW_META = null;

async function loadShowMeta() {
  const res = await fetch(`/api/shows/${encodeURIComponent(SHOW_SLUG)}`);
  SHOW_META = res.ok ? await res.json() : {hidden_tags: [], data_bar_mode: null};
}

// Global (not per-show) Hang Profiles -- see applyHangProfileToSection and
// the Hang Define popover (makeHangDefineTrigger/renderHangDefinePopover)
// below. Loaded once per page; refreshed after any create/update/delete.
let HANG_PROFILES = [];

async function loadHangProfiles() {
  const res = await fetch('/api/hang-profiles');
  HANG_PROFILES = res.ok ? (await res.json()).profiles || [] : [];
}

// Which section (by object identity -- STATE.sections entries are mutated
// in place, not replaced, so this reference stays valid across render()
// calls) currently has its Hang Define popover open. A plain local closure
// variable wouldn't survive renderCard rebuilding the whole card on every
// edit inside the popover, which is why this lives at module scope instead.
let openHangDefineSection = null;

// Data Bar (the Mode/Aim/Trim/Angle/etc. panel) placement -- Date override
// beats Show default beats null ("no override, use the automatic
// card-width-driven placement" -- see the "Data Bar mode" CSS rules).
// Same two-level cascade as Data Tags, minus the per-hang card level (this
// is a whole-Date layout choice, not something that makes sense to vary
// hang to hang).
const DATA_BAR_MODES = ['side-left', 'side-right', 'bottom', 'hidden'];
const DATA_BAR_LABELS = {'side-left': 'side (left)', 'side-right': 'side (right)', 'bottom': 'bottom', 'hidden': 'hidden'};
function resolveDataBarMode() {
  if (STATE && DATA_BAR_MODES.includes(STATE.data_bar_mode_override)) return STATE.data_bar_mode_override;
  if (SHOW_META && DATA_BAR_MODES.includes(SHOW_META.data_bar_mode)) return SHOW_META.data_bar_mode;
  return null;
}

// A view-only visitor can't write to the shared job/show at all, but
// still wants to declutter their own screen -- this is that: a flat,
// device-local "hide everywhere" list (localStorage, never sent to the
// server), same shape as the old pre-hierarchy version of this feature.
// It only ever ADDS hiding on top of whatever the SE's shared settings
// already say; it can't force something the SE hid back into view (that
// would need write access to the shared job, which a view-only visitor
// doesn't have). Available to editors too (nothing gates it behind
// isReadOnly()), but the UI to manage it only surfaces for view-only
// visitors -- see renderDataTagsPanel and makeTagHideBtn -- since editors
// already have the full shared hierarchy for this.
const LOCAL_HIDDEN_TAGS_KEY = 'pa-pinner-local-hidden-tags';
let localHiddenTags = new Set();
try { localHiddenTags = new Set(JSON.parse(localStorage.getItem(LOCAL_HIDDEN_TAGS_KEY)) || []); } catch (e) {}
function setLocalTagHidden(key, hidden) {
  if (hidden) localHiddenTags.add(key); else localHiddenTags.delete(key);
  localStorage.setItem(LOCAL_HIDDEN_TAGS_KEY, JSON.stringify([...localHiddenTags]));
  render();
}
function clearLocalHiddenTags() {
  localHiddenTags.clear();
  localStorage.setItem(LOCAL_HIDDEN_TAGS_KEY, JSON.stringify([]));
  render();
}

function isTagHidden(key, section) {
  if (localHiddenTags.has(key)) return true;
  const cardOverrides = (section && section.hidden_tags_overrides) || {};
  if (Object.prototype.hasOwnProperty.call(cardOverrides, key)) return cardOverrides[key];
  const dateOverrides = (STATE && STATE.hidden_tags_overrides) || {};
  if (Object.prototype.hasOwnProperty.call(dateOverrides, key)) return dateOverrides[key];
  return ((SHOW_META && SHOW_META.hidden_tags) || []).includes(key);
}

// null clears the override, falling back to whatever the next level down
// says instead of forcing shown/hidden.
function setCardTagOverride(section, key, hidden) {
  section.hidden_tags_overrides = section.hidden_tags_overrides || {};
  if (hidden === null) delete section.hidden_tags_overrides[key];
  else section.hidden_tags_overrides[key] = hidden;
  render();
  saveState(false);
}

function setDateTagOverride(key, hidden) {
  STATE.hidden_tags_overrides = STATE.hidden_tags_overrides || {};
  if (hidden === null) delete STATE.hidden_tags_overrides[key];
  else STATE.hidden_tags_overrides[key] = hidden;
  render();
  saveState(false);
}

// null clears this Date's override, falling back to the Show default (or
// automatic, if the Show has none either).
function setDataBarModeOverride(mode) {
  STATE.data_bar_mode_override = mode;
  render();
  saveState(false);
}

function allTagsWithLabels() {
  return [{label: 'Mode', key: '__mode'}, ...(STATE.metadata_fields || [])];
}
function allTagKeys() {
  return allTagsWithLabels().map(t => t.key);
}

// Reveals everything hidden on just ONE hang. For an editor, that means
// setting an explicit card-level "show" override for each currently-
// hidden tag -- doesn't touch the Date or Show settings, so it can't
// change how any other hang looks (same action the Data Tags panel's
// "Show all" used to do globally; that panel now edits the Date-level
// override instead, see renderDataTagsPanel). A view-only visitor has no
// shared state to override, so for them this instead clears their own
// local hide list -- device-wide, not just this card, since that list
// was never scoped per-hang to begin with.
function showAllTagsOnCard(section) {
  if (isReadOnly()) { clearLocalHiddenTags(); return; }
  allTagKeys().forEach(key => {
    if (isTagHidden(key, section)) setCardTagOverrideQuiet(section, key, false);
  });
  render();
  saveState(false);
}
function setCardTagOverrideQuiet(section, key, hidden) {
  section.hidden_tags_overrides = section.hidden_tags_overrides || {};
  section.hidden_tags_overrides[key] = hidden;
}

// The little "x" on each Data Tag chip -- immediate one-click hide, right
// where the tag someone doesn't care about actually is, rather than only
// being able to manage visibility from a separate settings list. An
// editor hides it on just this one hang (a card-level override); Trim/
// Aim/etc. across the whole Date is the Data Tags panel's job, and across
// the whole Show is the Show page's. A view-only visitor has no shared
// state to write to, so for them this hides it everywhere, on just their
// own device (see localHiddenTags above).
function makeTagHideBtn(section, key, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'meta-row-hide-btn';
  btn.textContent = '×';
  if (isReadOnly()) {
    btn.title = `Hide "${label}" everywhere, just for you on this device`;
    btn.setAttribute('aria-label', `Hide ${label} on this device`);
    btn.addEventListener('click', e => { e.stopPropagation(); setLocalTagHidden(key, true); });
  } else {
    btn.title = `Hide "${label}" on this hang`;
    btn.setAttribute('aria-label', `Hide ${label} on this hang`);
    btn.addEventListener('click', e => { e.stopPropagation(); setCardTagOverride(section, key, true); });
  }
  return btn;
}

// True for the entire duration of a print/PDF export (see runPrint) --
// body carries one of these classes from just before populateGrid()
// rebuilds the grid for print through to cleanup, so renderCard can tell
// it's building the printed version of a card, not the on-screen one.
function isPrintMode() {
  return document.body.classList.contains('print-mode-grid') || document.body.classList.contains('print-mode-mobile');
}

// Effective tape-burn footage for a hang -- hang's own override, then this
// Date's, then the Show's standing default, then 0. Same null-cascade
// convention as resolveDataBarMode above.
function resolveTapeBurnFt(section) {
  if (section && typeof section.tape_burn_ft === 'number') return section.tape_burn_ft;
  if (STATE && typeof STATE.tape_burn_override_ft === 'number') return STATE.tape_burn_override_ft;
  if (SHOW_META && typeof SHOW_META.tape_burn_default_ft === 'number') return SHOW_META.tape_burn_default_ft;
  return 0;
}

// A tape measure missing its first foot or two reads that many feet long
// on every measurement -- splits the raw Trim value into its leading
// number and whatever suffix follows (e.g. "52 ft" -> 52 and " ft"),
// subtracts the burn, and reattaches the suffix. Falls back to the raw
// value unchanged if it doesn't start with a number, rather than erroring.
function trueTrimValue(raw, burnFt) {
  const m = String(raw).match(/^(-?\d+(?:\.\d+)?)(.*)$/);
  if (!m) return raw;
  const num = Math.round((parseFloat(m[1]) - burnFt) * 100) / 100;
  return num + m[2];
}

// One shared "Tape Burn" row per hang, right after its Trim row(s) --
// shows this hang's effective burn footage (see resolveTapeBurnFt's
// hang/date/show cascade). Editable right here (fire icon swaps the value
// for a number input) as well as from the Hang Define popover -- both
// read/write the same section.tape_burn_ft, so they always stay in sync.
// Signed-out/view-only visitors can't use either: the fire icon and the
// input it reveals both go through the normal editable-controls set that
// applyViewOnlyLock() disables, same as every other in-card control.
function makeTapeBurnRow(section) {
  const row = document.createElement('div');
  row.className = 'meta-row';
  const l = document.createElement('div');
  l.className = 'meta-label';
  l.textContent = 'Tape Burn';
  const v = document.createElement('div');
  v.className = 'meta-value';
  const burnFt = resolveTapeBurnFt(section);

  const valueSpan = document.createElement('span');
  valueSpan.textContent = burnFt + ' ft';
  v.appendChild(valueSpan);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tape-burn-btn';
  editBtn.title = "This hang's tape-burn footage -- click to edit (also editable from the hang's Define menu)";
  editBtn.setAttribute('aria-label', 'Edit tape burn footage');
  editBtn.textContent = '\u{1F525}';
  editBtn.addEventListener('click', e => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.className = 'tape-burn-ft-input';
    input.value = burnFt;
    input.addEventListener('click', e2 => e2.stopPropagation());
    const commit = () => {
      const n = parseFloat(input.value);
      section.tape_burn_ft = Number.isFinite(n) ? n : null;
      render();
      saveState(false);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e2 => { if (e2.key === 'Enter') input.blur(); });
    v.replaceChild(input, valueSpan);
    input.focus();
    input.select();
  });
  v.appendChild(editBtn);

  row.appendChild(l); row.appendChild(v);
  return row;
}

// The card grid is mobile-first: below this width cards always stack one
// per row (a "cards per row" setting of 2+ would be unreadably narrow on a
// phone), regardless of the user's cards_per_row preference -- only above
// it does that preference actually take effect. Re-renders on cross-over
// so rotating a phone or resizing a window updates the layout live.
const DESKTOP_MQL = window.matchMedia('(min-width: 700px)');
DESKTOP_MQL.addEventListener('change', () => { if (!PRINT_IN_PROGRESS) render(); });

// Below this width, a card + its meta-col (Aim/Trim/Angle/etc.) can't
// share a row with a second card without squeezing every field back into
// the cramped, truncation-prone layout this was just fixed to avoid --
// so multi-column mode only kicks in once there's actually room for it,
// same "collapse to 1 regardless of the user's setting" treatment as the
// phone-width DESKTOP_MQL check above, just at a wider threshold.
const MULTI_CARD_MQL = window.matchMedia('(min-width: 1250px)');
MULTI_CARD_MQL.addEventListener('change', () => { if (!PRINT_IN_PROGRESS) render(); });

// card-body's own min-width (675px, see style.css) needs a bit more than
// that on the whole CARD once the hang-stripe-bar (7% of the card's width
// at this breakpoint) and its border are accounted for -- 675 / 0.93,
// rounded up. cards_per_row is a ceiling, not a fixed count: if that many
// columns would squeeze each card narrower than this, card-body's
// min-width would overflow the card and get clipped by its own
// overflow:hidden, so this backs off to however many columns actually
// fit instead.
const MIN_CARD_WIDTH_PX = 726;
const GRID_GAP_PX = 18;
function computeGridColumns(desired) {
  if (desired <= 1) return 1;
  const gridEl = document.getElementById('grid');
  const style = getComputedStyle(gridEl);
  const contentWidth = gridEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  for (let n = desired; n > 1; n--) {
    if ((contentWidth - GRID_GAP_PX * (n - 1)) / n >= MIN_CARD_WIDTH_PX) return n;
  }
  return 1;
}
// computeGridColumns needs to react to any width change, not just the two
// DESKTOP_MQL/MULTI_CARD_MQL snap points above -- e.g. shrinking a window
// from 1600px to 1300px never crosses either breakpoint, but can still
// cross the point where 2 columns stop fitting. Debounced since resize
// fires continuously while dragging. Skipped entirely while a PDF export
// is in flight (see PRINT_IN_PROGRESS in runPrint) -- opening the print
// dialog/preview can itself fire a resize event, and this render() call
// uses the on-screen column logic (computeGridColumns), which would
// silently overwrite the export's own column count, corrupting the very
// layout the browser is about to paginate.
let resizeRenderTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeRenderTimer);
  resizeRenderTimer = setTimeout(() => { if (!PRINT_IN_PROGRESS) render(); }, 120);
});

async function loadState() {
  const res = await fetch(`${API_BASE}/state`);
  // A non-ok response (401 locked, 404 gone) isn't a job -- treat it the
  // same as no job loaded rather than rendering whatever error body came
  // back as if it were real state.
  STATE = res.ok ? await res.json() : null;
  render();
}

// Lets the breadcrumb's date dropdown (in the mobile topbar and the
// desktop sidebar -- see .date-switcher in index.html) jump straight to
// any other date already in this show, without going back through the
// Show page. Populated once (the list of dates doesn't change from
// editing this one), and again after signing in if it 401'd locked.
function initDateSwitcher() {
  const switchers = document.querySelectorAll('.date-switcher');
  if (!switchers.length) return;
  fetch(`/api/shows/${encodeURIComponent(SHOW_SLUG)}/dates`).then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    const qs = VIEW_ONLY ? '?view=1' : '';
    switchers.forEach(sel => {
      sel.innerHTML = '';
      (data.dates || []).forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.slug;
        opt.textContent = d.date;
        if (d.slug === DATE_SLUG) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => {
        window.location.href = `/${encodeURIComponent(SHOW_SLUG)}/${encodeURIComponent(sel.value)}${qs}`;
      };
    });
  });
}

// Ink-friendly print patterns (dots/stripes/plaid) cycle independently of
// the color palette's own length -- a fixed set of INK_PATTERN_COUNT
// distinct textures (see .ink-pattern-N in style.css), assigned by the
// same index used to pick each entry's color, so two circuits/hangs that
// land on the same pattern also very likely differ in cycle position
// enough to still read as distinct even without any color at all.
const INK_PATTERN_COUNT = 6;

function assignCircuitColors(cabinets, palette) {
  const map = {};
  if (!palette || !palette.length) return map;
  // Group by the ORIGINAL (pre-Hi-D) circuit number, not the currently
  // displayed cab.ckt -- same reasoning as assignCircuitSetColors below:
  // once Hi-D numbering is applied, every breakout cable's legs get
  // relabeled back to the same few strings, so grouping by the displayed
  // label would collapse every breakout on the whole hang into one
  // indistinguishable row-fill color instead of cycling normally.
  cabinets.forEach(c => {
    const ckt = c._normalCkt !== undefined ? c._normalCkt : c.ckt;
    if (!(ckt in map)) {
      const index = Object.keys(map).length;
      map[ckt] = { fill: palette[index % palette.length], patternIndex: index % INK_PATTERN_COUNT };
    }
  });
  return map;
}

// Distinct (pre-Hi-D) circuit numbers, in first-seen order, chunked into
// bundles of `cycleLength` -- the same grouping assignCircuitSetColors and
// getHidBundleStartKeys both need, factored out so they can't drift apart.
function hidBundleOrder(cabinets, cycleLength) {
  const cl = Math.max(1, cycleLength || 1);
  const seen = new Set();
  const order = [];
  cabinets.forEach(cab => {
    const ckt = cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt;
    if (!seen.has(ckt)) { seen.add(ckt); order.push(ckt); }
  });
  const bundles = [];
  for (let i = 0; i < order.length; i += cl) bundles.push(order.slice(i, i + cl));
  return bundles;
}

// Copies a Hang Profile's whole field set onto one section and links it
// (hang_profile_id/hang_profile_version) -- used both when the SE
// explicitly applies a profile from the Hang Define popover and when they
// answer "keep linked" to the version-mismatch prompt (see
// checkHangProfileVersions). Caller is responsible for render()/saveState.
function applyHangProfileToSection(section, profile) {
  if (profile.rename_to) section.header = profile.rename_to;
  section.tape_burn_ft = profile.tape_burn_ft;
  section.hang_color = profile.hang_color;
  section.hid_reverse_order = profile.hid_reverse_order !== false;
  section.hidden_tags_overrides = {};
  (profile.hidden_tags || []).forEach(key => { section.hidden_tags_overrides[key] = true; });

  const bundleSize = (STATE.circuit_color_config && STATE.circuit_color_config.hid_bundle_size) || 4;
  const bundles = hidBundleOrder(section.cabinets || [], bundleSize);
  const startBreakout = profile.start_breakout || 1;
  section.hid_cable_overrides = (startBreakout > 1 && bundles.length) ? { [bundles[0][0]]: startBreakout } : {};

  section.apply_manual_circuiting = !!profile.apply_manual_circuiting;
  section.manual_circuit_pattern = profile.manual_circuit_pattern || [];
  if (section.apply_manual_circuiting && section.manual_circuit_pattern.length) {
    applyManualCircuitPattern(section);
  } else {
    // Manual circuiting (above) fully replaces the circuit numbers, so it
    // always wins outright. Otherwise, (re-)derive this hang's Hi-D leg
    // numbers right now so start_breakout/hid_reverse_order actually show
    // up on the sheet immediately -- without this, applying a profile just
    // silently sets flags with no visible effect (same gap the reverse-
    // order checkbox itself had, see renderHangDefinePopover).
    applyHiDNumbering([section], bundleSize);
  }

  section.hang_profile_id = profile.id;
  section.hang_profile_version = profile.version;
}

// Tiles a manual circuit-numbering pattern (e.g. [1,2,1] for a cardioid
// sub hang) across a hang's cabinets in order, repeating as needed --
// used both by applyHangProfileToSection and directly from the Hang
// Define popover when the SE edits the pattern by hand (not through a
// profile). Clears _normalCkt on every touched cabinet since the manual
// values become the new baseline, not a Hi-D-converted label.
function applyManualCircuitPattern(section) {
  const pattern = section.manual_circuit_pattern || [];
  if (!pattern.length) return;
  (section.cabinets || []).forEach((cab, i) => {
    cab.ckt = String(pattern[i % pattern.length]);
    delete cab._normalCkt;
  });
}

// Run once at page load, after both this Date's job and the global Hang
// Profiles list are in hand -- a hang only ever re-adopts its linked
// profile's settings on explicit action (see the Context note in the
// plan), so a stale link isn't silently "fixed"; the SE is asked instead.
function checkHangProfileVersions() {
  if (!STATE || !STATE.sections) return;
  const mismatches = STATE.sections.filter(section => {
    if (!section.hang_profile_id) return false;
    const profile = HANG_PROFILES.find(p => p.id === section.hang_profile_id);
    return profile && profile.version !== section.hang_profile_version;
  });
  showNextHangProfileMismatch(mismatches);
}

// One banner at a time rather than a batch dialog -- keeps each decision
// tied to its own hang's name instead of a confusing multi-item list.
function showNextHangProfileMismatch(queue) {
  if (!queue.length) return;
  const section = queue[0];
  const rest = queue.slice(1);
  const profile = HANG_PROFILES.find(p => p.id === section.hang_profile_id);
  // Profile got deleted between the filter pass above and now (shouldn't
  // normally happen within one page load, but cheap to guard) -- nothing
  // sensible to prompt about, skip straight to the next one.
  if (!profile) { showNextHangProfileMismatch(rest); return; }

  const banner = document.createElement('div');
  banner.className = 'hang-profile-mismatch-banner';
  const text = document.createElement('span');
  text.textContent = `"${profile.name}" has changed since "${section.header}" last used it.`;
  banner.appendChild(text);

  const keepBtn = document.createElement('button');
  keepBtn.type = 'button';
  keepBtn.textContent = 'Keep linked (update)';
  keepBtn.addEventListener('click', () => {
    applyHangProfileToSection(section, profile);
    banner.remove();
    render();
    saveState(false);
    showNextHangProfileMismatch(rest);
  });
  banner.appendChild(keepBtn);

  const independentBtn = document.createElement('button');
  independentBtn.type = 'button';
  independentBtn.textContent = 'Go independent';
  independentBtn.title = 'Keep every current setting on this hang, just stop tracking the profile';
  independentBtn.addEventListener('click', () => {
    section.hang_profile_id = null;
    section.hang_profile_version = null;
    banner.remove();
    render();
    saveState(false);
    showNextHangProfileMismatch(rest);
  });
  banner.appendChild(independentBtn);

  document.body.appendChild(banner);
}

// Every physical Hi-D breakout cable normally gets the next color in the
// palette in strict sequence (bundle 1 -> cable 1/brown, bundle 2 -> cable
// 2/red, ...), but a hang whose box count changed (top boxes skipped, a
// bundle re-patched to a different amp port) may not actually start on
// cable 1 anymore -- `overrides` (a bundle's first circuit # -> forced
// 1-based cable #) lets a specific bundle be pinned to the cable it's
// really plugged into. Every later un-overridden bundle then keeps
// counting up FROM that override, not from 1, so overriding just the
// first bundle is enough to shift a whole truncated hang's coloring.
function assignCircuitSetColors(cabinets, palette, cycleLength, overrides) {
  const assignment = {};
  if (!palette || !palette.length) return assignment;
  const ov = overrides || {};
  let current = 0;
  // Group by the ORIGINAL (pre-Hi-D) circuit number, not the currently
  // displayed cab.ckt -- once Hi-D numbering is applied, every breakout
  // cable's legs get relabeled back to the same few strings (e.g. every
  // breakout shows "4,3,2,1"), so grouping by the displayed label would
  // collapse every breakout on the whole hang into one indistinguishable
  // group (all 4s together, all 3s together, etc. across every cable) --
  // exactly the "solid brown all the way down" bug this replaced.
  // cab._normalCkt is the stable, never-repeating original circuit number,
  // so it's the right identity to window into breakout-sized groups
  // regardless of which numbering mode is currently displayed.
  hidBundleOrder(cabinets, cycleLength).forEach(bundle => {
    const bundleKey = bundle[0];
    const override = ov[bundleKey];
    current = (override !== undefined && override !== null && override !== '' && Number(override) > 0)
      ? Number(override)
      : current + 1;
    const fill = palette[(current - 1) % palette.length];
    const patternIndex = (current - 1) % INK_PATTERN_COUNT;
    bundle.forEach(ckt => { assignment[ckt] = { fill, patternIndex, cableNumber: current }; });
  });
  return assignment;
}

// Which distinct circuit # values start a new Hi-D bundle -- used to place
// the "Cable #" override control on only the first box row of each bundle,
// not every row in it.
function getHidBundleStartKeys(cabinets, cycleLength) {
  return new Set(hidBundleOrder(cabinets, cycleLength).map(bundle => bundle[0]));
}

// "Start on Breakout #" (Hang Define popover) is just a friendlier way to
// set/read the SAME hid_cable_overrides entry the per-bundle stripe-click
// override (above) writes -- specifically, the hang's first bundle.
function getStartBreakout(section) {
  const bundleSize = (STATE.circuit_color_config && STATE.circuit_color_config.hid_bundle_size) || 4;
  const bundles = hidBundleOrder(section.cabinets || [], bundleSize);
  if (!bundles.length) return 1;
  return (section.hid_cable_overrides || {})[bundles[0][0]] || 1;
}

function setStartBreakout(section, n) {
  const bundleSize = (STATE.circuit_color_config && STATE.circuit_color_config.hid_bundle_size) || 4;
  const bundles = hidBundleOrder(section.cabinets || [], bundleSize);
  section.hid_cable_overrides = (n > 1 && bundles.length) ? { [bundles[0][0]]: n } : {};
}

// A dropdown of "Cable N" options, each with a swatch of that cable's
// actual palette color, anchored to the stripe that was clicked -- lets
// the SE pick the cable they're really plugged into by its color, rather
// than typing a bare number and having to remember number-to-color
// mapping themselves. Offers two full cycles of the palette (or the
// current value plus a few, whichever is larger) -- generous for any
// realistically-sized rig without an unreasonably long list.
function openHidCableDropdown(anchor, section, bundleKey, currentNumber, palette) {
  const existing = anchor.querySelector('.hid-cable-dropdown');
  if (existing) { existing.remove(); return; }
  const pal = palette && palette.length ? palette : ['FFCCCCCC'];
  const dropdown = document.createElement('div');
  dropdown.className = 'hid-cable-dropdown';
  const optionCount = Math.max(pal.length * 2, currentNumber + 4);
  for (let n = 1; n <= optionCount; n++) {
    const opt = document.createElement('div');
    opt.className = 'hid-cable-dropdown-option' + (n === currentNumber ? ' selected' : '');
    const swatch = document.createElement('span');
    swatch.className = 'hid-cable-dropdown-swatch';
    swatch.style.backgroundColor = argbToCss(pal[(n - 1) % pal.length]) || '#ccc';
    opt.appendChild(swatch);
    opt.appendChild(document.createTextNode('Cable ' + n));
    opt.addEventListener('click', e => {
      e.stopPropagation();
      section.hid_cable_overrides = section.hid_cable_overrides || {};
      if (n > 0) section.hid_cable_overrides[bundleKey] = n;
      else delete section.hid_cable_overrides[bundleKey];
      render();
      saveState(false);
    });
    dropdown.appendChild(opt);
  }
  anchor.appendChild(dropdown);
}

// Opens/closes this hang's Hang Define popover -- see openHangDefineSection
// above for why the open/closed state has to live at module scope rather
// than a local closure.
function makeHangDefineTrigger(section) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hang-define-trigger-btn' + (openHangDefineSection === section ? ' hang-define-active' : '');
  btn.textContent = '⚙️';
  btn.title = 'Define this hang -- Hi-D start, tape burn, manual circuiting, color, name, data tags, and profiles';
  btn.setAttribute('aria-label', 'Define this hang');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openHangDefineSection = openHangDefineSection === section ? null : section;
    render();
  });
  return btn;
}

// PATCHes a linked profile with this hang's CURRENT settings -- the
// trigger for the version-mismatch prompt everywhere else that profile is
// still linked at the old version (see checkHangProfileVersions).
async function updateLinkedProfile(section, profile) {
  if (!confirm(`Update profile "${profile.name}" with this hang's current settings? Every other hang linked to it will be asked to update the next time its page loads.`)) return;
  const body = {
    start_breakout: getStartBreakout(section),
    hid_reverse_order: section.hid_reverse_order !== false,
    tape_burn_ft: resolveTapeBurnFt(section),
    apply_manual_circuiting: !!section.apply_manual_circuiting,
    manual_circuit_pattern: section.manual_circuit_pattern || [],
    hang_color: section.hang_color || null,
    rename_to: section.header,
    hidden_tags: allTagsWithLabels().map(t => t.key).filter(key => isTagHidden(key, section)),
  };
  const res = await fetch('/api/hang-profiles/' + encodeURIComponent(profile.id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { flashStatus('Could not update profile'); return; }
  const updated = await res.json();
  const idx = HANG_PROFILES.findIndex(p => p.id === updated.id);
  if (idx !== -1) HANG_PROFILES[idx] = updated;
  section.hang_profile_version = updated.version; // this hang already matches what it just pushed
  render();
  saveState(false);
  flashStatus('Profile updated');
}

// Inline "Save as new profile..." form -- same expand-in-place pattern as
// show.js's renderNewProfileForm for Platform Profiles.
function renderSaveHangProfileForm(pane, addBtn, section) {
  addBtn.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'hang-define-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Profile name (e.g. 16 Sub - Start Brown)';
  row.appendChild(input);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    const body = {
      name,
      start_breakout: getStartBreakout(section),
      hid_reverse_order: section.hid_reverse_order !== false,
      tape_burn_ft: resolveTapeBurnFt(section),
      apply_manual_circuiting: !!section.apply_manual_circuiting,
      manual_circuit_pattern: section.manual_circuit_pattern || [],
      hang_color: section.hang_color || null,
      rename_to: section.header,
      hidden_tags: allTagsWithLabels().map(t => t.key).filter(key => isTagHidden(key, section)),
    };
    const res = await fetch('/api/hang-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { flashStatus('Could not save profile'); return; }
    const profile = await res.json();
    HANG_PROFILES.push(profile);
    section.hang_profile_id = profile.id;
    section.hang_profile_version = profile.version;
    render();
    saveState(false);
  });
  row.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { row.remove(); addBtn.style.display = ''; });
  row.appendChild(cancelBtn);
  pane.insertBefore(row, addBtn);
  input.focus();
}

// The Hang Define popover itself -- every per-hang setting in one place
// (Start on Breakout/Hi-D Reverse Order feed hid_cable_overrides/
// hid_reverse_order, Tape Burn feeds tape_burn_ft, Manual Circuiting feeds
// apply_manual_circuiting/manual_circuit_pattern, Hang Color feeds
// hang_color, Hang name reuses renameHang, Data Tags reuses
// setCardTagOverride), plus the profile link/apply/save/update controls.
function renderHangDefinePopover(section) {
  const pop = document.createElement('div');
  pop.className = 'hang-define-popover';

  const linkedProfile = section.hang_profile_id ? HANG_PROFILES.find(p => p.id === section.hang_profile_id) : null;
  if (section.hang_profile_id) {
    const linkRow = document.createElement('div');
    linkRow.className = 'hang-define-row hang-define-section-label';
    linkRow.textContent = linkedProfile ? `Linked to "${linkedProfile.name}"` : 'Linked to a profile that no longer exists';
    pop.appendChild(linkRow);
    const linkActionsRow = document.createElement('div');
    linkActionsRow.className = 'hang-define-row';
    if (linkedProfile) {
      const updateBtn = document.createElement('button');
      updateBtn.type = 'button';
      updateBtn.textContent = 'Update linked profile';
      updateBtn.addEventListener('click', () => updateLinkedProfile(section, linkedProfile));
      linkActionsRow.appendChild(updateBtn);
    }
    const unlinkBtn = document.createElement('button');
    unlinkBtn.type = 'button';
    unlinkBtn.textContent = 'Unlink';
    unlinkBtn.title = 'Keep every current setting, just stop tracking this profile';
    unlinkBtn.addEventListener('click', () => {
      section.hang_profile_id = null;
      section.hang_profile_version = null;
      render();
      saveState(false);
    });
    linkActionsRow.appendChild(unlinkBtn);
    pop.appendChild(linkActionsRow);
  }

  const applyRow = document.createElement('div');
  applyRow.className = 'hang-define-row';
  const select = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = HANG_PROFILES.length ? 'Apply a profile...' : 'No profiles saved yet';
  select.appendChild(noneOpt);
  HANG_PROFILES.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
  applyRow.appendChild(select);
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', () => {
    const profile = HANG_PROFILES.find(p => p.id === select.value);
    if (!profile) return;
    applyHangProfileToSection(section, profile);
    render();
    saveState(false);
  });
  applyRow.appendChild(applyBtn);
  pop.appendChild(applyRow);

  const saveNewBtn = document.createElement('button');
  saveNewBtn.type = 'button';
  saveNewBtn.className = 'hang-define-row';
  saveNewBtn.textContent = 'Save as new profile…';
  saveNewBtn.addEventListener('click', () => renderSaveHangProfileForm(pop, saveNewBtn, section));
  pop.appendChild(saveNewBtn);

  pop.appendChild(document.createElement('hr'));

  const breakoutRow = document.createElement('div');
  breakoutRow.className = 'hang-define-row';
  const breakoutLabel = document.createElement('label');
  breakoutLabel.textContent = 'Start on Breakout #';
  breakoutRow.appendChild(breakoutLabel);
  const breakoutInput = document.createElement('input');
  breakoutInput.type = 'number';
  breakoutInput.min = 1;
  breakoutInput.value = getStartBreakout(section);
  breakoutInput.addEventListener('change', e => {
    setStartBreakout(section, parseInt(e.target.value, 10) || 1);
    render();
    saveState(false);
  });
  breakoutRow.appendChild(breakoutInput);
  pop.appendChild(breakoutRow);

  const reverseRow = document.createElement('label');
  reverseRow.className = 'hang-define-row';
  const reverseCb = document.createElement('input');
  reverseCb.type = 'checkbox';
  reverseCb.checked = section.hid_reverse_order !== false;
  reverseCb.addEventListener('change', e => {
    section.hid_reverse_order = e.target.checked;
    // Re-derive this hang's Hi-D leg numbers immediately -- otherwise the
    // flag just sits there with no visible effect until/unless the
    // separate "Convert to Hi-D numbering" button (Numbering panel) gets
    // clicked, which only actually does anything on the very first
    // normal-to-Hi-D transition, not on a hang that's already converted.
    applyHiDNumbering([section], (STATE.circuit_color_config && STATE.circuit_color_config.hid_bundle_size) || 4);
    render();
    saveState(false);
  });
  reverseRow.appendChild(reverseCb);
  reverseRow.appendChild(document.createTextNode(' Hi-D Reverse Order (4,3,2,1)'));
  pop.appendChild(reverseRow);

  const burnRow = document.createElement('div');
  burnRow.className = 'hang-define-row';
  const burnLabel = document.createElement('label');
  burnLabel.textContent = 'Tape Burn (ft)';
  burnRow.appendChild(burnLabel);
  const burnInput = document.createElement('input');
  burnInput.type = 'number';
  burnInput.step = '0.1';
  burnInput.value = resolveTapeBurnFt(section);
  burnInput.addEventListener('change', e => {
    const n = parseFloat(e.target.value);
    section.tape_burn_ft = Number.isFinite(n) ? n : null;
    render();
    saveState(false);
  });
  burnRow.appendChild(burnInput);
  pop.appendChild(burnRow);

  const manualRow = document.createElement('label');
  manualRow.className = 'hang-define-row';
  const manualCb = document.createElement('input');
  manualCb.type = 'checkbox';
  manualCb.checked = !!section.apply_manual_circuiting;
  manualCb.addEventListener('change', e => {
    section.apply_manual_circuiting = e.target.checked;
    if (e.target.checked) applyManualCircuitPattern(section);
    render();
    saveState(false);
  });
  manualRow.appendChild(manualCb);
  manualRow.appendChild(document.createTextNode(' Apply Manual Circuiting'));
  pop.appendChild(manualRow);

  if (section.apply_manual_circuiting) {
    const patternRow = document.createElement('div');
    patternRow.className = 'hang-define-row';
    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.placeholder = 'e.g. 1,2,1';
    patternInput.value = (section.manual_circuit_pattern || []).join(',');
    patternInput.addEventListener('change', e => {
      section.manual_circuit_pattern = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
      applyManualCircuitPattern(section);
      render();
      saveState(false);
    });
    patternRow.appendChild(patternInput);
    pop.appendChild(patternRow);
  }

  const colorRow = document.createElement('div');
  colorRow.className = 'hang-define-row';
  const colorLabel = document.createElement('label');
  colorLabel.textContent = 'Hang Color';
  colorRow.appendChild(colorLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = argbToCss(section.hang_color) || '#ffffff';
  colorInput.addEventListener('change', e => {
    section.hang_color = cssToArgb(e.target.value);
    render();
    saveState(false);
  });
  colorRow.appendChild(colorInput);
  const clearColorBtn = document.createElement('button');
  clearColorBtn.type = 'button';
  clearColorBtn.textContent = 'Clear';
  clearColorBtn.addEventListener('click', () => {
    section.hang_color = null;
    render();
    saveState(false);
  });
  colorRow.appendChild(clearColorBtn);
  pop.appendChild(colorRow);

  const nameRow = document.createElement('div');
  nameRow.className = 'hang-define-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Hang name';
  nameRow.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = section.header;
  nameInput.addEventListener('change', e => {
    const idx = STATE.sections.indexOf(section);
    if (idx !== -1) renameHang(idx, e.target.value);
  });
  nameRow.appendChild(nameInput);
  pop.appendChild(nameRow);

  const tagsHeader = document.createElement('div');
  tagsHeader.className = 'hang-define-row hang-define-section-label';
  tagsHeader.textContent = 'Data Tags';
  pop.appendChild(tagsHeader);
  allTagsWithLabels().forEach(({label, key}) => {
    const row = document.createElement('label');
    row.className = 'hang-define-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isTagHidden(key, section);
    cb.addEventListener('change', e => setCardTagOverride(section, key, !e.target.checked));
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + label));
    pop.appendChild(row);
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => { openHangDefineSection = null; render(); });
  pop.appendChild(closeBtn);

  return pop;
}

// Some brands' breakout hardware bundles several independent circuits
// into one trunk cable, then splits them back out with a breakout cable
// that numbers its own legs independently of anything else on the rig --
// every physical Hi-D breakout cable has its 4 legs labeled 4,3,2,1 (top
// to bottom), and that labeling STARTS OVER on every new breakout cable.
// So circuits 1-4 in the original sheet become 4,3,2,1 on the first
// breakout, but circuits 5-8 *also* become 4,3,2,1 on the second breakout
// -- NOT 8,7,6,5 -- because it's a brand-new physical cable with its own
// legs 1-4, not a continuation of a running count across the whole hang.
// cab._normalCkt remembers each cabinet's pre-conversion circuit number
// (captured once, the first time a section is converted) so "back to
// Normal" can restore the original numbers exactly, since the Hi-D labels
// themselves don't carry enough information to reconstruct them.
// Legs count DOWN (4,3,2,1) by default -- some hangs (via a linked Hang
// Profile, see applyHangProfileToSection) instead want them counting UP
// (1,2,3,4), toggled per-section by section.hid_reverse_order === false.
function applyHiDNumbering(sections, bundleSize) {
  const bs = Math.max(1, bundleSize || 4);
  (sections || []).forEach(section => {
    const cabinets = section.cabinets || [];
    cabinets.forEach(c => { if (c._normalCkt === undefined) c._normalCkt = c.ckt; });
    const reverse = section.hid_reverse_order !== false;

    const distinctOrder = [];
    const seen = new Set();
    cabinets.forEach(c => {
      const orig = c._normalCkt;
      if (orig && !seen.has(orig)) { seen.add(orig); distinctOrder.push(orig); }
    });

    const mapping = {};
    distinctOrder.forEach((label, idx) => {
      const posInBundle = idx % bs;
      mapping[label] = String(reverse ? bs - posInBundle : posInBundle + 1);
    });

    cabinets.forEach(c => {
      if (c._normalCkt && mapping[c._normalCkt] !== undefined) c.ckt = mapping[c._normalCkt];
    });
  });
}

function restoreNormalNumbering(sections) {
  (sections || []).forEach(section => {
    (section.cabinets || []).forEach(c => {
      if (c._normalCkt !== undefined) c.ckt = c._normalCkt;
    });
  });
}

function makeChip(text) {
  const chip = document.createElement('div');
  chip.className = 'value-chip';
  chip.textContent = text;
  return chip;
}

// Colors are stored/exchanged with the Python side as openpyxl-style ARGB
// hex (8 chars, alpha + RGB, no leading '#' -- e.g. "FFFF0000") since
// that's the exact string PatternFill/Font expect. CSS wants "#rrggbb".
function argbToCss(argb) {
  if (!argb) return null;
  const h = argb.replace('#', '');
  const rgb = h.length >= 6 ? h.slice(-6) : h.padStart(6, '0');
  return '#' + rgb;
}

function cssToArgb(css) {
  return 'FF' + css.replace('#', '').toUpperCase();
}

function hangStripeColor(header, hangColors) {
  const lower = (header || '').toLowerCase();
  const list = hangColors || [];
  for (let i = 0; i < list.length; i++) {
    const match = (list[i].match || '').toLowerCase();
    if (match && lower.includes(match)) return { fill: list[i].fill, patternIndex: i % INK_PATTERN_COUNT };
  }
  return null;
}

function render() {
  // grid.innerHTML = '' below briefly empties out most of the page's
  // content -- if that happens while scrolled down (routine once a card
  // has anything as tall as the Hang Define popover open), the browser
  // clamps the page's scroll position to fit the momentarily-shorter
  // document, and re-populating the grid right after doesn't restore it.
  // Every single edit anywhere in a card re-renders the whole grid this
  // way, so without this the page would jump to the top on every
  // keystroke/click. Saved before any DOM changes, restored once the grid
  // is fully rebuilt (end of this function).
  const scrollX = window.scrollX, scrollY = window.scrollY;
  // Belt-and-suspenders alongside PRINT_IN_PROGRESS (see its own comment
  // for the individual listeners that check it) -- this is the backstop
  // for any render()-triggering path that flag *hasn't* been threaded
  // through, known or not yet discovered. A PDF export sets its own
  // "print-mode-*" class on body for its entire duration (see runPrint),
  // so as long as that's present, render() has no business touching the
  // grid at all -- whatever called it, it would be overwriting the
  // export's own column count/content with the on-screen version,
  // corrupting the very layout the browser is mid-paginating.
  if (isPrintMode()) return;
  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('emptyState');

  if (!STATE) {
    grid.style.display = 'none';
    emptyState.style.display = 'block';
    document.getElementById('colorPanel').innerHTML = '';
    document.getElementById('numberingPanel').innerHTML = '';
    document.getElementById('dataTagsPanel').innerHTML = '';
    document.getElementById('dataBarPanel').innerHTML = '';
    document.getElementById('hangsPanel').innerHTML = '';
    applyViewOnlyLock();
    return;
  }
  document.getElementById('cardsPerRow').value = STATE.cards_per_row;
  document.getElementById('stripPairLabelsInput').checked = !!STATE.strip_pair_labels;
  // Cards-per-row only means anything when every hang is laid out at
  // once -- a single hang tab has no use for it, but the All tab (see
  // renderHangTabs) lays every hang out together, so it needs the field
  // back.
  document.getElementById('cardsPerRowField').style.display = activeHangIndex !== 'all' ? 'none' : '';
  // See the "Data Bar mode" CSS rules -- a "databar-*" class here forces
  // Side/Bottom/Hidden regardless of card width; no class at all leaves
  // the automatic width-driven CSS in charge, same as before this setting
  // existed.
  DATA_BAR_MODES.forEach(m => grid.classList.remove('databar-' + m));
  const dataBarMode = resolveDataBarMode();
  if (dataBarMode) grid.classList.add('databar-' + dataBarMode);
  const pageHeader = STATE.page_header || {};
  document.getElementById('showTitleInput').value = pageHeader.title || '';
  document.getElementById('showVenueInput').value = pageHeader.venue || '';
  document.getElementById('showDateInput').value = pageHeader.date || '';

  // Only ever visible in @media print -- see .print-header in style.css.
  const printHeader = document.getElementById('printHeader');
  printHeader.innerHTML = '';
  if (pageHeader.title) {
    const t = document.createElement('div');
    t.className = 'ph-title';
    t.textContent = pageHeader.title;
    printHeader.appendChild(t);
  }
  // "Venue - Date" -- a dash, not the bullet voMeta below uses, per the
  // requested PDF header format.
  const printMetaBits = [pageHeader.venue, pageHeader.date].filter(Boolean).join(' - ');
  if (printMetaBits) {
    const m = document.createElement('div');
    m.className = 'ph-meta';
    m.textContent = printMetaBits;
    printHeader.appendChild(m);
  }

  // Only ever visible for view-only + mobile (see body.view-only rules in
  // style.css) -- same title/venue/date as printHeader above, just shown
  // on screen instead of only when printing. Keeps its own bullet
  // separator (unlike the print header's dash above) -- unrelated to the
  // PDF format, this is the compact on-screen display for a different
  // context, and changing its separator wasn't asked for.
  const voMetaBits = [pageHeader.venue, pageHeader.date].filter(Boolean).join(' • ');
  document.getElementById('voTitle').textContent = pageHeader.title || '';
  document.getElementById('voMeta').textContent = voMetaBits;

  // A brand new Date (created but nothing uploaded to it yet) has a job
  // with sections: [] -- same empty-state prompt as no job at all, rather
  // than an empty grid with no cards and no explanation.
  const hasSections = STATE.sections && STATE.sections.length > 0;
  grid.style.display = hasSections ? 'grid' : 'none';
  emptyState.style.display = hasSections ? 'none' : 'block';
  grid.innerHTML = '';

  const hangTabs = document.getElementById('hangTabs');
  if (hasSections) {
    if (activeHangIndex !== 'all') {
      if (activeHangIndex >= STATE.sections.length) activeHangIndex = STATE.sections.length - 1;
      if (activeHangIndex < 0) activeHangIndex = 0;
    }
    renderHangTabs(STATE.sections);
    hangTabs.style.display = 'flex';
  } else {
    hangTabs.style.display = 'none';
    hangTabs.innerHTML = '';
  }

  if (hasSections) {
    const showingOneHang = activeHangIndex !== 'all';
    // A single hang always shows full-width -- the cards-per-row
    // breakpoints only matter when every hang shares the grid at once
    // (the All tab).
    const columns = showingOneHang ? 1 : (DESKTOP_MQL.matches && MULTI_CARD_MQL.matches ? computeGridColumns(STATE.cards_per_row) : 1);
    grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    const sectionsToRender = showingOneHang ? [STATE.sections[activeHangIndex]] : STATE.sections;
    populateGrid(grid, sectionsToRender);
  }
  renderColorPanel();
  renderNumberingPanel();
  renderDataTagsPanel();
  renderDataBarPanel();
  renderHangsPanel();
  applyViewOnlyLock();
  window.scrollTo(scrollX, scrollY);
}

function populateGrid(grid, sections) {
  const cfg = STATE.circuit_color_config || {};
  const cycleLen = Math.max(1, Math.min(cfg.cycle_length || 4, (cfg.circuit_colors || []).length || 1));
  const activePalette = (cfg.circuit_colors || []).slice(0, cycleLen);
  sections.forEach(section => grid.appendChild(renderCard(section, cfg, activePalette, cycleLen)));
  fixupMetaChipLayout();
}

// Tabs view: one button per hang instead of scrolling through the whole
// grid -- handy for a long pinning sheet on a small screen where even one
// card at a time is a lot of vertical scrolling to get past. The All tab
// (first, pinned) switches to showing every hang at once without leaving
// Tabs view -- same content Grid view shows, just reachable from here too.
function renderHangTabs(sections) {
  const hangTabs = document.getElementById('hangTabs');
  hangTabs.innerHTML = '';
  const allTab = document.createElement('button');
  allTab.type = 'button';
  allTab.className = 'hang-tab hang-tab-all' + (activeHangIndex === 'all' ? ' active' : '');
  allTab.textContent = 'All';
  allTab.addEventListener('click', () => { activeHangIndex = 'all'; render(); });
  hangTabs.appendChild(allTab);
  sections.forEach((section, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'hang-tab' + (i === activeHangIndex ? ' active' : '');
    const fullTitle = formatHangTitle(section.header) || `Hang ${i + 1}`;
    tab.textContent = abbreviateHangTitle(section.header) || fullTitle;
    tab.title = fullTitle;
    tab.addEventListener('click', () => { activeHangIndex = i; render(); });
    hangTabs.appendChild(tab);
  });
}

// Model + Dispersion are shown as one combined "Model (Disp)" column --
// e.g. "CO12 (80)" -- rather than two separate columns, and the leading
// letter on dispersion (the "H" in "H80") is dropped since it's implied by
// context. Falls back to showing dispersion verbatim if it isn't in the
// usual "<letter><number>" shape (e.g. "II+" on a subwoofer).
function formatModelDispersion(cab) {
  const model = cab.model || '';
  const disp = cab.dispersion || '';
  if (!disp) return model;
  const m = disp.match(/^[A-Za-z]+(\d.*)$/);
  const shown = m ? m[1] : disp;
  return `${model} (${shown})`;
}

// Lots of sim software bakes a trailing "(Pair)" marker right into a
// symmetric hang's own title -- redundant once the SE already knows their
// rig is symmetric. STATE.strip_pair_labels (toggled from the sidebar,
// see the stripPairLabels checkbox handler near the bottom of this file)
// strips it for display; the same regex is applied server-side to the
// Excel export too (see app.py's strip_pair_label), so on vs off looks
// consistent between what's on screen and what gets exported.
const PAIR_SUFFIX_RE = /\s*\(\s*pair\s*\)\s*$/i;
function formatHangTitle(header) {
  if (!STATE.strip_pair_labels) return header || '';
  return (header || '').replace(PAIR_SUFFIX_RE, '');
}

// Tab labels are abbreviated so each tab stays as wide as possible before
// CSS has to shrink/truncate it to keep the whole row on one line (see
// .hang-tabs/.hang-tab in style.css). Strips the "- Model(Disp)" suffix
// most naming conventions add after the hang's own name/number (e.g.
// "1. MAIN - CO12" -> "1. MAIN"), then drops a leading "N. " ordinal too
// (-> "MAIN") -- the name is what actually tells two hangs apart at a
// glance, so it's the number that should give up space first once a tab
// gets squeezed, not the other way around. The full (numbered) name is
// still what shows on the card itself, and in this tab's own title
// attribute (a hover tooltip). Falls back to the full (pair-stripped)
// title if there's no " - " to split on, rather than guessing further at
// an abbreviation.
function abbreviateHangTitle(header) {
  const full = formatHangTitle(header);
  const dashIndex = full.indexOf(' - ');
  const withoutSuffix = dashIndex === -1 ? full : full.slice(0, dashIndex);
  return withoutSuffix.replace(/^\d+\.\s*/, '');
}

function renderCard(section, cfg, activePalette, cycleLen) {
  const card = document.createElement('div');
  card.className = 'card';

  // Always reserve this gutter's width, whether or not this section's
  // header actually matches a hang-color rule -- otherwise a card with no
  // match gets its whole card-content area wider than one that does,
  // throwing off column alignment across the grid. A direct per-hang
  // color (section.hang_color, set via a linked Hang Profile) always wins
  // over the show-wide name-matched hang_colors list.
  const stripe = section.hang_color ? { fill: section.hang_color, patternIndex: 0 } : hangStripeColor(section.header, cfg.hang_colors);
  const bar = document.createElement('div');
  bar.className = 'hang-stripe-bar';
  if (stripe) {
    bar.style.backgroundColor = argbToCss(stripe.fill);
    if (cfg.ink_friendly_patterns) bar.classList.add('ink-pattern-' + stripe.patternIndex);
  }
  card.appendChild(bar);

  const content = document.createElement('div');
  content.className = 'card-content';
  card.appendChild(content);

  const title = document.createElement('div');
  title.className = 'card-title';
  const titleText = document.createElement('span');
  titleText.className = 'card-title-text';
  titleText.textContent = formatHangTitle(section.header);
  title.appendChild(titleText);
  // Only ever visible when the card is narrow enough that Data Tags
  // (Aim/Trim/Angle/etc.) get hidden to leave room for Cab/Model/Splay/
  // CKT -- see the "pin-card" @container rules in style.css. Toggles an
  // accordion-style reveal (the meta-col just reappears in its usual
  // spot) rather than opening a separate popup, so it stays anchored to
  // the card it belongs to.
  const metaToggleBtn = document.createElement('button');
  metaToggleBtn.type = 'button';
  metaToggleBtn.className = 'meta-toggle-btn';
  metaToggleBtn.textContent = 'Info';
  metaToggleBtn.setAttribute('aria-label', 'Show hang info');
  metaToggleBtn.addEventListener('click', () => card.classList.toggle('meta-expanded'));
  title.appendChild(metaToggleBtn);
  title.appendChild(makeHangDefineTrigger(section));
  content.appendChild(title);
  // Expands in place (normal document flow, pushing the box list down)
  // rather than floating over the card -- same convention as the
  // meta-expanded accordion reveal above, and avoids fighting .card's own
  // overflow:hidden (used to clip the rounded corners/hang stripe) that a
  // floating popover would need to escape.
  if (openHangDefineSection === section) content.appendChild(renderHangDefinePopover(section));

  const body = document.createElement('div');
  body.className = 'card-body';

  const boxList = document.createElement('div');
  boxList.className = 'box-list';

  // 'dispersion' is folded into the 'model' column's own display (see
  // formatModelDispersion) rather than getting a separate column.
  const fields = (STATE.fields_enabled || []).filter(f => f !== 'dispersion');

  const headerRow = document.createElement('div');
  headerRow.className = 'box-row box-header';
  fields.forEach(f => {
    const cell = document.createElement('div');
    cell.className = 'box-cell field-' + f;
    cell.textContent = FIELD_LABELS[f] || f;
    headerRow.appendChild(cell);
  });
  boxList.appendChild(headerRow);

  const circuitFillMap = cfg.enabled ? assignCircuitColors(section.cabinets, activePalette) : {};
  // Uses the SAME "circuits per breakout cable" number as the numbering
  // conversion (cfg.hid_bundle_size), not the unrelated circuit-color
  // cycle length -- they're two independent settings that happen to share
  // a panel now, but the stripe's grouping should match the actual
  // breakout cable size the user configured, not how many paint colors
  // are in the row-fill palette.
  const circuitSetFillMap = cfg.circuit_set_enabled
    ? assignCircuitSetColors(section.cabinets, cfg.circuit_set_colors, cfg.hid_bundle_size || 4, section.hid_cable_overrides)
    : {};
  const hidBundleStartKeys = cfg.circuit_set_enabled
    ? getHidBundleStartKeys(section.cabinets, cfg.hid_bundle_size || 4)
    : new Set();
  const renderedBundleStarts = new Set();

  section.cabinets.forEach((cab, i) => {
    const row = document.createElement('div');
    row.className = 'box-row';
    const fillEntry = circuitFillMap[cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt];
    if (fillEntry && cfg.show_row_fill !== false) {
      if (cfg.ink_friendly_patterns) {
        // A dedicated swatch instead of painting the whole row -- most of
        // the row's own background sits behind each cell's own white chip
        // (see the .box-cell comment further down) anyway, so a pattern
        // there would mostly be invisible; this puts it somewhere it's
        // actually going to be seen, whether on screen or on paper.
        const swatch = document.createElement('div');
        swatch.className = 'row-color-swatch ink-pattern-' + fillEntry.patternIndex;
        swatch.style.backgroundColor = argbToCss(fillEntry.fill);
        row.appendChild(swatch);
      } else {
        row.style.backgroundColor = argbToCss(fillEntry.fill);
      }
    }
    fields.forEach(f => {
      const cell = document.createElement('div');
      cell.className = 'box-cell field-' + f;
      if (f === 'circuit') {
        // The CKT input is centered on the column via the cell's own
        // text-align:center (same as any other centered content here) --
        // it no longer shares a flex row with the stripe, so its position
        // never shifts whether or not a stripe is showing.
        // The stripe and link icon are anchored to this wrap (sized to the
        // input itself, not the column) so they hug the actual CKT square
        // regardless of how much extra room the column has -- anchoring
        // them to the cell directly left a gap on any card whose column
        // ended up wider than the input.
        const wrap = document.createElement('div');
        wrap.className = 'ckt-wrap';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = cab.ckt || '';
        input.className = 'ckt-input';
        input.addEventListener('change', e => { cab.ckt = e.target.value; render(); });
        wrap.appendChild(input);
        const bundleKey = cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt;
        const setEntry = circuitSetFillMap[bundleKey];
        if (setEntry) {
          const setStripe = document.createElement('div');
          setStripe.className = 'circuit-set-stripe';
          if (cfg.ink_friendly_patterns) setStripe.classList.add('ink-pattern-' + setEntry.patternIndex);
          setStripe.style.backgroundColor = argbToCss(setEntry.fill);
          // Only the first box row of each bundle gets the override control
          // -- every other row in the same bundle shares the same stripe/
          // cable # already, so showing it again would just be noise.
          if (hidBundleStartKeys.has(bundleKey) && !renderedBundleStarts.has(bundleKey)) {
            renderedBundleStarts.add(bundleKey);
            setStripe.classList.add('circuit-set-stripe-editable');
            setStripe.title = `Hi-D cable #${setEntry.cableNumber} -- click to override which cable this bundle is on`;
            // Always-visible affordance -- a plain color bar gives no hint
            // it's clickable (a static screenshot can't show a cursor or a
            // hover-only tooltip), so this small caret sits on the stripe
            // itself, in every render, not just on hover.
            const editIcon = document.createElement('span');
            editIcon.className = 'circuit-set-edit-icon';
            editIcon.textContent = '▾';
            setStripe.appendChild(editIcon);
            setStripe.addEventListener('click', ev => {
              ev.stopPropagation();
              openHidCableDropdown(wrap, section, bundleKey, setEntry.cableNumber, cfg.circuit_set_colors);
            });
          }
          wrap.appendChild(setStripe);
        }
        // A link icon on the border shared with the box above, when the
        // two boxes carry the same circuit (multiple boxes wired to one
        // circuit) -- same "look at the row above" convention splay-value
        // uses (i > 0), just keyed on the circuit matching instead of
        // always showing.
        if (i > 0) {
          const prevCab = section.cabinets[i - 1];
          const curKey = cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt;
          const prevKey = prevCab._normalCkt !== undefined ? prevCab._normalCkt : prevCab.ckt;
          if (curKey && prevKey && curKey === prevKey) {
            const link = document.createElement('div');
            link.className = 'circuit-link-icon';
            link.title = 'Shares a circuit with the box above';
            link.innerHTML = LINK_ICON_SVG;
            wrap.appendChild(link);
          }
        }
        cell.appendChild(wrap);
      } else if (f === 'label') {
        cell.appendChild(makeChip(cab.position));
      } else if (f === 'model') {
        cell.appendChild(makeChip(formatModelDispersion(cab)));
      } else if (f === 'angle') {
        // Box 1 (topmost/reference) has no box above it, so it gets no
        // splay value at all -- same convention as the Excel output.
        if (i > 0 && cab.splay) {
          const val = document.createElement('div');
          val.className = 'splay-value';
          val.textContent = cab.splay;
          cell.appendChild(val);
        }
      } else if (f === 'nfc') {
        cell.appendChild(makeChip(cab.nfc || ''));
      } else {
        cell.appendChild(makeChip(cab[f] !== undefined ? cab[f] : ''));
      }
      row.appendChild(cell);
    });
    boxList.appendChild(row);
  });

  body.appendChild(boxList);

  const meta = document.createElement('div');
  meta.className = 'meta-col';
  // How many tags THIS card actually has data for but isn't showing,
  // whichever level (Show/Date/Card) is doing the hiding -- drives the
  // "Show all" button just below, which only ever touches this one card.
  const hiddenWithData = [];
  if (section.hanging_mode && isTagHidden('__mode', section)) hiddenWithData.push('__mode');
  (STATE.metadata_fields || []).forEach(({key}) => {
    const val = section.metadata ? section.metadata[key] : undefined;
    if (val !== undefined && val !== null && val !== '' && isTagHidden(key, section)) hiddenWithData.push(key);
  });
  // Only appears once something's actually hidden -- spans both grid
  // columns so it reads as a header bar over the tag chips, not another
  // chip competing with them for a column.
  if (hiddenWithData.length > 0) {
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'meta-show-all-btn';
    showAllBtn.textContent = `Show all (${hiddenWithData.length} hidden)`;
    showAllBtn.title = 'Show every hidden tag on this hang';
    showAllBtn.addEventListener('click', () => showAllTagsOnCard(section));
    meta.appendChild(showAllBtn);
  }
  // Compression/Tension/Hard Pin/Soft Pin used to get its own dedicated
  // spot under the card title -- now it's just the first metadata chip,
  // same visual treatment as everything else, ahead of Aim/Slider/etc.
  if (section.hanging_mode && !isTagHidden('__mode', section)) {
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('div');
    l.className = 'meta-label';
    l.textContent = 'Mode';
    const v = document.createElement('div');
    v.className = 'meta-value';
    v.textContent = section.hanging_mode;
    row.appendChild(l); row.appendChild(v);
    row.appendChild(makeTagHideBtn(section, '__mode', 'Mode'));
    meta.appendChild(row);
  }
  // A metadata field with no value is just an empty label chip floating in
  // the column -- skip it entirely instead of rendering "Aim:" with
  // nothing after it, so the column only ever shows fields this section
  // actually has data for.
  let sawTrimField = false;
  (STATE.metadata_fields || []).forEach(({label, key}) => {
    if (isTagHidden(key, section)) return;
    const val = section.metadata ? section.metadata[key] : undefined;
    if (val === undefined || val === null || val === '') return;
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('div');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'meta-value';
    // Matches "Trim", "Trim (T)", "Trim (B)", etc. -- whatever this
    // template's design.xlsx actually calls its trim row(s). Always shows
    // the computed True Trim; if this hang's burn footage is actually set,
    // the raw/"Burnt Trim" reading also shows alongside it in red/maroon,
    // so a burnt reading never gets mistaken for the real distance. On
    // screen the burn amount itself gets its own "Tape Burn" row below
    // (editable there); a printed page has no interactive controls, so
    // that row is dropped and its "+Nft" folds directly into this line
    // instead, to save vertical space on the page.
    const isTrim = label.toLowerCase().includes('trim');
    if (isTrim) {
      sawTrimField = true;
      const burnFt = resolveTapeBurnFt(section);
      const printing = isPrintMode();
      const trueSpan = document.createElement('span');
      trueSpan.textContent = trueTrimValue(val, burnFt) + ' ft';
      v.appendChild(trueSpan);
      if (burnFt) {
        v.appendChild(document.createTextNode(' | '));
        const burntSpan = document.createElement('span');
        burntSpan.className = 'trim-burnt-value';
        burntSpan.textContent = printing ? `${val}ft +${burnFt}ft` : `${val}ft \u{1F525}`;
        burntSpan.title = 'Burnt (raw) reading -- the True Trim above already has this hang\'s burn footage subtracted';
        v.appendChild(burntSpan);
      }
    } else {
      v.textContent = val;
    }
    row.appendChild(l); row.appendChild(v);
    row.appendChild(makeTagHideBtn(section, key, label));
    meta.appendChild(row);
  });
  if (sawTrimField && !isPrintMode()) meta.appendChild(makeTapeBurnRow(section));
  body.appendChild(meta);

  content.appendChild(body);
  return card;
}

// Decides, per row PAIR (matching the 2-column meta-col grid), whether
// both chips sit inline or both stack -- run after every card is in the
// live DOM, since it needs real layout (scrollWidth vs clientWidth) to
// measure whether a chip's content actually fits inline. See the
// .meta-row/.meta-row-stacked comment in style.css for why this is
// decided per pair rather than per chip.
function fixupMetaChipLayout() {
  document.querySelectorAll('.meta-col').forEach(metaCol => {
    // Excludes the "Show all" button (meta-show-all-btn), which sits
    // among the .meta-col's children too when present -- pairing would
    // otherwise be thrown off by one, misaligning every pair after it.
    const rows = [...metaCol.querySelectorAll('.meta-row')];
    // How many rows actually share a grid row right now -- 1 whenever
    // the Data Bar has room to give each tag its own full-width row
    // (stacked below the cabinet list), 2 when it's squeezed beside a
    // possibly-tall one instead (see the .meta-col rules in style.css).
    // Determines this from the real computed layout rather than
    // duplicating that same side/bottom logic here.
    const columnCount = getComputedStyle(metaCol).gridTemplateColumns.split(' ').length;
    for (let i = 0; i < rows.length; i += columnCount) {
      const pair = rows.slice(i, i + columnCount);
      pair.forEach(row => row.classList.remove('meta-row-stacked'));
      // Check the label/value elements themselves, not the row -- the
      // value wraps by default (see .meta-value in style.css, the
      // guaranteed no-truncation fallback), which means its scrollWidth
      // never actually exceeds its clientWidth even when the content
      // doesn't fit on one line -- it just wraps in place instead. So the
      // value is measured with wrapping forced off for a moment (its
      // natural single-line width vs. the space actually available),
      // which is the real question this decides: does it NEED to wrap, or
      // does it comfortably fit inline as-is.
      const overflowed = pair.some(row => {
        const label = row.querySelector('.meta-label');
        const value = row.querySelector('.meta-value');
        if (label && label.scrollWidth > label.clientWidth + 1) return true;
        if (!value) return false;
        value.style.whiteSpace = 'nowrap';
        const valueOverflowed = value.scrollWidth > value.clientWidth + 1;
        value.style.whiteSpace = '';
        return valueOverflowed;
      });
      if (overflowed) pair.forEach(row => row.classList.add('meta-row-stacked'));
    }
  });
}

// Editors get the shared Date-level override panel (this Date's own
// override for each tag, on top of the Show's standing default set from
// the Show page); a view-only visitor has no write access to any of that,
// so they get the old simple per-device panel instead -- see
// renderLocalDataTagsPanel below.
function renderDataTagsPanel() {
  const panel = document.getElementById('dataTagsPanel');
  panel.innerHTML = '';
  if (isReadOnly()) { renderLocalDataTagsPanel(panel); return; }
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Overrides the show-wide default for this date only. Set the show-wide default from the show page.';
  panel.appendChild(note);
  const overrides = STATE.hidden_tags_overrides || {};
  const showHidden = (SHOW_META && SHOW_META.hidden_tags) || [];
  allTagsWithLabels().forEach(({label, key}) => {
    const row = document.createElement('div');
    row.className = 'swatchRow tag-override-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'tag-override-label';
    labelEl.textContent = `${label} (default: ${showHidden.includes(key) ? 'hidden' : 'shown'})`;
    row.appendChild(labelEl);

    const toggle = document.createElement('div');
    toggle.className = 'view-mode-toggle tag-override-toggle';
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
    const current = hasOverride ? (overrides[key] ? 'hide' : 'show') : 'default';
    [['default', 'Default'], ['show', 'Show'], ['hide', 'Hide']].forEach(([mode, text]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'view-mode-btn' + (current === mode ? ' active' : '');
      btn.textContent = text;
      btn.addEventListener('click', () => setDateTagOverride(key, mode === 'default' ? null : mode === 'hide'));
      toggle.appendChild(btn);
    });
    row.appendChild(toggle);
    panel.appendChild(row);
  });
}

// Hides tags on just this device, without touching the shared job/show at
// all -- the only option available to a view-only visitor, who can't
// write to either. Purely additive on top of whatever the SE's shared
// hierarchy already shows/hides (see isTagHidden); can't reveal something
// the SE hid, only hide further.
function renderLocalDataTagsPanel(panel) {
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = "Hides tags just for you, on this device -- doesn't change what anyone else sees.";
  panel.appendChild(note);
  if (localHiddenTags.size > 0) {
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'btn btn-ghost show-all-tags-btn';
    showAllBtn.textContent = 'Show all';
    showAllBtn.addEventListener('click', clearLocalHiddenTags);
    panel.appendChild(showAllBtn);
  }
  allTagsWithLabels().forEach(({label, key}) => {
    const row = document.createElement('div');
    row.className = 'swatchRow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !localHiddenTags.has(key);
    cb.addEventListener('change', e => setLocalTagHidden(key, !e.target.checked));
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + label));
    panel.appendChild(row);
  });
}

// This Date's own Data Bar placement override, on top of the Show's
// standing default (set from the Show page -- see static/show.js) --
// "Automatic" clears the override, falling back to the Show default and
// then, if the Show has none either, the card-width-driven placement
// that's always existed.
function renderDataBarPanel() {
  const panel = document.getElementById('dataBarPanel');
  panel.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  const showMode = SHOW_META && SHOW_META.data_bar_mode;
  const showLabel = DATA_BAR_LABELS[showMode] || 'automatic (by card width)';
  note.textContent = `Overrides the show-wide default (currently ${showLabel}) for this date only. Set the show-wide default from the show page.`;
  panel.appendChild(note);

  const current = STATE && DATA_BAR_MODES.includes(STATE.data_bar_mode_override) ? STATE.data_bar_mode_override : null;
  [[null, 'Default'], ['side-left', 'Side (left)'], ['side-right', 'Side (right)'], ['bottom', 'Bottom'], ['hidden', 'Hidden']].forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'dataBarMode';
    radio.checked = current === value;
    radio.addEventListener('change', () => setDataBarModeOverride(value));
    row.appendChild(radio);
    row.appendChild(document.createTextNode(' ' + label));
    panel.appendChild(row);
  });
}

// Renaming/reordering both act on STATE.sections directly -- header text
// and array order are the ONE source every other view (card titles, hang
// tabs, hang-stripe color matching, exports) already reads from, so
// nothing else needs updating in step with this.
function renderHangsPanel() {
  const panel = document.getElementById('hangsPanel');
  panel.innerHTML = '';
  if (!STATE || !STATE.sections || !STATE.sections.length) return;
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'Rename or reorder hangs -- applies everywhere (cards, tabs, exports).';
  panel.appendChild(note);

  STATE.sections.forEach((section, i) => {
    const row = document.createElement('div');
    row.className = 'hangs-row';

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'hangs-move-btn';
    moveUpBtn.textContent = '↑';
    moveUpBtn.disabled = i === 0;
    moveUpBtn.setAttribute('aria-label', `Move "${section.header}" earlier`);
    moveUpBtn.addEventListener('click', () => moveHang(i, -1));

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'hangs-move-btn';
    moveDownBtn.textContent = '↓';
    moveDownBtn.disabled = i === STATE.sections.length - 1;
    moveDownBtn.setAttribute('aria-label', `Move "${section.header}" later`);
    moveDownBtn.addEventListener('click', () => moveHang(i, 1));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hangs-name-input';
    input.value = section.header;
    input.setAttribute('aria-label', `Rename hang ${i + 1}`);
    input.addEventListener('change', e => renameHang(i, e.target.value));

    row.appendChild(moveUpBtn);
    row.appendChild(moveDownBtn);
    row.appendChild(input);
    panel.appendChild(row);
  });
}

function moveHang(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= STATE.sections.length) return;
  const [section] = STATE.sections.splice(index, 1);
  STATE.sections.splice(target, 0, section);
  // Keep the active Tabs-view hang pointing at the SAME hang, not the
  // same index, if the SE is looking at one while reordering it.
  if (activeHangIndex === index) activeHangIndex = target;
  else if (activeHangIndex === target) activeHangIndex = index;
  render();
  saveState(false);
}

function renameHang(index, newHeader) {
  const trimmed = newHeader.trim();
  if (!trimmed) { render(); return; } // blank input: just re-render to restore the real name, don't save an empty one
  STATE.sections[index].header = trimmed;
  render();
  saveState(false);
}

// This Date's circuit_color_config starts out seeded from the Show's own
// default (see app.py's build_job), so any edit made here is already a
// Date-only override -- this button just makes it easy to undo one without
// re-entering the whole config by hand.
function appendResetToShowDefaultButton(panel) {
  if (!SHOW_META || !SHOW_META.circuit_color_config) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.textContent = 'Reset to show default';
  btn.title = "Discard this date's own color/numbering tweaks and go back to the show-wide default";
  btn.addEventListener('click', () => {
    STATE.circuit_color_config = JSON.parse(JSON.stringify(SHOW_META.circuit_color_config));
    render();
    saveState(false);
  });
  panel.appendChild(btn);
}

function renderColorPanel() {
  const panel = document.getElementById('colorPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable', ink_friendly_patterns:false});
  panel.innerHTML = '';
  appendResetToShowDefaultButton(panel);

  const enabledRow = document.createElement('div');
  enabledRow.className = 'swatchRow';
  const enabledCb = document.createElement('input');
  enabledCb.type = 'checkbox';
  enabledCb.checked = !!cfg.enabled;
  enabledCb.addEventListener('change', e => { cfg.enabled = e.target.checked; render(); saveState(false); });
  enabledRow.appendChild(enabledCb);
  enabledRow.appendChild(document.createTextNode(' Enable circuit coloring'));
  panel.appendChild(enabledRow);

  // A fully-colored row per box can look visually "busy" on a rig with
  // lots of circuits -- this lets the row-wide paint be turned off
  // without giving up the underlying circuit color assignments/config
  // (which the CKT chip color-set stripe, hang stripe, etc. don't need
  // this to be on for anyway).
  const rowFillRow = document.createElement('div');
  rowFillRow.className = 'swatchRow';
  const rowFillCb = document.createElement('input');
  rowFillCb.type = 'checkbox';
  rowFillCb.checked = cfg.show_row_fill !== false;
  rowFillCb.addEventListener('change', e => { cfg.show_row_fill = e.target.checked; render(); saveState(false); });
  rowFillRow.appendChild(rowFillCb);
  rowFillRow.appendChild(document.createTextNode(' Show color across whole row'));
  panel.appendChild(rowFillRow);

  // Adds a pattern (stripes/dots/plaid) alongside every color below --
  // color alone doesn't survive a black & white print/PDF, so this gives
  // circuits/hangs/circuit-sets a second way to tell apart that still
  // works with no color at all. See INK_PATTERN_COUNT/.ink-pattern-N.
  const inkRow = document.createElement('div');
  inkRow.className = 'swatchRow';
  const inkCb = document.createElement('input');
  inkCb.type = 'checkbox';
  inkCb.checked = !!cfg.ink_friendly_patterns;
  inkCb.addEventListener('change', e => { cfg.ink_friendly_patterns = e.target.checked; render(); saveState(false); });
  inkRow.appendChild(inkCb);
  inkRow.appendChild(document.createTextNode(' Use ink-friendly patterns (for black & white printing)'));
  panel.appendChild(inkRow);

  const paletteLabel = document.createElement('div');
  paletteLabel.className = 'panel-label';
  paletteLabel.textContent = 'Circuit colors';
  panel.appendChild(paletteLabel);
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'swatch-grid';
  (cfg.circuit_colors || []).forEach((hex, i) => {
    const item = document.createElement('div');
    item.className = 'swatch-item';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_colors[i] = cssToArgb(e.target.value); render(); saveState(false); });
    item.appendChild(inp);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_colors.splice(i,1); render(); saveState(false); });
    item.appendChild(rm);
    paletteGrid.appendChild(item);
  });
  panel.appendChild(paletteGrid);
  const addColorBtn = document.createElement('button');
  addColorBtn.textContent = '+ color';
  addColorBtn.addEventListener('click', () => { (cfg.circuit_colors = cfg.circuit_colors || []).push('FFCCCCCC'); render(); saveState(false); });
  panel.appendChild(addColorBtn);

  const cycleRow = document.createElement('div');
  cycleRow.className = 'swatchRow';
  cycleRow.appendChild(document.createTextNode('Repeats after N colors:'));
  const cycleInput = document.createElement('input');
  cycleInput.type = 'number';
  cycleInput.min = 1;
  cycleInput.value = cfg.cycle_length || 4;
  cycleInput.addEventListener('change', e => { cfg.cycle_length = parseInt(e.target.value) || 1; render(); saveState(false); });
  cycleRow.appendChild(cycleInput);
  panel.appendChild(cycleRow);

  const hangHeader = document.createElement('div');
  hangHeader.textContent = 'Hang identity stripes (matched against each card\'s title):';
  panel.appendChild(hangHeader);
  (cfg.hang_colors || []).forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'swatchRow';
    const matchInp = document.createElement('input');
    matchInp.type = 'text';
    matchInp.placeholder = 'e.g. side';
    matchInp.value = entry.match || '';
    matchInp.addEventListener('change', e => { entry.match = e.target.value; saveState(false); });
    row.appendChild(matchInp);
    const colorInp = document.createElement('input');
    colorInp.type = 'color';
    colorInp.value = argbToCss(entry.fill) || '#ffffff';
    colorInp.addEventListener('change', e => { entry.fill = cssToArgb(e.target.value); render(); saveState(false); });
    row.appendChild(colorInp);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.hang_colors.splice(i,1); render(); saveState(false); });
    row.appendChild(rm);
    panel.appendChild(row);
  });
  const addHangBtn = document.createElement('button');
  addHangBtn.textContent = '+ hang stripe rule';
  addHangBtn.addEventListener('click', () => { (cfg.hang_colors = cfg.hang_colors || []).push({match:'', fill:'FFFFFFFF'}); render(); saveState(false); });
  panel.appendChild(addHangBtn);
}

// Brand-agnostic circuit breakout numbering lives in its own panel/button,
// separate from circuit/hang colors -- it's a physical-hardware convention
// (which brand's breakout cable you're plugging into), not a visual one.
function renderNumberingPanel() {
  const panel = document.getElementById('numberingPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable', ink_friendly_patterns:false});
  const cableName = cfg.breakout_cable_name || 'Trunk Cable';
  panel.innerHTML = '';
  appendResetToShowDefaultButton(panel);

  const intro = document.createElement('div');
  intro.textContent = 'Circuit breakout numbering (which brand of breakout cable this rig uses):';
  panel.appendChild(intro);

  // Every brand calls this cable something different -- Cohesion says
  // "Hi-D", some crews just say "Socapex" or "NL8" -- so the label is
  // free text rather than a fixed brand list, and every other control on
  // this panel reads from it instead of hardcoding a name.
  const nameRow = document.createElement('div');
  nameRow.className = 'swatchRow';
  nameRow.appendChild(document.createTextNode('Breakout cable name:'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = cableName;
  nameInput.placeholder = 'Trunk Cable / Socapex / NL8...';
  nameInput.addEventListener('change', e => {
    cfg.breakout_cable_name = e.target.value.trim() || 'Trunk Cable';
    render();
    saveState(false);
  });
  nameRow.appendChild(nameInput);
  panel.appendChild(nameRow);

  const numberingModeRow = document.createElement('div');
  numberingModeRow.className = 'swatchRow';
  numberingModeRow.appendChild(document.createTextNode('Current numbering:'));
  const modeText = document.createElement('strong');
  modeText.textContent = cfg.numbering_mode === 'hid' ? cableName : 'normal';
  numberingModeRow.appendChild(modeText);
  panel.appendChild(numberingModeRow);

  const bundleRow = document.createElement('div');
  bundleRow.className = 'swatchRow';
  bundleRow.appendChild(document.createTextNode('Circuits per breakout cable:'));
  const bundleInput = document.createElement('input');
  bundleInput.type = 'number';
  bundleInput.min = 1;
  bundleInput.value = cfg.hid_bundle_size || 4;
  bundleInput.addEventListener('change', e => { cfg.hid_bundle_size = parseInt(e.target.value) || 4; saveState(false); });
  bundleRow.appendChild(bundleInput);
  panel.appendChild(bundleRow);

  const convertBtn = document.createElement('button');
  const goingToHiD = cfg.numbering_mode !== 'hid';
  convertBtn.textContent = goingToHiD ? `Convert to ${cableName} numbering` : 'Convert back to normal numbering';
  convertBtn.addEventListener('click', () => {
    if (goingToHiD) {
      applyHiDNumbering(STATE.sections, cfg.hid_bundle_size || 4);
    } else {
      restoreNormalNumbering(STATE.sections);
    }
    cfg.numbering_mode = goingToHiD ? 'hid' : 'normal';
    render();
    saveState(false);
  });
  panel.appendChild(convertBtn);

  // The stripe next to CKT that visually shows which boxes share one
  // breakout cable -- same "circuit set" grouping the design generator
  // used for the Excel version of this feature, just under a
  // brand-neutral name here since it lives alongside the rename field.
  const setHeader = document.createElement('div');
  setHeader.textContent = `${cableName} stripe (next to CKT, groups every N circuits above -- same N):`;
  panel.appendChild(setHeader);

  const setEnabledRow = document.createElement('div');
  setEnabledRow.className = 'swatchRow';
  const setEnabledCb = document.createElement('input');
  setEnabledCb.type = 'checkbox';
  setEnabledCb.checked = !!cfg.circuit_set_enabled;
  setEnabledCb.addEventListener('change', e => { cfg.circuit_set_enabled = e.target.checked; render(); saveState(false); });
  setEnabledRow.appendChild(setEnabledCb);
  setEnabledRow.appendChild(document.createTextNode(` Show ${cableName} stripe`));
  panel.appendChild(setEnabledRow);

  const setPaletteLabel = document.createElement('div');
  setPaletteLabel.className = 'panel-label';
  setPaletteLabel.textContent = 'Stripe colors';
  panel.appendChild(setPaletteLabel);
  const setPaletteGrid = document.createElement('div');
  setPaletteGrid.className = 'swatch-grid';
  (cfg.circuit_set_colors || []).forEach((hex, i) => {
    const item = document.createElement('div');
    item.className = 'swatch-item';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_set_colors[i] = cssToArgb(e.target.value); render(); saveState(false); });
    item.appendChild(inp);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_set_colors.splice(i,1); render(); saveState(false); });
    item.appendChild(rm);
    setPaletteGrid.appendChild(item);
  });
  panel.appendChild(setPaletteGrid);
  const addSetColorBtn = document.createElement('button');
  addSetColorBtn.textContent = '+ color';
  addSetColorBtn.addEventListener('click', () => { (cfg.circuit_set_colors = cfg.circuit_set_colors || []).push('FFCCCCCC'); render(); saveState(false); });
  panel.appendChild(addSetColorBtn);
}

async function saveState(showStatus) {
  if (!STATE) return;
  const res = await fetch(`${API_BASE}/state`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
  if (showStatus !== false) {
    if (res.ok) flashStatus('Saved');
    else flashStatus('Save failed');
  }
}

async function exportXlsx() {
  if (!STATE) return;
  await saveState(false);
  flashStatus('Exporting...');
  const res = await fetch(`${API_BASE}/export`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
  if (!res.ok) {
    let msg = 'Export failed';
    try { msg = (await res.json()).error || msg; } catch (e) {}
    flashStatus(msg);
    return;
  }
  const warningsHeader = res.headers.get('X-Export-Warnings');
  const warnings = warningsHeader ? JSON.parse(warningsHeader) : [];
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : 'pinning_sheet_worksheet.xlsx';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  flashStatus('Exported' + (warnings.length ? ' (' + warnings.length + ' warning(s))' : ''));
}

// PDF export re-uses the exact on-screen rendering via the browser's own
// print-to-PDF (window.print()) rather than a server-generated file --
// each mode swaps in different print-only CSS (see "@media print" in
// style.css) and a matching @page size/orientation (injected as its own
// <style> tag, since @page can't be scoped to a class selector) before
// opening the print dialog, then cleans both up once printing is done.
function setPrintPageStyle(css) {
  let el = document.getElementById('printPageStyle');
  if (!el) {
    el = document.createElement('style');
    el.id = 'printPageStyle';
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// CSS "in"/"mm" units are device-independent by spec (1in is always 96px,
// regardless of screen or printer DPI), so these conversions reliably
// predict the printed page's actual pixel size.
function mmToPx(mm) { return (mm / 25.4) * 96; }
function inToPx(inches) { return inches * 96; }

// Never shrunk past this, no matter how much content there is -- past this
// point a sheet just spans multiple printed pages (each card still won't
// split mid-page, see .card's break-inside:avoid in style.css) instead of
// becoming illegibly tiny trying to force everything onto one page.
const MIN_FIT_SCALE = 0.4;

// A small cushion applied to the usable page size before fitting content
// to it -- CSS zoom + getBoundingClientRect rounding can leave the
// measured "fit" a couple pixels over the real usable area, and since
// .card has break-inside:avoid, even a couple pixels of real overflow is
// enough to push a whole card onto a second page rather than just get
// clipped. Better to end up ~1.5% smaller than strictly necessary than
// to risk that.
const PRINT_FIT_SAFETY = 0.985;

// Shrinks (never enlarges) the printed content to fit within one page --
// measuring it laid out at the page's own usable width, which is what the
// print engine will actually use regardless of the browser window's
// current width -- so a normal small pinning sheet (e.g. 4 sections)
// always lands on one printed page without the user having to dig into
// their print dialog's manual scale/"fit to page" option.
function fitContentToPage(pageWidthIn, pageHeightIn, marginMm) {
  const root = document.getElementById('root');
  const marginPx = mmToPx(marginMm);
  const usableWidth = inToPx(pageWidthIn) - marginPx * 2;
  const usableHeight = inToPx(pageHeightIn) - marginPx * 2;
  root.style.zoom = '';
  root.style.width = usableWidth + 'px';
  // @media print force-shows every .meta-col regardless of the ~320px
  // auto-hide threshold, but that only takes effect once the real print
  // starts, after this measurement already ran. Without matching it
  // here, a narrow column measures shorter than it will actually print
  // (its Data Bar "missing" only in this measurement), understating the
  // scale-down actually needed and risking overflow onto a second page.
  const metaCols = [...document.querySelectorAll('.meta-col')];
  metaCols.forEach(m => { m.style.display = 'grid'; });
  const rect = root.getBoundingClientRect();
  metaCols.forEach(m => { m.style.display = ''; });
  const scale = Math.max(MIN_FIT_SCALE, Math.min(1, (usableWidth * PRINT_FIT_SAFETY) / rect.width, (usableHeight * PRINT_FIT_SAFETY) / rect.height));
  // zoom, not transform:scale() -- transform is a paint-time-only visual
  // effect, it never changes an element's actual layout box, so Chrome's
  // print pagination engine was calculating page breaks against each
  // card's ORIGINAL (pre-shrink) size and just painting the visually
  // scaled-down result over that -- which is exactly why every card
  // still landed on its own page even at a scale that looked like
  // everything should fit onto one. zoom actually resizes the layout box
  // itself, so pagination sees (and paginates against) the real,
  // shrunk-down content.
  root.style.zoom = scale < 1 ? scale : '';
  // Forces the browser to actually commit this zoom change into a real
  // layout pass right now, synchronously -- window.print() gets called
  // immediately after this (see runPrint), and without something reading
  // a layout property here first, Chrome can grab its print snapshot
  // from a not-yet-reflowed state, i.e. still at the PRE-zoom size, which
  // reproduces the exact same "every card on its own page" symptom the
  // switch to zoom (from transform) was meant to fix in the first place.
  void root.offsetHeight;
}

function resetContentFit() {
  const root = document.getElementById('root');
  root.style.zoom = '';
  root.style.width = '';
}

// Two-digit-year date, matching the rest of this format ("7/18/26" style)
// rather than a 4-digit ISO one -- pageHeader.date is free text someone
// typed (see the "New date" field on the Show page), not a real date
// picker, so this is a best-effort parse; anything the browser's own
// Date constructor can't make sense of falls back to the raw text as-is
// rather than silently dropping the date from the filename.
function formatDateForFilename(raw) {
  const d = new Date(raw || '');
  if (isNaN(d.getTime())) return sanitizeFilenamePart(raw);
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}.${mm}.${dd}`;
}

// Strips characters that are illegal (or awkward) in a filename on
// Windows/macOS -- show/venue names are free text and could contain any
// of these (a venue like "Radio City Music Hall" is fine, but "7/18" or
// a title with a colon in it isn't).
function sanitizeFilenamePart(text) {
  return (text || '').replace(/[\\/:*?"<>|]/g, '').trim();
}

// "YY.MM.DD - Show - Venue" -- venue is dropped entirely (not left as a
// dangling "- -") when it hasn't been filled in yet.
function buildExportFilename() {
  const pageHeader = (STATE && STATE.page_header) || {};
  const parts = [
    formatDateForFilename(pageHeader.date),
    sanitizeFilenamePart(pageHeader.title) || 'Untitled show',
  ];
  const venue = sanitizeFilenamePart(pageHeader.venue);
  if (venue) parts.push(venue);
  return parts.join(' - ');
}

function runPrint(modeClass, pageCss, gridColumns, fitPage) {
  if (!STATE) return;
  PRINT_IN_PROGRESS = true;
  document.body.classList.add(modeClass);
  const grid = document.getElementById('grid');
  // Tabs view only ever has the one active hang in the DOM -- a PDF
  // export needs every hang regardless of which view mode is on screen,
  // so the grid is fully repopulated here and left for the post-print
  // render() call (in cleanup, below) to put back however the screen
  // should actually look.
  if (STATE.sections && STATE.sections.length) {
    grid.innerHTML = '';
    populateGrid(grid, STATE.sections);
  }
  // pageCss can be a function instead of a plain value -- the mobile
  // export needs the grid already populated (above) to measure a real
  // page height, so it's resolved here rather than up front. Bypasses
  // DESKTOP_MQL's usual viewport-driven column count either way --
  // printing the grid layout should show real columns even if the
  // button was clicked from a phone-width browser window, and printing
  // the mobile layout should force 1 column even from a wide one.
  grid.style.gridTemplateColumns = typeof gridColumns === 'function' ? gridColumns() : gridColumns;
  setPrintPageStyle(typeof pageCss === 'function' ? pageCss() : pageCss);
  if (fitPage) fitContentToPage(fitPage.widthIn, fitPage.heightIn, fitPage.marginMm);
  // Chrome's "Save as PDF" print destination uses document.title as the
  // suggested filename -- there's no other hook into that dialog from a
  // page triggering window.print() itself, so this is the only way to
  // get a meaningful name on the saved file instead of the page's fixed
  // "Pinning Sheet Editor" title.
  const prevTitle = document.title;
  document.title = buildExportFilename();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return; // afterprint firing AND the fallback timer both landing is expected, not a bug
    cleanedUp = true;
    document.body.classList.remove(modeClass);
    setPrintPageStyle('');
    resetContentFit();
    document.title = prevTitle;
    PRINT_IN_PROGRESS = false;
    render();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Fallback in case 'afterprint' doesn't fire -- not just theoretical,
  // since the whole reason render() now refuses to touch the grid while
  // print-mode-* is on body (see render()) is that this class has to be
  // trustworthy. Without this, a browser/situation where 'afterprint'
  // is unreliable would leave the page permanently stuck in print mode
  // (tiny compacted type, unresponsive grid) until a manual reload --
  // exactly what "prints fine but the site looks broken afterward" would
  // look like. 20s is generous enough not to fire during a normal print
  // dialog interaction, short enough to self-heal quickly if it does.
  setTimeout(cleanup, 20000);
  window.print();
}

// Matches what's on screen (cards_per_row) rather than trying to pick a
// "smarter" column count -- an earlier version of this auto-chose columns
// to maximize how little the page needed to shrink, but that depended on
// fitContentToPage's zoom-based shrink actually working for print
// pagination, which repeated testing showed it doesn't reliably do here
// (content kept printing at its full, unzoomed size regardless -- see the
// print-mode-grid compacting rules in style.css, which now do the actual
// size reduction for real instead of relying on that). Portrait, not
// landscape -- taller usable height matters more than extra width for a
// stack of 2-per-row cards, and needs noticeably less shrinking to fit.
// Matches cards_per_row up to this many columns -- past it, no amount of
// print-mode-grid compacting buys back enough width per card to stay
// legible (portrait's ~740px usable width / 3 is already a tight ~245px
// per card; a 5-per-row on-screen preference, carried forward from
// whatever it was last set to, would mean ~125px columns on paper --
// nowhere near enough room for Cab/Model/Splay/CKT). cards_per_row is
// tuned for reading comfort on a screen that can be as wide as you like;
// print has a fixed, much narrower budget.
const MAX_PRINT_COLUMNS = 3;

function exportPrintGrid() {
  const marginMm = 10;
  const cols = Math.min(Math.max(1, (STATE && STATE.cards_per_row) || 2), MAX_PRINT_COLUMNS);
  runPrint(
    'print-mode-grid',
    // Explicit dimensions, not a "portrait" keyword -- that keyword only
    // sets orientation and leaves the actual page size to whatever the
    // print destination's default paper is (Letter, A4, whatever the
    // OS/printer defaults to), which isn't necessarily 8.5x11in. The
    // fitContentToPage fallback below is computed against exactly
    // 8.5x11in, so if the real page came out even slightly different,
    // that math would be fitting content to the wrong page.
    `@page { size: 8.5in 11in; margin: ${marginMm}mm; }`,
    `repeat(${cols}, 1fr)`,
    // Still a fallback for whatever doesn't fit at the real, compacted
    // size (an unusually large hang, say) -- most jobs shouldn't need it
    // at all now, but if it kicks in, it's shrinking already-compact
    // content by a little rather than full-size content by a lot.
    {widthIn: 8.5, heightIn: 11, marginMm}
  );
}

// This mode's "page" is really a phone screen, not a sheet of paper --
// it stays a PDF someone scrolls on their phone, so its dimensions should
// look like a phone (narrow width, tall) instead of the US-letter
// portrait shape @page defaults to. Width is a typical modern phone's CSS
// width. Height is one fixed budget used for every page in the export
// (same size hang to hang, job to job) sized to comfortably hold the
// largest hang this tool is expected to see -- @page can't vary per page
// within one print job, so a hang has to fit within a shared budget
// rather than each getting its own custom-fit page; a hang under that
// budget just leaves trailing blank space below it instead of being
// scaled up to fill the page.
const PHONE_PAGE_WIDTH_IN = 4;
const PHONE_PAGE_MARGIN_MM = 6;
const PHONE_PAGE_MIN_HEIGHT_IN = 7;
const MAX_CABINETS_PER_HANG = 24;

// Worst-case page budget: the show/venue/date header (only ever printed
// once, at the top of page 1, but still eating into that first page's
// height) plus the tallest hang's card, padded out to MAX_CABINETS_PER_HANG
// rows by extrapolating from that same card's own per-row height -- using
// a real measured row rather than a guessed constant keeps this right
// even if the row height ever changes (font size, padding, etc).
// Previously this only measured the actual rendered card height with no
// header or headroom included, which fit real (usually short) hangs fine
// but let the header push hang 1 alone onto its own near-blank page.
function measureMobilePageContentHeightPx(usableWidthPx) {
  const root = document.getElementById('root');
  const header = document.getElementById('printHeader');
  const prevHeaderDisplay = header.style.display;
  root.style.zoom = '';
  root.style.width = usableWidthPx + 'px';
  header.style.display = 'block';

  const headerHeightPx = header.getBoundingClientRect().height;
  let worstCardHeightPx = 0;
  document.querySelectorAll('#grid .card').forEach((card, i) => {
    const section = STATE.sections[i];
    const cabCount = (section && section.cabinets && section.cabinets.length) || 0;
    const rowEl = card.querySelector('.box-row:not(.box-header)');
    const rowHeightPx = rowEl ? rowEl.getBoundingClientRect().height : 0;
    const extraRows = Math.max(0, MAX_CABINETS_PER_HANG - cabCount);
    worstCardHeightPx = Math.max(worstCardHeightPx, card.getBoundingClientRect().height + extraRows * rowHeightPx);
  });

  header.style.display = prevHeaderDisplay;
  resetContentFit();
  return headerHeightPx + worstCardHeightPx;
}

function exportPrintMobile() {
  // Not fit-to-one-page -- this mode is deliberately one section per
  // printed page (see .print-mode-mobile's break-after rule), so there's
  // no single "page" to shrink the whole sheet down to.
  runPrint(
    'print-mode-mobile',
    () => {
      const marginPx = mmToPx(PHONE_PAGE_MARGIN_MM);
      const usableWidthPx = inToPx(PHONE_PAGE_WIDTH_IN) - marginPx * 2;
      const contentHeightPx = measureMobilePageContentHeightPx(usableWidthPx);
      const heightIn = Math.round(Math.max(PHONE_PAGE_MIN_HEIGHT_IN, (contentHeightPx + marginPx * 2) / 96) * 100) / 100;
      return `@page { size: ${PHONE_PAGE_WIDTH_IN}in ${heightIn}in; margin: ${PHONE_PAGE_MARGIN_MM}mm; }`;
    },
    '1fr'
  );
}

async function uploadFile(file) {
  flashStatus('Uploading...');
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
  if (!res.ok) {
    let msg = 'Upload failed';
    try { msg = (await res.json()).error || msg; } catch (e) {}
    flashStatus(msg);
    return;
  }
  STATE = await res.json();
  render();
  flashStatus('Loaded ' + file.name);
}

function flashStatus(msg) {
  const el = document.getElementById('statusMsg');
  if (el) el.textContent = msg;
}

// Disables every input/select/button when the page was opened as
// ?view=1, except the Export button (harmless, doesn't touch the shared
// job) -- applied after every render() since renderColorPanel()/
// renderNumberingPanel() rebuild their own inputs each time.
function applyViewOnlyLock() {
  // Re-run on every render AND every login/logout (not just once at page
  // load like the old VIEW_ONLY-only version) -- auth state can now
  // change live without a reload, so this has to be able to unlock
  // controls again, not just lock them down.
  const readOnly = isReadOnly();
  // #viewOnlyBanner's visibility is handled entirely by the body.view-only
  // rules in style.css (hidden on mobile -- .view-only-topbar covers that
  // case -- shown at desktop) rather than set here, so its own "display:
  // inline" doesn't get clobbered by that CSS.
  document.body.classList.toggle('view-only', readOnly);
  document.getElementById('uploadLabel').style.display = readOnly ? 'none' : '';
  document.getElementById('saveBtn').style.display = readOnly ? 'none' : '';
  // Excludes the login popover's own password field (lives outside the
  // sidebar/card controls this is meant to lock -- an anonymous visitor
  // has to be able to type into it to sign in) and the Data Tags panel's
  // own controls (checkboxes when read-only, see renderLocalDataTagsPanel
  // -- a per-device display preference, not a shared-job edit, so a
  // view-only visitor is exactly who these need to stay usable for).
  document.querySelectorAll('input, select').forEach(el => {
    if (el.closest('#authPopover') || el.closest('#dataTagsPanel')) return;
    el.disabled = readOnly;
  });
  const alwaysEnabled = ['exportBtn', 'printGridBtn', 'printMobileBtn', 'printMobileBtnVO', 'colorToggleBtn', 'numberingToggleBtn', 'dataTagsToggleBtn', 'dataTagsToggleBtnVO', 'pageDesignToggleBtn', 'menuToggleBtn', 'menuCloseBtn', 'authLockBtn', 'sidebarToggleTab'];
  document.querySelectorAll('button').forEach(btn => {
    if (alwaysEnabled.includes(btn.id) || btn.closest('#authPopover') || btn.closest('#dataTagsPanel') || btn.classList.contains('meta-row-hide-btn') || btn.classList.contains('meta-show-all-btn') || btn.classList.contains('hang-tab')) return;
    btn.disabled = readOnly;
  });
}

document.getElementById('cardsPerRow').addEventListener('change', e => {
  if (!STATE) return;
  STATE.cards_per_row = parseInt(e.target.value) || 1;
  render();
  saveState(false);
});
document.getElementById('stripPairLabelsInput').addEventListener('change', e => {
  if (!STATE) return;
  STATE.strip_pair_labels = e.target.checked;
  render();
  saveState(false);
});
function bindShowField(inputId, key) {
  document.getElementById(inputId).addEventListener('change', e => {
    if (!STATE) return;
    STATE.page_header = STATE.page_header || {};
    STATE.page_header[key] = e.target.value;
    saveState(false);
  });
}
bindShowField('showTitleInput', 'title');
bindShowField('showVenueInput', 'venue');
bindShowField('showDateInput', 'date');
document.getElementById('saveBtn').addEventListener('click', () => saveState(true));
document.getElementById('exportBtn').addEventListener('click', exportXlsx);
document.getElementById('printGridBtn').addEventListener('click', exportPrintGrid);
document.getElementById('printMobileBtn').addEventListener('click', exportPrintMobile);
// .view-only-topbar's own copy of the mobile PDF export trigger -- see
// its comment in index.html for why this needs its own button instead of
// just reusing #printMobileBtn (that one lives in the sidebar, which is
// entirely hidden in this mode).
document.getElementById('printMobileBtnVO').addEventListener('click', exportPrintMobile);
// Desktop only (see DESKTOP_MQL): Data tags/Circuit numbering/Colors/Data
// bar all nest inside Page design (see index.html) and share one fixed
// flyout dock of their own, one column further right than Page design's
// own flyout (see style.css) -- so at most one of these four can be open
// at once there, or they'd stack exactly on top of each other. Opening
// Page design itself resets all four back closed, for a predictable
// fresh state each time it's reopened. Hangs is independent of all of
// this -- it expands in place within the sidebar (see #hangsPanel in
// style.css) rather than flying out, so it's untouched by any of this.
// Mobile keeps the old expand-in-place behavior for every panel, where
// several open at once is harmless, so all of this is a no-op there.
const PAGE_DESIGN_SUBPANEL_IDS = ['dataTagsPanel', 'numberingPanel', 'colorPanel', 'dataBarPanel'];
function toggleSubpanel(panelId) {
  const p = document.getElementById(panelId);
  const opening = p.style.display === 'none';
  if (opening && DESKTOP_MQL.matches) {
    PAGE_DESIGN_SUBPANEL_IDS.forEach(id => { if (id !== panelId) document.getElementById(id).style.display = 'none'; });
  }
  p.style.display = opening ? 'block' : 'none';
}
document.getElementById('colorToggleBtn').addEventListener('click', () => toggleSubpanel('colorPanel'));
document.getElementById('numberingToggleBtn').addEventListener('click', () => toggleSubpanel('numberingPanel'));
document.getElementById('dataBarToggleBtn').addEventListener('click', () => toggleSubpanel('dataBarPanel'));
document.getElementById('hangsToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('hangsPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('pageDesignToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('pageDesignPanel');
  const opening = p.style.display === 'none';
  if (opening && DESKTOP_MQL.matches) {
    PAGE_DESIGN_SUBPANEL_IDS.forEach(id => { document.getElementById(id).style.display = 'none'; });
  }
  // '' rather than 'block' when opening -- lets #pageDesignPanel's own
  // "display: flex" (its child spacing, see style.css) win back over this
  // inline style instead of being clobbered by it.
  p.style.display = opening ? '' : 'none';
});
// Two trigger buttons, one panel -- the sidebar's (editor + desktop
// view-only) and .view-only-topbar's (mobile view-only, which has no
// sidebar to put a trigger in -- see the comment on #dataTagsPanel in
// index.html).
function toggleDataTagsPanel() { toggleSubpanel('dataTagsPanel'); }
document.getElementById('dataTagsToggleBtn').addEventListener('click', toggleDataTagsPanel);
document.getElementById('dataTagsToggleBtnVO').addEventListener('click', toggleDataTagsPanel);
// Click-outside-to-close, for every Page Design subpanel (Data Tags,
// Circuit Numbering, Colors, Data Bar) -- same pattern as the auth popover
// (see auth.js), but stopping propagation at the panel itself rather than
// checking panel.contains(e.target) from the document listener: every
// control inside re-renders the panel (setDateTagOverride/
// setLocalTagHidden -> render() -> renderDataTagsPanel wipes and rebuilds
// its innerHTML), which detaches the very element that was clicked BEFORE
// the document listener below gets a chance to check it -- contains()
// on an already-detached node returns false, so the panel was closing
// itself right after every single click inside it.
const PAGE_DESIGN_SUBPANEL_TOGGLE_SELECTORS = {
  dataTagsPanel: '#dataTagsToggleBtn, #dataTagsToggleBtnVO',
  numberingPanel: '#numberingToggleBtn',
  colorPanel: '#colorToggleBtn',
  dataBarPanel: '#dataBarToggleBtn',
};
PAGE_DESIGN_SUBPANEL_IDS.forEach(panelId => {
  document.getElementById(panelId).addEventListener('click', e => e.stopPropagation());
});
document.addEventListener('click', e => {
  PAGE_DESIGN_SUBPANEL_IDS.forEach(panelId => {
    const panel = document.getElementById(panelId);
    if (panel.style.display === 'none') return;
    if (e.target.closest(PAGE_DESIGN_SUBPANEL_TOGGLE_SELECTORS[panelId])) return;
    panel.style.display = 'none';
  });
});
// Click-outside-to-close for the Hang Define popover -- unlike the fixed
// sidebar panels above, this popover is rebuilt (a fresh element) inside
// renderCard on every single edit, so there's no live element to
// stopPropagation() on. e.target.closest() sidesteps that instead: it
// walks up from the ORIGINAL click target's own (possibly since-detached)
// parent chain, which stays intact even after a re-render throws the old
// popover away, so it still correctly recognizes "this click started
// inside the popover" regardless of when the detach happened.
document.addEventListener('click', e => {
  if (!openHangDefineSection) return;
  if (e.target.closest('.hang-define-popover, .hang-define-trigger-btn')) return;
  openHangDefineSection = null;
  render();
});
// Same click-outside-to-close approach for the Hi-D cable dropdown (see
// openHidCableDropdown) -- it isn't tracked by a module-scoped variable
// like the popover above since it doesn't need to survive a render() (no
// field inside it triggers one until an option is actually picked), so
// this just closes whatever instance happens to be open in the DOM.
document.addEventListener('click', e => {
  if (e.target.closest('.hid-cable-dropdown, .circuit-set-stripe-editable')) return;
  const open = document.querySelector('.hid-cable-dropdown');
  if (open) open.remove();
});
document.getElementById('uploadInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) uploadFile(file);
  e.target.value = '';
});

// On a phone the sidebar is a popup (off-canvas, opened over the cards);
// on a wide screen it's always-visible, so open/close is a no-op there --
// see the .sidebar/.sidebar.open rules in style.css for the two states.
function setMenuOpen(open) {
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebarBackdrop').classList.toggle('visible', open);
  document.body.classList.toggle('menu-open', open);
}
document.getElementById('menuToggleBtn').addEventListener('click', () => setMenuOpen(true));
document.getElementById('menuCloseBtn').addEventListener('click', () => setMenuOpen(false));
document.getElementById('sidebarBackdrop').addEventListener('click', () => setMenuOpen(false));

// Desktop-only sidebar collapse -- a separate mechanism from setMenuOpen
// above (that one's mobile off-canvas open/close; this is "hide the
// always-visible side rail and reclaim its width for the grid"). Purely a
// local display preference, not part of the job, so it's remembered in
// localStorage rather than round-tripped through saveState. One grip
// (sidebarToggleTab) handles both directions -- see .sidebar-toggle-tab
// in style.css for why this is a single element rather than a separate
// collapse button + expand tab.
const SIDEBAR_COLLAPSE_KEY = 'pa-pinner-sidebar-collapsed';
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0');
  const tab = document.getElementById('sidebarToggleTab');
  tab.textContent = collapsed ? '»' : '«';
  tab.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
  tab.title = tab.getAttribute('aria-label');
}
setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1');
document.getElementById('sidebarToggleTab').addEventListener('click', () => {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
});

// Touch swipe between hangs -- lets a phone user page through hangs with
// a swipe instead of reaching for the (potentially many, small) tab
// buttons. All sits at the front of the sequence (swipe right/"prev" from
// hang 1 lands back on All, swipe left/"next" from All lands on hang 1),
// same order as the tab row itself.
function nextHangIndex(current) {
  if (current === 'all') return STATE.sections.length ? 0 : null;
  return current < STATE.sections.length - 1 ? current + 1 : null;
}
function prevHangIndex(current) {
  if (current === 'all') return null;
  return current > 0 ? current - 1 : 'all';
}
(function setupHangSwipe() {
  const grid = document.getElementById('grid');
  let startX = 0, startY = 0, tracking = false;
  grid.addEventListener('touchstart', e => {
    tracking = !!STATE && e.touches.length === 1;
    if (!tracking) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, {passive: true});
  grid.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Mostly-horizontal and far enough to be a deliberate swipe -- not a
    // vertical scroll attempt or a tap that drifted a few pixels.
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const target = dx < 0 ? nextHangIndex(activeHangIndex) : prevHangIndex(activeHangIndex);
    if (target !== null) { activeHangIndex = target; render(); }
  }, {passive: true});
})();

window.addEventListener('authed', () => { AUTHED = true; applyViewOnlyLock(); loadState(); initDateSwitcher(); });
window.addEventListener('signedout', () => { AUTHED = false; applyViewOnlyLock(); });
// The lock icon (auth.js) already checks this once for its own padlock
// glyph -- this is app.js's own copy of that same check, just to know
// whether to unlock the sidebar/card controls too.
if (window.PA_AUTH) {
  window.PA_AUTH.refreshStatus().then(authed => { AUTHED = authed; applyViewOnlyLock(); });
}
initDateSwitcher();
// Show meta (hidden_tags) is public/GET, same as the job state itself --
// fetched once here rather than re-fetched on every render. Its own
// render() call catches the (usual) case where it resolves after
// loadState()'s first render already ran with no Show default applied yet.
loadShowMeta().then(render);
loadState().then(() => loadHangProfiles().then(checkHangProfileVersions));
