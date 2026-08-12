// Pinning Sheet Editor -- webapp client. Ported from the local desktop
// editor's embedded script with no changes to the rendering/color/Hi-D
// logic (already tested there) -- only the additions needed to be a real
// webapp: upload instead of a local input/ folder, an empty state before
// anything's been uploaded, and view-only mode for read-only links.

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

// The pick-group divider currently being dragged (see the drag handle/
// dragover/drop handlers in renderCard and movePickBreak) -- module scope
// for the same reason as openHangDefineSection above: renderCard rebuilds
// the whole card mid-drag-lifecycle-events would otherwise lose it. Cleared
// on drop and on dragend (covers a drag released outside any valid target).
let pickDragState = null;

// Data Bar (the Mode/Aim/Trim/Angle/etc. panel) placement -- Date override
// beats Show default beats null ("no override, use the automatic
// card-width-driven placement" -- see the "Data Bar mode" CSS rules).
// Same two-level cascade as Data Tags, minus the per-hang card level (this
// is a whole-Date layout choice, not something that makes sense to vary
// hang to hang). DATA_BAR_MODES itself lives in config-fields.js, shared
// with show.js.
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

// Effective "boxes per pick" (cart height) for a hang -- hang's own
// override (set directly or inherited from a linked Hang Profile) wins,
// then falls back to this Date's cfg.pick_group_size (itself seeded from
// the Show default), then 4. Same cascade shape as resolveTapeBurnFt,
// except there's no separate Show/Date-override pair to check here since
// pick_group_size already lives in circuit_color_config and cascades
// through the normal Show-default-seeds-Date-override path -- this only
// adds the one extra, more-specific layer: the hang itself.
function resolvePickGroupSize(section, cfg) {
  if (section && typeof section.pick_group_size === 'number') return section.pick_group_size;
  return (cfg && cfg.pick_group_size) || 4;
}

// A tape measure missing its first foot or two reads that many feet long
// on every measurement -- subtracts the burn from a hang's raw (decimal
// feet) Trim value. Returns a plain number, not a display string -- see
// formatTrimValue for turning this into what actually shows on screen.
function trueTrimValue(raw, burnFt) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  return Math.round(((Number.isFinite(n) ? n : 0) - burnFt) * 100) / 100;
}

// Trim display format -- decimal feet (default) or feet/inches -- a
// Show-wide default with a per-Date override (no per-hang level, this is a
// standing SE preference, not something that varies hang to hang). Same
// null-cascade convention as resolveDataBarMode above. TRIM_UNIT_FORMATS/
// TRIM_INCHES_PRECISIONS live in config-fields.js, shared with show.js.
function resolveTrimUnitFormat() {
  if (STATE && TRIM_UNIT_FORMATS.includes(STATE.trim_unit_format_override)) return STATE.trim_unit_format_override;
  if (SHOW_META && TRIM_UNIT_FORMATS.includes(SHOW_META.trim_unit_format)) return SHOW_META.trim_unit_format;
  return 'decimal';
}
function resolveTrimInchesPrecision() {
  if (STATE && TRIM_INCHES_PRECISIONS.includes(STATE.trim_inches_precision_override)) return STATE.trim_inches_precision_override;
  if (SHOW_META && TRIM_INCHES_PRECISIONS.includes(SHOW_META.trim_inches_precision)) return SHOW_META.trim_inches_precision;
  return 'whole';
}

// Renders a decimal-feet Trim value the way the SE actually wants to read
// it -- plain decimal ("56.89 ft") or feet/inches ("56' 11\""), the latter
// rounded to the nearest whole/half/quarter inch (however a tape measure
// is actually marked/called out on a rig, not a raw decimal fraction).
function formatTrimValue(decimalFeet, unitFormat, inchesPrecision) {
  const n = Number.isFinite(decimalFeet) ? decimalFeet : 0;
  if (unitFormat !== 'feet_inches') {
    return (Math.round(n * 100) / 100) + ' ft';
  }
  const sign = n < 0 ? '-' : '';
  const absFeet = Math.abs(n);
  const wholeFeet = Math.floor(absFeet);
  const denom = inchesPrecision === 'half' ? 2 : inchesPrecision === 'quarter' ? 4 : 1;
  let roundedInches = Math.round((absFeet - wholeFeet) * 12 * denom) / denom;
  let feet = wholeFeet;
  if (roundedInches >= 12) { roundedInches -= 12; feet += 1; }
  const inchesWhole = Math.floor(roundedInches);
  const frac = Math.round((roundedInches - inchesWhole) * denom) / denom;
  const fracStr = frac === 0.5 ? ' 1/2' : frac === 0.25 ? ' 1/4' : frac === 0.75 ? ' 3/4' : '';
  return `${sign}${feet}' ${inchesWhole}${fracStr}"`;
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

// Splits an ordered list of distinct circuit labels into bundles of
// `cycleLength`, except a label in `manualBreaks` always starts a fresh
// bundle even mid-cycle -- lets a hang whose amp-rack feed splits into a
// new physical trunk cable at a box count that ISN'T a multiple of the
// bundle size (e.g. 6 boxes on one trunk, not 4, because the rest of the
// rack is immutable) express that, instead of being stuck with the fixed
// idx % cycleLength grouping. Shared by hidBundleOrder (below) and
// applyHiDNumbering, which each build their own `order` array first (they
// disagree on whether a blank circuit consumes a slot, so the chunking
// itself is factored out rather than the order-building).
function chunkIntoBundles(order, cycleLength, manualBreaks) {
  const cl = Math.max(1, cycleLength || 1);
  const breaks = manualBreaks || new Set();
  const bundles = [];
  let current = [];
  order.forEach(label => {
    if (current.length && (current.length >= cl || breaks.has(label))) {
      bundles.push(current);
      current = [];
    }
    current.push(label);
  });
  if (current.length) bundles.push(current);
  return bundles;
}

// Distinct (pre-Hi-D) circuit numbers, in first-seen order, chunked into
// bundles of `cycleLength` (see chunkIntoBundles for the manualBreaks
// early-split behavior) -- the same grouping assignCircuitSetColors,
// getStartBreakout/setStartBreakout, and renderCard's bundleOwnerKey map
// all need, factored out so they can't drift apart.
function hidBundleOrder(cabinets, cycleLength, manualBreaks) {
  const seen = new Set();
  const order = [];
  cabinets.forEach(cab => {
    const ckt = cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt;
    if (!seen.has(ckt)) { seen.add(ckt); order.push(ckt); }
  });
  return chunkIntoBundles(order, cycleLength, manualBreaks);
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
  section.pick_group_size = typeof profile.pick_group_size === 'number' ? profile.pick_group_size : null;
  // Position-keyed (cab.position), same as manual_circuit_pattern's own
  // per-box indexing below -- lines up correctly when the target hang has
  // the same box layout the profile was saved from (the common case,
  // since that's usually WHY a profile got saved), degrades gracefully
  // (a stray break/name landing on the wrong or no box) otherwise, same
  // as any other profile field applied to a mismatched hang.
  section.pick_manual_breaks = (profile.pick_manual_breaks || []).slice();
  section.pick_manual_merges = (profile.pick_manual_merges || []).slice();
  section.pick_group_names = Object.assign({}, profile.pick_group_names || {});
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
function assignCircuitSetColors(cabinets, palette, cycleLength, overrides, manualBreaks) {
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
  hidBundleOrder(cabinets, cycleLength, manualBreaks).forEach(bundle => {
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

// Declaring a split/cable choice at `fromKey` (either forcing a new trunk
// cable to start there, or picking that bundle's own cable number) is
// meant to keep going -- Brown, Brown, Brown, ..., Red, Red, Red -- for
// the rest of the hang, not just for the one bundle clicked. An SE is
// "unlikely to ever split a cable and skip breakout connections and then
// resume those connections further down" (i.e. go back to an earlier
// color after a later one), so any hid_cable_overrides entry sitting on a
// LATER bundle is almost always a leftover from before this split existed
// -- it was pinned back when that bundle's position in the sequence meant
// something different, and left stale, it silently overrides the
// cascading default (current + 1) and makes downstream boxes look like
// they never picked up the new color. Clearing those stale entries here
// (every time a split/cable choice is made) lets the sequential default
// take back over for everything after `fromKey`, all the way to the next
// bundle the SE deliberately split off (hid_manual_breaks) -- THAT one is
// a real second decision point, so it and everything after it are left
// alone.
function clearDownstreamOverrides(section, cfg, fromKey) {
  const overrides = section.hid_cable_overrides;
  if (!overrides) return;
  const bundleSize = (cfg && cfg.hid_bundle_size) || 4;
  const manualBreaks = new Set(section.hid_manual_breaks || []);
  const bundles = hidBundleOrder(section.cabinets || [], bundleSize, manualBreaks);
  const fromIndex = bundles.findIndex(bundle => bundle[0] === fromKey);
  if (fromIndex === -1) return;
  for (let i = fromIndex + 1; i < bundles.length; i++) {
    const ownerKey = bundles[i][0];
    if (manualBreaks.has(ownerKey)) break;
    delete overrides[ownerKey];
  }
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

// The menu opened by clicking any box's circuit-set-stripe chevron.
// `rowKey` is the identity of the box actually clicked; `ownerKey` is that
// bundle's first key (the identity hid_cable_overrides/manual breaks are
// actually keyed by -- see bundleOwnerKey in renderCard). Two shapes:
//  - Clicked the bundle's own first box (isOwnerRow): the usual "Cable N"
//    picker (a swatch of each cable's actual palette color, so the SE can
//    pick the cable they're really plugged into by its color rather than
//    a bare number), plus -- only if this box's bundle exists because of a
//    manual split rather than the fixed bundle-size grid -- an option to
//    undo that split.
//  - Clicked any other box in the bundle: a single "start a new trunk
//    cable here" option, forcing an early bundle boundary right at that
//    box even mid-way through the fixed cycle (see chunkIntoBundles) --
//    covers an immutable amp-rack feed that splits a hang's boxes across
//    trunks/circuits at a count that isn't a multiple of "Circuits per
//    breakout cable".
function openTrunkStripeMenu(anchor, section, cfg, rowKey, ownerKey, isOwnerRow, currentNumber) {
  const existing = anchor.querySelector('.hid-cable-dropdown');
  if (existing) { existing.remove(); return; }
  const cableName = cfg.breakout_cable_name || 'Trunk Cable';
  const dropdown = document.createElement('div');
  dropdown.className = 'hid-cable-dropdown';

  const rerunNumbering = () => {
    if (cfg.numbering_mode === 'hid') applyHiDNumbering([section], cfg.hid_bundle_size || 4);
  };

  if (!isOwnerRow) {
    const opt = document.createElement('div');
    opt.className = 'hid-cable-dropdown-option';
    opt.textContent = `Start new ${cableName} here`;
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const breaks = new Set(section.hid_manual_breaks || []);
      breaks.add(rowKey);
      section.hid_manual_breaks = Array.from(breaks);
      clearDownstreamOverrides(section, cfg, rowKey);
      rerunNumbering();
      render();
      saveState(false);
    });
    dropdown.appendChild(opt);
    anchor.appendChild(dropdown);
    return;
  }

  if ((section.hid_manual_breaks || []).includes(ownerKey)) {
    const undoOpt = document.createElement('div');
    undoOpt.className = 'hid-cable-dropdown-option';
    undoOpt.textContent = 'Undo split (merge with previous)';
    undoOpt.addEventListener('click', e => {
      e.stopPropagation();
      const breaks = new Set(section.hid_manual_breaks || []);
      breaks.delete(ownerKey);
      section.hid_manual_breaks = Array.from(breaks);
      if (section.hid_cable_overrides) delete section.hid_cable_overrides[ownerKey];
      const mergedBundle = hidBundleOrder(section.cabinets || [], (cfg.hid_bundle_size || 4), breaks)
        .find(bundle => bundle.includes(ownerKey));
      if (mergedBundle) clearDownstreamOverrides(section, cfg, mergedBundle[0]);
      rerunNumbering();
      render();
      saveState(false);
    });
    dropdown.appendChild(undoOpt);
    dropdown.appendChild(document.createElement('hr'));
  }

  const palette = cfg.circuit_set_colors;
  const pal = palette && palette.length ? palette : ['FFCCCCCC'];
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
      if (n > 0) section.hid_cable_overrides[ownerKey] = n;
      else delete section.hid_cable_overrides[ownerKey];
      clearDownstreamOverrides(section, cfg, ownerKey);
      render();
      saveState(false);
    });
    dropdown.appendChild(opt);
  }
  anchor.appendChild(dropdown);
}

// The menu opened by clicking a pick-group badge (A1, A2, ... B1, ...).
// Two independent things can live here: a rename field (every group start
// gets one, including the very first box, since a name has nothing to do
// with splitting/merging) and a split/merge action (only for `canSplitMerge`
// -- i.e. every box past the very first, which is where openPickGroupMenu
// is only ever called with it true). `isGroupStart` true means this box
// currently starts a new pick, so the action is merging it back with the
// previous one -- how that's stored depends on WHY it's a group start
// (`isNatural`): a natural start (box-type change or hitting the size cap)
// gets suppressed via pick_manual_merges, a manual one just gets removed
// from pick_manual_breaks. `isGroupStart` false means this is a mid-group
// box, so the action is forcing a split here (adds to breaks; see
// movePickBreak for the drag-driven version of this same edit). Reuses the
// exact same .hid-cable-dropdown/-option classes as the trunk menu above.
//
// `navList`/`navIndex` (both optional) are only used to wire up Tab/
// Shift+Tab on the rename field so renaming every pick in a hang doesn't
// need a fresh click each time -- see makePickGroupNameLabel's call site
// (pickGroupList in renderCard) for what a navList entry looks like.
function openPickGroupMenu(anchor, section, cab, isGroupStart, isNatural, canSplitMerge, navList, navIndex, defaultLabel) {
  const existing = anchor.querySelector('.hid-cable-dropdown');
  if (existing) { existing.remove(); return; }
  const dropdown = document.createElement('div');
  dropdown.className = 'hid-cable-dropdown';
  let nameInputToFocus = null;

  if (isGroupStart) {
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pick-group-name-menu-input';
    nameInput.placeholder = 'Name this pick (optional)';
    nameInput.value = (section.pick_group_names || {})[cab.position] || '';
    nameInput.addEventListener('click', e => e.stopPropagation());
    // Shared between blur (the 'change' listener below) and Tab (the
    // keydown listener further down): writes the typed value into the
    // data model AND updates the stripe label's own text/orientation
    // directly, in place, rather than calling the global render() --
    // render() rebuilds the ENTIRE page's DOM, which (a) would detach
    // every row/cab reference already captured in navList (including
    // `next`, needed immediately after this during a Tab move) before
    // openPickGroupMenu ever got to append anything to it -- a real,
    // intermittent bug during testing, not just theoretical -- and (b)
    // is a lot of work for updating one piece of text. `anchor` is this
    // pick's own row (where its label actually lives, see
    // makePickGroupNameLabel), so it's always the right place to look,
    // Tab-triggered or not.
    const commitName = () => {
      const v = nameInput.value.trim();
      const names = Object.assign({}, section.pick_group_names || {});
      if (v) names[cab.position] = v; else delete names[cab.position];
      section.pick_group_names = names;
      const label = anchor.querySelector('.pick-group-name-label');
      if (label) {
        const shown = v || defaultLabel;
        label.textContent = shown;
        label.title = shown;
        label.classList.toggle('pick-group-name-label-horizontal', pickNameFitsHorizontally(shown));
      }
    };
    // Named (not inline) specifically so the Tab handler below can detach
    // it before removing this input -- removing a still-focused, value-
    // changed input can synchronously fire ITS OWN 'change' via the
    // implicit blur that causes, which would run commitName() a harmless
    // second time but call saveState() redundantly right as a fresh
    // fetch for the SAME data is already in flight from the Tab handler.
    const onChange = () => {
      commitName();
      saveState(false);
    };
    nameInput.addEventListener('change', onChange);
    // Tab/Shift+Tab hops straight to the next/previous pick's OWN rename
    // field instead of wherever plain tab order would otherwise land, so
    // renaming a whole hang's worth of picks is just type, Tab, type,
    // Tab... Falls through to normal tab behavior at either end of the
    // list (no preventDefault) rather than trapping focus with nowhere
    // to go.
    if (navList) {
      nameInput.addEventListener('keydown', ev => {
        if (ev.key !== 'Tab') return;
        const nextIndex = navIndex + (ev.shiftKey ? -1 : 1);
        const next = navList[nextIndex];
        if (!next) return;
        ev.preventDefault();
        commitName();
        saveState(false);
        nameInput.removeEventListener('change', onChange);
        dropdown.remove();
        openPickGroupMenu(next.row, section, next.cab, true, next.isNatural, next.canSplitMerge, navList, nextIndex, next.defaultLabel);
      });
    }
    dropdown.appendChild(nameInput);
    nameInputToFocus = nameInput;
  }

  if (canSplitMerge) {
    const opt = document.createElement('div');
    opt.className = 'hid-cable-dropdown-option';
    opt.textContent = isGroupStart ? 'Merge with previous pick' : 'Start new pick here';
    opt.addEventListener('click', e => {
      e.stopPropagation();
      if (isGroupStart) {
        if (isNatural) {
          const merges = new Set(section.pick_manual_merges || []);
          merges.add(cab.position);
          section.pick_manual_merges = Array.from(merges);
        } else {
          const breaks = new Set(section.pick_manual_breaks || []);
          breaks.delete(cab.position);
          section.pick_manual_breaks = Array.from(breaks);
        }
      } else {
        const breaks = new Set(section.pick_manual_breaks || []);
        breaks.add(cab.position);
        section.pick_manual_breaks = Array.from(breaks);
        const merges = new Set(section.pick_manual_merges || []);
        if (merges.delete(cab.position)) section.pick_manual_merges = Array.from(merges);
      }
      render();
      saveState(false);
    });
    dropdown.appendChild(opt);
  }

  anchor.appendChild(dropdown);
  // Only meaningful once the input is actually part of the live document
  // -- focus()/select() on a still-detached element (i.e. called before
  // this appendChild) silently do nothing, which is exactly the bug this
  // ordering fixes. Selected, not just focused -- clicking a pick you
  // already named means "I want to change this," so the existing text
  // should be ready to type straight over, not require a manual
  // select-all first.
  if (nameInputToFocus) {
    nameInputToFocus.focus();
    nameInputToFocus.select();
  }
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
    hid_reverse_order: resolveHidReverseOrder(section),
    tape_burn_ft: resolveTapeBurnFt(section),
    apply_manual_circuiting: !!section.apply_manual_circuiting,
    manual_circuit_pattern: section.manual_circuit_pattern || [],
    hang_color: section.hang_color || null,
    rename_to: section.header,
    hidden_tags: allTagsWithLabels().map(t => t.key).filter(key => isTagHidden(key, section)),
    pick_group_size: typeof section.pick_group_size === 'number' ? section.pick_group_size : null,
    pick_manual_breaks: section.pick_manual_breaks || [],
    pick_manual_merges: section.pick_manual_merges || [],
    pick_group_names: section.pick_group_names || {},
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
      hid_reverse_order: resolveHidReverseOrder(section),
      tape_burn_ft: resolveTapeBurnFt(section),
      apply_manual_circuiting: !!section.apply_manual_circuiting,
      manual_circuit_pattern: section.manual_circuit_pattern || [],
      hang_color: section.hang_color || null,
      rename_to: section.header,
      hidden_tags: allTagsWithLabels().map(t => t.key).filter(key => isTagHidden(key, section)),
      pick_group_size: typeof section.pick_group_size === 'number' ? section.pick_group_size : null,
      pick_manual_breaks: section.pick_manual_breaks || [],
      pick_manual_merges: section.pick_manual_merges || [],
      pick_group_names: section.pick_group_names || {},
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
    await ensureHangProfileKnowsSection(profile, section);
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
  applyBtn.addEventListener('click', async () => {
    const profile = HANG_PROFILES.find(p => p.id === select.value);
    if (!profile) return;
    applyHangProfileToSection(section, profile);
    await ensureHangProfileKnowsSection(profile, section);
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

  // Mid-hang trunk splits (added via each box's circuit-set-stripe chevron
  // menu, see openTrunkStripeMenu) don't have any other visible home in
  // this popover -- "Start on Breakout #" above only covers the hang's
  // very first bundle, this covers every later one that got forced off
  // the fixed bundle-size grid.
  if ((section.hid_manual_breaks || []).length) {
    const splitsRow = document.createElement('div');
    splitsRow.className = 'hang-define-row';
    const count = section.hid_manual_breaks.length;
    splitsRow.appendChild(document.createTextNode(
      `${count} mid-hang trunk split${count === 1 ? '' : 's'} set`
    ));
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      section.hid_manual_breaks = [];
      if (STATE.circuit_color_config && STATE.circuit_color_config.numbering_mode === 'hid') {
        applyHiDNumbering([section], STATE.circuit_color_config.hid_bundle_size || 4);
      }
      render();
      saveState(false);
    });
    splitsRow.appendChild(clearBtn);
    pop.appendChild(splitsRow);
  }

  const reverseRow = document.createElement('label');
  reverseRow.className = 'hang-define-row';
  const reverseCb = document.createElement('input');
  reverseCb.type = 'checkbox';
  reverseCb.checked = resolveHidReverseOrder(section);
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
  reverseRow.appendChild(document.createTextNode(' Descending (4,3,2,1) -- overrides the show default'));
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

  // Per-hang override for "how many boxes ride on one cart" -- some models
  // stack 4 high, some 3, some more; the Pick Groups panel's own
  // pick_group_size is just the show/date-wide typical value (see
  // resolvePickGroupSize). Empty means "use that show/date default",
  // same null-cascade convention as Tape Burn above. Also carried by Hang
  // Profiles (see HANG_PROFILE_FIELDS in app.py/applyHangProfileToSection)
  // so a profile like "Sub Stack - 3 High" can set it once and reuse it.
  const pickSizeRow = document.createElement('div');
  pickSizeRow.className = 'hang-define-row';
  const pickSizeLabel = document.createElement('label');
  pickSizeLabel.textContent = 'Boxes per pick (cart height)';
  pickSizeRow.appendChild(pickSizeLabel);
  const pickSizeInput = document.createElement('input');
  pickSizeInput.type = 'number';
  pickSizeInput.min = 1;
  const showDefaultPickSize = (STATE.circuit_color_config && STATE.circuit_color_config.pick_group_size) || 4;
  pickSizeInput.placeholder = `Show default (${showDefaultPickSize})`;
  if (typeof section.pick_group_size === 'number') pickSizeInput.value = section.pick_group_size;
  pickSizeInput.addEventListener('change', e => {
    const n = parseInt(e.target.value, 10);
    section.pick_group_size = Number.isFinite(n) && n > 0 ? n : null;
    render();
    saveState(false);
  });
  pickSizeRow.appendChild(pickSizeInput);
  if (typeof section.pick_group_size === 'number') {
    const clearPickSizeBtn = document.createElement('button');
    clearPickSizeBtn.type = 'button';
    clearPickSizeBtn.textContent = 'Use show default';
    clearPickSizeBtn.addEventListener('click', () => {
      section.pick_group_size = null;
      render();
      saveState(false);
    });
    pickSizeRow.appendChild(clearPickSizeBtn);
  }
  pop.appendChild(pickSizeRow);

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

  // Free text, shown on the card face (see renderCard's meta-notes-row)
  // whenever it's non-empty, and on the printed sheet the same way --
  // deliberately NOT part of Hang Profiles (like hid_manual_breaks) since
  // a note is about this specific hang on this specific date, not
  // something a reusable cross-show template should carry.
  const notesRow = document.createElement('div');
  notesRow.className = 'hang-define-row';
  const notesLabel = document.createElement('label');
  notesLabel.textContent = 'Notes';
  notesRow.appendChild(notesLabel);
  const notesInput = document.createElement('textarea');
  notesInput.className = 'hang-define-notes-input';
  notesInput.rows = 3;
  notesInput.placeholder = "Anything worth flagging about this hang...";
  notesInput.value = section.notes || '';
  notesInput.addEventListener('change', e => {
    section.notes = e.target.value.trim();
    render();
    saveState(false);
  });
  notesRow.appendChild(notesInput);
  pop.appendChild(notesRow);

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
    row.appendChild(swatchLabel(label));
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
// Whether a hang's breakout legs count DOWN (4,3,2,1) or UP (1,2,3,4).
// section.hid_reverse_order is explicit true/false once the SE has
// touched the checkbox in that hang's Define popover (or applied a Hang
// Profile, which always carries an explicit value) -- left undefined
// otherwise, which falls through to the show-wide default set in the
// Circuit Numbering panel (cfg.hid_reverse_order_default, itself
// defaulting to descending so upgrading this app doesn't silently flip
// numbers on an already-configured show).
function resolveHidReverseOrder(section) {
  if (typeof section.hid_reverse_order === 'boolean') return section.hid_reverse_order;
  const cfg = STATE.circuit_color_config;
  return !(cfg && cfg.hid_reverse_order_default === false);
}

function applyHiDNumbering(sections, bundleSize) {
  const bs = Math.max(1, bundleSize || 4);
  (sections || []).forEach(section => {
    const cabinets = section.cabinets || [];
    cabinets.forEach(c => { if (c._normalCkt === undefined) c._normalCkt = c.ckt; });
    const reverse = resolveHidReverseOrder(section);
    const manualBreaks = new Set(section.hid_manual_breaks || []);

    const distinctOrder = [];
    const seen = new Set();
    cabinets.forEach(c => {
      const orig = c._normalCkt;
      if (orig && !seen.has(orig)) { seen.add(orig); distinctOrder.push(orig); }
    });

    const mapping = {};
    chunkIntoBundles(distinctOrder, bs, manualBreaks).forEach(bundle => {
      bundle.forEach((label, posInBundle) => {
        mapping[label] = String(reverse ? bs - posInBundle : posInBundle + 1);
      });
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
    document.getElementById('uploadedFileName').textContent = '';
    document.getElementById('uploadedFileTime').textContent = '';
    applyViewOnlyLock();
    return;
  }
  // Stays under the upload button until the next upload replaces it --
  // source_file/source_file_uploaded_at are set server-side by build_job()
  // on every upload (see api_upload in app.py) and persist in job.json, so
  // a reload doesn't lose them the way the old flashStatus-only "Loaded X"
  // message did. The timestamp is stored as UTC ISO 8601 and formatted
  // into the visitor's own local time/locale here rather than server-side.
  document.getElementById('uploadedFileName').textContent = STATE.source_file || '';
  document.getElementById('uploadedFileName').title = STATE.source_file || '';
  document.getElementById('uploadedFileTime').textContent = STATE.source_file_uploaded_at
    ? 'Uploaded ' + new Date(STATE.source_file_uploaded_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
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
  document.getElementById('showAddressInput').value = pageHeader.address || '';

  // Only ever visible in @media print -- see .print-header in style.css.
  const printHeader = document.getElementById('printHeader');
  printHeader.innerHTML = '';
  if (pageHeader.title) {
    const t = document.createElement('div');
    t.className = 'ph-title';
    t.textContent = pageHeader.title;
    printHeader.appendChild(t);
  }
  // "Venue - Address - Date" -- a dash, not the bullet voMeta below uses,
  // per the requested PDF header format. Address included alongside
  // venue/date since it's exactly the load-in/logistics detail a printed
  // sheet should carry, not just an on-screen convenience.
  const printMetaBits = [pageHeader.venue, pageHeader.address, pageHeader.date].filter(Boolean).join(' - ');
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
  const voMetaBits = [pageHeader.venue, pageHeader.address, pageHeader.date].filter(Boolean).join(' • ');
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
  renderPickGroupsPanel();
  renderDataTagsPanel();
  renderDataBarPanel();
  renderTrimUnitsPanel();
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

// Page URLs are /<show>/<date>, not /static/..., so a plain relative path
// here would resolve against the wrong base -- anchor to this very script's
// own src (reliable only at top-level eval time, hence capturing it now
// rather than inside a function called later) to get back to /static/.
const STATIC_BASE = document.currentScript ? document.currentScript.src.replace(/app\.js(?:\?.*)?$/, '') : '/static/';

// Registry of front-face vector art, keyed by the exact cab.model token
// pinning_parser/pdf_parser produce (see formatModelDispersion above) --
// add a new model here once its SVG lands in static/speaker-faces/. Models
// with no entry just show the plain text chip, same as before this existed.
const SPEAKER_FACE_ICONS = {
  CO12: STATIC_BASE + 'speaker-faces/CO12.svg',
};

// Groups a hang's cabinets into their physical "pick" -- the stack of
// boxes (generally all one box type, generally ~4) assembled on the
// ground and hoisted as one unit, then labeled A1-A4, B1-B4, ... from the
// top of each pick down. A box-type change (formatModelDispersion) always
// starts a new group -- that's the near-always-true real-world signal, so
// it wins even mid-count -- maxSize is just a safety cap for an unusually
// long run of one type (a pick can't be arbitrarily tall). `manualBreaks`
// (a Set of cab.position values, the same stable per-box identity
// hid_manual_breaks uses cab._normalCkt for) forces an early split for the
// rare pick that doesn't follow either signal on its own. `manualMerges` is
// the opposite override -- it suppresses a break that would otherwise
// happen naturally (type change or hitting the size cap), letting the SE
// drag a divider line past a natural boundary (e.g. combine the last box
// of one model with the first of the next onto one cart). A position can
// only ever be in one of the two sets at a time (see movePickBreak); an
// explicit break always wins over a merge at the same position.
function computePickGroups(cabinets, maxSize, manualBreaks, manualMerges) {
  const breaks = manualBreaks || new Set();
  const merges = manualMerges || new Set();
  const size = Math.max(1, maxSize || 4);
  const groups = [];
  let current = [];
  let lastType = null;
  (cabinets || []).forEach(cab => {
    const type = formatModelDispersion(cab);
    const natural = current.length > 0 && (current.length >= size || type !== lastType);
    const shouldBreak = current.length > 0 && (breaks.has(cab.position) || (natural && !merges.has(cab.position)));
    if (shouldBreak) { groups.push(current); current = []; }
    current.push(cab);
    lastType = type;
  });
  if (current.length) groups.push(current);
  return groups;
}

// Drags a pick-group divider line from one box to another -- the two-sided
// version of what openPickGroupMenu's single option does at one position:
// releases whatever's holding the line at `fromPos` (undoes a manual break,
// or suppresses a natural one via a merge) and establishes it at `toPos`
// (adds a manual break, unless `toPos` is ALREADY a group start under the
// hang's current, fully-overridden grouping, in which case there's nothing
// to add). Caller (the drop handler in renderCard) is responsible for
// render()/saveState(); a no-op if dropped back on its own starting
// position.
//
// `currentManualBreaks` and `toAlreadyBreaks` MUST come from the same live
// pickInfo/pickBreaksSet this render already computed for the hang (with
// every existing override applied) -- NOT a freshly-recomputed "natural,
// no overrides at all" baseline. An earlier version used exactly that kind
// of override-free baseline to decide both sides of this edit, and it went
// stale the moment a second break/merge existed anywhere else in the hang:
// upstream overrides shift how many boxes have accumulated by the time the
// loop reaches `toPos`, so whether a break happens there naturally in the
// CURRENT grouping can differ from what an override-free recomputation
// says. When the stale check said "natural" but the live grouping no
// longer broke there, the code deleted a merge entry that was never set
// and never added an explicit break -- the divider silently never
// reappeared, however many times it was dragged. Reading both sides off
// the same live computation the row is already rendering from removes
// that mismatch entirely, whatever the resulting group sizes end up being
// (a pick of 1 or 2 is exactly as valid as one at the size cap).
function movePickBreak(section, currentManualBreaks, fromPos, toPos, toAlreadyBreaks) {
  if (fromPos === toPos) return;
  const breaks = new Set(section.pick_manual_breaks || []);
  const merges = new Set(section.pick_manual_merges || []);
  if (currentManualBreaks.has(fromPos)) breaks.delete(fromPos);
  else merges.add(fromPos);
  merges.delete(toPos);
  if (!toAlreadyBreaks) breaks.add(toPos);
  section.pick_manual_breaks = Array.from(breaks);
  section.pick_manual_merges = Array.from(merges);
}

// Same font-family stack as the page itself (see body's font-family) --
// used only for the canvas measurement below, which needs an explicit
// font string rather than inherited CSS.
const PICK_NAME_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
let pickNameMeasureCtx = null;

// Whether `name` reads fine set normally (horizontal, one line) within the
// narrow horizontal space the stripe actually gives it, rather than needing
// to run sideways up/down the stripe instead. Measured with a scratch
// <canvas> 2D context (created once, reused) rather than a real DOM
// insert-and-measure round trip -- this runs once per named pick on every
// render, and canvas text metrics are the same layout engine Chrome uses
// for real text, just without paying for a reflow to get them. 10px/700 here
// has to track .pick-group-name-label's own font-size/font-weight in
// style.css, and the 16px budget is that label's fixed 22px width minus
// its own left/right padding -- both live here instead of reading them
// back out of computed style, since the label isn't attached to the
// document yet at the point this needs an answer.
function pickNameFitsHorizontally(name) {
  if (!pickNameMeasureCtx) pickNameMeasureCtx = document.createElement('canvas').getContext('2d');
  pickNameMeasureCtx.font = `700 10px ${PICK_NAME_FONT_STACK}`;
  return pickNameMeasureCtx.measureText(name).width <= 16;
}

// A pick's optional name (e.g. "SL Cart"), rendered directly on the hang
// stripe rather than as its own row in the box list -- reusing the same
// "child of the group's first box row, escaped left via right:100% into
// the stripe" trick the drag grip already uses (see .pick-group-drag-
// handle), just stretched down to cover that whole pick's height instead
// of sitting on one row -- calc(var(--row-h) * groupCabs.length): .box-row
// is border-box with height: var(--row-h), so N consecutive rows occupy
// exactly N * var(--row-h) with no gap to account for. Short names
// (pickNameFitsHorizontally) stay upright and read normally; longer ones
// that can't fit the stripe's own width rotate sideways instead, trading
// readability at a glance for not getting clipped. NOT gated on
// isPrintMode() -- this is real sheet content, not just an editing aid,
// so it has to survive into the exported PDF looking the same as it does
// on screen; only the click-to-edit affordance below is edit-only.
//
// Clicking ANYWHERE on this label -- not just some precise sliver of it --
// opens rename/merge for the pick's own first box (an earlier version
// tried resolving a different target box from the click's exact Y
// position, so a click lower in a tall label could reach "start a new
// pick here" instead; that made the far more common action, renaming,
// unreliable to trigger on a label that visually reads as ONE thing, not
// a stack of separately-clickable slots). Adding a brand new split
// partway through an existing pick is still fully reachable -- drag a
// neighboring pick's grip into this one (see movePickBreak) -- just not
// from this label anymore.
// `navList`/`navIndex` are passed straight through to openPickGroupMenu to
// wire up Tab/Shift+Tab between picks' rename fields; `defaultLabel` (the
// plain letter shown when unnamed) rides along too, so a Tab-triggered
// clear-to-empty knows what to fall back to displaying without needing a
// full render() -- see openPickGroupMenu's commitName. Returns null for an
// unnamed pick.
function makePickGroupNameLabel(section, groupCabs, name, row, isNatural, groupStartCanSplitMerge, navList, navIndex, defaultLabel) {
  if (!name) return null;
  const label = document.createElement('div');
  label.className = 'pick-group-name-label';
  if (pickNameFitsHorizontally(name)) label.classList.add('pick-group-name-label-horizontal');
  label.style.height = `calc(var(--row-h) * ${Math.max(1, groupCabs.length)})`;
  label.textContent = name;
  label.title = name;
  if (!isPrintMode()) {
    label.classList.add('pick-group-name-label-editable');
    label.addEventListener('click', ev => {
      ev.stopPropagation();
      openPickGroupMenu(row, section, groupCabs[0], true, isNatural, groupStartCanSplitMerge, navList, navIndex, defaultLabel);
    });
  }
  return label;
}

// Spreadsheet-style letters (A, B, ..., Z, AA, AB, ...) for a pick group's
// index -- a hang with more than 26 picks would be extraordinary, but this
// keeps the label meaningful even then instead of just running out.
function pickGroupLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// cab -> "A1"/"A2"/... label, the Set of cabs that start a new group (for
// both the divider styling and deciding which badge gets the "start/undo
// a split" click affordance), and each group-start cab's own box count
// (sizes -- used to size that pick's name label on the hang stripe, see
// makePickGroupNameLabel, to exactly the height its boxes occupy) --
// computed once per section, same pattern as circuitFillMap/
// circuitSetFillMap above.
function computePickLabels(cabinets, maxSize, manualBreaks, manualMerges) {
  const labels = new Map();
  const groupStarts = new Set();
  const sizes = new Map();
  computePickGroups(cabinets, maxSize, manualBreaks, manualMerges).forEach((group, gi) => {
    const letter = pickGroupLetter(gi);
    group.forEach((cab, pi) => {
      labels.set(cab, `${letter}${pi + 1}`);
      if (pi === 0) { groupStarts.add(cab); sizes.set(cab, group.length); }
    });
  });
  return { labels, groupStarts, sizes };
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
  // Skipped entirely in print mode, not just hidden via @media print --
  // the mobile export's page-height measurement (measureMobilePageContentHeightPx)
  // calls getBoundingClientRect() on these SAME cards on the live document,
  // where @media print rules don't apply yet (that only kicks in once an
  // actual print/preview starts). An element that's only hidden via
  // @media print would still count toward the measured height, computing a
  // page taller than what the real print output ends up needing -- leaving
  // it out of the DOM here instead keeps what's measured and what's
  // printed identical.
  if (!isPrintMode()) {
    title.appendChild(makeHangDefineTrigger(section));
  }
  content.appendChild(title);
  // Expands in place (normal document flow, pushing the box list down)
  // rather than floating over the card -- same convention as the
  // meta-expanded accordion reveal above, and avoids fighting .card's own
  // overflow:hidden (used to clip the rounded corners/hang stripe) that a
  // floating popover would need to escape. Excluded from print for the
  // same measurement-vs-print-CSS reason as the trigger button above --
  // also just makes no sense on paper even if it happened to be open.
  if (openHangDefineSection === section && !isPrintMode()) content.appendChild(renderHangDefinePopover(section));

  const body = document.createElement('div');
  body.className = 'card-body';

  const boxList = document.createElement('div');
  boxList.className = 'box-list';

  // 'dispersion' is folded into the 'model' column's own display (see
  // formatModelDispersion) rather than getting a separate column. NFC is
  // available whenever the template defines it (fields_enabled), but can
  // still be switched off per-show/per-date via the Colors panel's "Show
  // NFC column" toggle (cfg.show_nfc, default on) -- same show-default-
  // seeds-date-override cascade as every other Colors setting.
  const fields = (STATE.fields_enabled || []).filter(f => f !== 'dispersion' && (f !== 'nfc' || cfg.show_nfc !== false));

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
  const manualBreaksSet = new Set(section.hid_manual_breaks || []);
  const circuitSetFillMap = cfg.circuit_set_enabled
    ? assignCircuitSetColors(section.cabinets, cfg.circuit_set_colors, cfg.hid_bundle_size || 4, section.hid_cable_overrides, manualBreaksSet)
    : {};
  // Every bundle member's key -> that bundle's own first key (the identity
  // hid_cable_overrides/assignCircuitSetColors actually key off of) -- so
  // clicking the stripe on ANY row of a bundle, not just its first row,
  // can still target the right override entry. See renderCard's stripe
  // click handler below.
  const bundleOwnerKey = {};
  if (cfg.circuit_set_enabled) {
    hidBundleOrder(section.cabinets, cfg.hid_bundle_size || 4, manualBreaksSet).forEach(bundle => {
      bundle.forEach(k => { bundleOwnerKey[k] = bundle[0]; });
    });
  }

  // A completely separate grouping from the above -- circuit/trunk-cable
  // bundles are about how boxes are WIRED, pick groups are about how
  // they're physically stacked and hoisted (A1-A4, B1-B4, ...), and the
  // two don't have to line up even though they often happen to.
  const pickBreaksSet = new Set(section.pick_manual_breaks || []);
  const pickMergesSet = new Set(section.pick_manual_merges || []);
  const pickSize = resolvePickGroupSize(section, cfg);
  const pickInfo = cfg.pick_group_enabled
    ? computePickLabels(section.cabinets, pickSize, pickBreaksSet, pickMergesSet)
    : { labels: new Map(), groupStarts: new Set(), sizes: new Map() };
  // Optional per-pick name (e.g. "SL Cart"), keyed by the position of that
  // group's first box -- same stable-identity convention pick_manual_breaks/
  // pick_manual_merges use, since a group has no ID of its own (it's
  // recomputed fresh every render from the cabinets + breaks/merges/size).
  // Rendered sideways on the hang stripe (see makePickGroupNameLabel) so
  // naming a pick costs no extra vertical space in the box list; edited via
  // the same dropdown the split/merge actions already use (see
  // openPickGroupMenu), not inline here.
  const pickGroupNames = section.pick_group_names || {};
  // Every valid drop target row, collected as we build them below -- the
  // divider grip and pick name labels now sit visually on the hang-stripe
  // bar (see .pick-group-drag-handle/.pick-group-name-label in style.css),
  // which is a separate element off to the side of box-list, not an
  // ancestor/descendant of any box-row. A native dragover/drop only
  // reaches whatever DOM element is actually under the cursor -- and since
  // a name label now visually covers its WHOLE pick's height (not just its
  // own row), between the two of them they cover almost the entire stripe,
  // so this fallback isn't an edge case, it's most of a real drag. Hence
  // this list and the two helpers right below, which map the cursor's
  // clientY back to whichever collected row it's nearest to -- attached to
  // `bar` once after the loop AND to every name label as it's created (see
  // attachPickDropListeners), so the whole stripe behaves as one
  // continuous drop surface regardless of what's visually on top of it at
  // any given point.
  const pickDropTargets = [];
  // Every group-start's {row, cab, isNatural, canSplitMerge}, in hang
  // order, collected as labels are built below -- lets a rename field's
  // Tab/Shift+Tab (see openPickGroupMenu) jump straight to the next/
  // previous pick's own rename field instead of wherever plain tab order
  // would land. Same "still being filled in while later closures already
  // capture it, but nothing reads it until a real event fires after
  // render() returns" reasoning as pickDropTargets itself.
  const pickGroupList = [];
  const clearPickDragOver = () => pickDropTargets.forEach(t => {
    t.overlay.classList.remove('pick-drag-over');
    t.row.classList.remove('pick-drag-over');
  });
  const nearestPickDropTarget = clientY => {
    let best = null;
    let bestDist = Infinity;
    pickDropTargets.forEach(t => {
      const r = t.row.getBoundingClientRect();
      const dist = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      if (dist < bestDist) { bestDist = dist; best = t; }
    });
    return best;
  };
  // `pickDropTargets` is only fully populated once the loop below finishes,
  // but every listener attached here only ever READS it at event-fire time
  // (long after render() has returned), so defining/attaching these before
  // the loop is done is safe -- same reasoning as pickDragState itself
  // being read at call time, not definition time.
  const attachPickDropListeners = el => {
    el.addEventListener('dragover', ev => {
      if (!pickDragState || pickDragState.section !== section) return;
      ev.preventDefault();
      const target = nearestPickDropTarget(ev.clientY);
      clearPickDragOver();
      if (target) {
        target.overlay.classList.add('pick-drag-over');
        target.row.classList.add('pick-drag-over');
      }
    });
    el.addEventListener('dragleave', clearPickDragOver);
    el.addEventListener('drop', ev => {
      if (!pickDragState || pickDragState.section !== section) return;
      ev.preventDefault();
      clearPickDragOver();
      const target = nearestPickDropTarget(ev.clientY);
      if (!target) return;
      movePickBreak(section, pickBreaksSet, pickDragState.fromPos, target.cab.position, pickInfo.groupStarts.has(target.cab));
      pickDragState = null;
      render();
      saveState(false);
    });
  };

  section.cabinets.forEach((cab, i) => {
    const row = document.createElement('div');
    row.className = 'box-row';
    // The "new physical stack starts here" line has two halves now, kept
    // in sync via the same two class names (.pick-group-start solid,
    // .pick-drag-over dashed) on two different elements:
    //  - Across the TABLE: a plain border-top on `row` itself. A border
    //    always paints behind an element's own children automatically, no
    //    z-index needed -- this is what actually satisfies "underneath
    //    the fields," for free, with none of the stacking-context
    //    fragility a positioned overlay+negative-z-index would need (an
    //    earlier version tried exactly that, and it also had the side
    //    effect of trapping THIS row's own dropdown menus -- Hi-D/pick
    //    -group ones -- inside a local stacking context, letting a later
    //    sibling row paint over them instead of the dropdown floating
    //    above like it needs to).
    //  - Into the STRIPE: `dividerOverlay`, a small child of `row`
    //    positioned right:100% (flush at row's own left edge, same trick
    //    .pick-group-drag-handle/.pick-group-name-label use) extending
    //    left far enough to be clipped by .card's own overflow:hidden at
    //    the stripe's actual left edge, whatever that width happens to be.
    //    This half never overlaps any table content at all -- it's
    //    entirely to the left of `row`'s own box -- so it doesn't need any
    //    z-index/stacking consideration either.
    // Created for every row past the first whenever pick groups are on
    // (not just current group-starts) since ANY of them can become a drop
    // target's preview line during a drag; unset, both halves are
    // transparent and invisible.
    let dividerOverlay = null;
    if (cfg.pick_group_enabled && i > 0) {
      dividerOverlay = document.createElement('div');
      dividerOverlay.className = 'pick-group-divider-overlay';
      if (pickInfo.groupStarts.has(cab)) {
        dividerOverlay.classList.add('pick-group-start');
        row.classList.add('pick-group-start');
      }
      row.appendChild(dividerOverlay);
    }
    // A small grip on the divider itself -- click-and-drag it to any other
    // row to move the split there in one gesture (movePickBreak does the
    // same undo-old/establish-new edit openPickGroupMenu's single option
    // does, just at two positions instead of one). A direct child of
    // `row` (NOT dividerOverlay -- nesting it there would trap the grip's
    // own z-index inside dividerOverlay's z-index:-1 layer, hiding it
    // behind the row's fields same as the line itself). Skipped on paper
    // -- dragging means nothing on a printed page.
    if (cfg.pick_group_enabled && i > 0 && pickInfo.groupStarts.has(cab) && !isPrintMode()) {
      const grip = document.createElement('div');
      grip.className = 'pick-group-drag-handle';
      grip.title = 'Drag to move this pick split';
      grip.textContent = '⠿';
      grip.draggable = true;
      grip.addEventListener('click', ev => ev.stopPropagation());
      grip.addEventListener('dragstart', ev => {
        ev.stopPropagation();
        pickDragState = { section, fromPos: cab.position };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(cab.position));
      });
      grip.addEventListener('dragend', () => { pickDragState = null; });
      row.appendChild(grip);
    }
    // Every row past the first is a valid drop target for a dragged split
    // (dropping means "put the divider right above this box") -- gated on
    // pickDragState belonging to THIS section so a drag started on one
    // hang's card can't be dropped onto another's. Also collected into
    // pickDropTargets for the stripe-wide fallback attached after the loop
    // (see the comment on that array above) -- the cursor-over-the-table
    // case below still works the exact same way it always did.
    if (cfg.pick_group_enabled && i > 0 && !isPrintMode()) {
      pickDropTargets.push({ row, overlay: dividerOverlay, cab });
      row.addEventListener('dragover', ev => {
        if (!pickDragState || pickDragState.section !== section) return;
        ev.preventDefault();
        dividerOverlay.classList.add('pick-drag-over');
        row.classList.add('pick-drag-over');
      });
      row.addEventListener('dragleave', () => {
        dividerOverlay.classList.remove('pick-drag-over');
        row.classList.remove('pick-drag-over');
      });
      row.addEventListener('drop', ev => {
        if (!pickDragState || pickDragState.section !== section) return;
        ev.preventDefault();
        dividerOverlay.classList.remove('pick-drag-over');
        row.classList.remove('pick-drag-over');
        movePickBreak(section, pickBreaksSet, pickDragState.fromPos, cab.position, pickInfo.groupStarts.has(cab));
        pickDragState = null;
        render();
        saveState(false);
      });
    }
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
          setStripe.className = 'circuit-set-stripe circuit-set-stripe-editable';
          if (cfg.ink_friendly_patterns) setStripe.classList.add('ink-pattern-' + setEntry.patternIndex);
          setStripe.style.backgroundColor = argbToCss(setEntry.fill);
          // Every row of the bundle gets the same clickable chevron now
          // (not just its first row) -- clicking it on the bundle's own
          // first row opens the usual "which cable is this" picker;
          // clicking it anywhere else in the bundle offers to split a new
          // trunk cable off right there instead. One control, reused for
          // both jobs, rather than a second icon competing for space on
          // every row.
          const isOwnerRow = bundleOwnerKey[bundleKey] === bundleKey;
          const cableName = cfg.breakout_cable_name || 'Trunk Cable';
          setStripe.title = isOwnerRow
            ? `${cableName} #${setEntry.cableNumber} -- click to change cable or split`
            : `Part of ${cableName} #${setEntry.cableNumber} -- click to start a new one here`;
          // Always-visible affordance -- a plain color bar gives no hint
          // it's clickable (a static screenshot can't show a cursor or a
          // hover-only tooltip), so this small caret sits on the stripe
          // itself, in every render, not just on hover. Skipped on paper
          // -- "click here" means nothing on a printed page.
          if (!isPrintMode()) {
            const editIcon = document.createElement('span');
            editIcon.className = 'circuit-set-edit-icon';
            editIcon.textContent = '▾';
            setStripe.appendChild(editIcon);
          }
          setStripe.addEventListener('click', ev => {
            ev.stopPropagation();
            openTrunkStripeMenu(wrap, section, cfg, bundleKey, bundleOwnerKey[bundleKey], isOwnerRow, setEntry.cableNumber);
          });
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
        // Everything about pick groups lives on the hang stripe, NOT in
        // this table -- no badge, no button, nothing under the Cab #
        // chip. A group-start box (i===0, or any later natural/manual
        // split) gets a label on the stripe instead (see
        // makePickGroupNameLabel): the custom name if one's set, else
        // just the pick's own letter (A, B, C, ...) so a box's pick is
        // still identifiable even unnamed. Clicking anywhere on that
        // label opens rename/merge for the pick -- every pick-group
        // action stays confined to the stripe, never the table.
        if (cfg.pick_group_enabled && pickInfo.groupStarts.has(cab)) {
          const pickLabel = pickInfo.labels.get(cab);
          const isManualBreak = i > 0 && pickBreaksSet.has(cab.position);
          const isNatural = i > 0 && !isManualBreak;
          // pickLabel is always "<letter>1" for a group-start box (pi===0
          // in computePickLabels) -- stripping that trailing "1" gets
          // just the letter, the fallback shown when no custom name is set.
          const defaultLabel = pickLabel.slice(0, -1);
          const groupCabs = section.cabinets.slice(i, i + pickInfo.sizes.get(cab));
          pickGroupList.push({ row, cab: groupCabs[0], isNatural, canSplitMerge: i > 0, defaultLabel });
          const navIndex = pickGroupList.length - 1;
          const nameLabel = makePickGroupNameLabel(
            section, groupCabs, pickGroupNames[cab.position] || defaultLabel, row, isNatural, i > 0, pickGroupList, navIndex, defaultLabel
          );
          if (nameLabel) {
            row.appendChild(nameLabel);
            // This label visually covers its whole pick's height, most of
            // which belongs to OTHER rows than the one it's actually a
            // DOM child of -- without its own listeners, a drag hovering
            // over any of that (i.e. most of a real drag) would bubble to
            // THIS row alone, never reaching whichever row the cursor is
            // actually over. See attachPickDropListeners' own comment.
            if (cfg.pick_group_enabled && !isPrintMode()) attachPickDropListeners(nameLabel);
          }
        }
      } else if (f === 'model') {
        const wrap = document.createElement('div');
        wrap.className = 'model-cell-wrap';
        const faceIcon = cfg.show_speaker_icons ? SPEAKER_FACE_ICONS[cab.model] : null;
        if (faceIcon) {
          const img = document.createElement('img');
          img.className = 'speaker-face-icon';
          img.src = faceIcon;
          img.alt = '';
          wrap.appendChild(img);
        }
        wrap.appendChild(makeChip(formatModelDispersion(cab)));
        cell.appendChild(wrap);
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
        // No chip at all when there's no value, rather than an empty pill
        // with nothing in it -- most boxes don't carry an NFC tag, so an
        // empty pill on every one of those rows read as visual noise.
        if (cab.nfc) cell.appendChild(makeChip(cab.nfc));
      } else {
        cell.appendChild(makeChip(cab[f] !== undefined ? cab[f] : ''));
      }
      row.appendChild(cell);
    });
    boxList.appendChild(row);
  });

  // Blank stripe background (not covered by any name label) still needs
  // its own fallback -- see attachPickDropListeners/pickDropTargets'
  // comment above for why. Every name label already got the same
  // listeners individually as it was created, above.
  if (cfg.pick_group_enabled && !isPrintMode() && pickDropTargets.length) attachPickDropListeners(bar);

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
      const unitFormat = resolveTrimUnitFormat();
      const inchesPrecision = resolveTrimInchesPrecision();
      const printing = isPrintMode();
      const rawVal = typeof val === 'number' ? val : parseFloat(val);
      const trueSpan = document.createElement('span');
      trueSpan.textContent = formatTrimValue(trueTrimValue(rawVal, burnFt), unitFormat, inchesPrecision);
      v.appendChild(trueSpan);
      if (burnFt) {
        v.appendChild(document.createTextNode(' | '));
        const burntSpan = document.createElement('span');
        burntSpan.className = 'trim-burnt-value';
        const burntFormatted = formatTrimValue(rawVal, unitFormat, inchesPrecision);
        burntSpan.textContent = printing ? `${burntFormatted} +${burnFt}ft` : `${burntFormatted} \u{1F525}`;
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
  // Free text from the Hang Define popover -- deliberately not a
  // .meta-row (label/value pair): fixupMetaChipLayout pairs up .meta-row
  // elements two-at-a-time for the 2-column print grid, and a
  // could-be-long note has no business being forced into that pairing
  // (same reason meta-show-all-btn isn't a .meta-row either). Only shown
  // once there's actually something to show.
  if (section.notes && section.notes.trim()) {
    const notesRow = document.createElement('div');
    notesRow.className = 'meta-notes-row';
    const notesLabel = document.createElement('div');
    notesLabel.className = 'meta-notes-label';
    notesLabel.textContent = 'Notes';
    const notesValue = document.createElement('div');
    notesValue.className = 'meta-notes-value';
    notesValue.textContent = section.notes;
    notesRow.appendChild(notesLabel);
    notesRow.appendChild(notesValue);
    meta.appendChild(notesRow);
  }
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
    row.appendChild(swatchLabel(label));
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
  [[null, 'Default'], ...DATA_BAR_MODE_OPTIONS].forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'dataBarMode';
    radio.checked = current === value;
    radio.addEventListener('change', () => setDataBarModeOverride(value));
    row.appendChild(radio);
    row.appendChild(swatchLabel(label));
    panel.appendChild(row);
  });
}

// This Date's own Trim display-format override, on top of the Show's
// standing default (set from the Show page -- see static/show.js).
// "Default" clears the override, falling back to the Show default (then
// plain decimal feet if the Show hasn't set one either). No per-hang
// level for this -- see resolveTrimUnitFormat.
function renderTrimUnitsPanel() {
  const panel = document.getElementById('trimUnitsPanel');
  panel.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'panel-note';
  const showFormat = SHOW_META && SHOW_META.trim_unit_format === 'feet_inches' ? 'feet & inches' : 'decimal feet';
  note.textContent = `Overrides the show-wide default (currently ${showFormat}) for this date only. Set the show-wide default from the show page.`;
  panel.appendChild(note);

  const currentFormat = STATE && TRIM_UNIT_FORMATS.includes(STATE.trim_unit_format_override) ? STATE.trim_unit_format_override : null;
  [[null, 'Default'], ...TRIM_UNIT_FORMAT_OPTIONS].forEach(([value, label]) => {
    const row = document.createElement('label');
    row.className = 'swatchRow';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'trimUnitFormat';
    radio.checked = currentFormat === value;
    radio.addEventListener('change', () => setTrimUnitFormatOverride(value));
    row.appendChild(radio);
    row.appendChild(swatchLabel(label));
    panel.appendChild(row);
  });

  // Only relevant once the EFFECTIVE format (this Date's override, else
  // the Show default) actually resolves to feet_inches -- no point asking
  // "round inches to what?" while decimal feet is what's showing.
  if (resolveTrimUnitFormat() === 'feet_inches') {
    const precisionLabel = document.createElement('div');
    precisionLabel.className = 'panel-label';
    precisionLabel.textContent = 'Round inches to:';
    panel.appendChild(precisionLabel);
    const currentPrecision = STATE && TRIM_INCHES_PRECISIONS.includes(STATE.trim_inches_precision_override) ? STATE.trim_inches_precision_override : null;
    [[null, 'Default'], ...TRIM_INCHES_PRECISION_OPTIONS].forEach(([value, label]) => {
      const row = document.createElement('label');
      row.className = 'swatchRow';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'trimInchesPrecision';
      radio.checked = currentPrecision === value;
      radio.addEventListener('change', () => setTrimInchesPrecisionOverride(value));
      row.appendChild(radio);
      row.appendChild(swatchLabel(label));
      panel.appendChild(row);
    });
  }
}

function setTrimUnitFormatOverride(value) {
  STATE.trim_unit_format_override = value;
  render();
  saveState(false);
}

function setTrimInchesPrecisionOverride(value) {
  STATE.trim_inches_precision_override = value;
  render();
  saveState(false);
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

// Rendered from the shared field list in config-fields.js (FLAT_FIELD_GROUPS
// .colors), the same one show.js's renderConfigColorsOptions uses for the
// Show-wide default -- so a field added there exists here too.
function renderColorPanel() {
  const panel = document.getElementById('colorPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable', ink_friendly_patterns:false});
  panel.innerHTML = '';
  appendResetToShowDefaultButton(panel);
  const fieldsContainer = document.createElement('div');
  panel.appendChild(fieldsContainer);
  renderFlatFieldList(fieldsContainer, FLAT_FIELD_GROUPS.colors, cfg, () => { render(); saveState(false); });
}

// Brand-agnostic circuit breakout numbering lives in its own panel/button,
// separate from circuit/hang colors -- it's a physical-hardware convention
// (which brand's breakout cable you're plugging into), not a visual one.
// Rendered from the shared field list in config-fields.js (FLAT_FIELD_GROUPS
// .numbering), the same one show.js's renderConfigNumberingOptions uses for
// the Show-wide default -- so "Label CKT as"/"Default leg order" can't go
// missing from one surface again. The afterChange hook below reproduces
// this page's own live behavior (actually converting STATE.sections'
// circuit-number text), which show.js has no sections to do.
function renderNumberingPanel() {
  const panel = document.getElementById('numberingPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable', ink_friendly_patterns:false});
  panel.innerHTML = '';
  appendResetToShowDefaultButton(panel);

  const intro = document.createElement('div');
  intro.textContent = 'Circuit breakout numbering (which brand of breakout cable this rig uses):';
  panel.appendChild(intro);

  const fieldsContainer = document.createElement('div');
  panel.appendChild(fieldsContainer);
  renderFlatFieldList(fieldsContainer, FLAT_FIELD_GROUPS.numbering, cfg, (key, cfg) => {
    if (key === 'numbering_mode') {
      if (cfg.numbering_mode === 'hid') applyHiDNumbering(STATE.sections, cfg.hid_bundle_size || 4);
      else restoreNormalNumbering(STATE.sections);
    } else if (key === 'hid_bundle_size' && cfg.numbering_mode === 'hid') {
      applyHiDNumbering(STATE.sections, cfg.hid_bundle_size);
    } else if (key === 'hid_reverse_order_default') {
      // Only re-numbers hangs actually following the default -- any hang
      // with its own explicit Descending checkbox state keeps that,
      // resolveHidReverseOrder sorts out which is which per section.
      applyHiDNumbering(STATE.sections, cfg.hid_bundle_size || 4);
    }
    render();
    saveState(false);
  });
}

// A completely separate concept from the numbering panel above -- this is
// about how boxes get physically stacked and hoisted (A1-A4, B1-B4, ...),
// not how they're circuited. Lives in the same circuit_color_config blob
// purely so it rides along with the existing show/date default-cascade
// and "reset to show default" machinery for free, same reasoning as
// breakout numbering sharing that panel/config with circuit colors.
// Rendered from FLAT_FIELD_GROUPS.pickGroups, shared with show.js's
// renderConfigPickGroupsOptions.
function renderPickGroupsPanel() {
  const panel = document.getElementById('pickGroupsPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable', ink_friendly_patterns:false});
  panel.innerHTML = '';
  appendResetToShowDefaultButton(panel);

  const intro = document.createElement('div');
  intro.textContent = 'Physical pick groups -- badges the boxes in one hoisted stack A1, A2, ... B1, B2, ..., from the top of each stack down:';
  panel.appendChild(intro);

  const fieldsContainer = document.createElement('div');
  panel.appendChild(fieldsContainer);
  renderFlatFieldList(fieldsContainer, FLAT_FIELD_GROUPS.pickGroups, cfg, () => { render(); saveState(false); });
}

async function saveState(showStatus) {
  if (!STATE) return;
  const res = await fetch(`${API_BASE}/state`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
  if (showStatus !== false) {
    if (res.ok) flashStatus('Saved');
    else flashStatus('Save failed');
  }
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

// "YY.MM.DD - Show - Venue - Rev N - Mobile" -- venue and Rev N are each
// dropped entirely (not left as a dangling "- -") rather than shown blank,
// venue when it hasn't been filled in yet and Rev N when this Date's never
// had a real file uploaded (STATE.upload_revision still at its 0 default).
// Rev N (see upload_revision in app.py's build_job/api_upload, bumped once
// per file actually uploaded into this Date, same server value the Excel
// export's own filename uses) is what actually answers the "which seed
// file made this PDF" question when two exports otherwise share an
// identical show/venue/date -- suffix is this specific export flavor
// (e.g. "Mobile"), passed in by whichever export function is calling.
function buildExportFilename(suffix) {
  const pageHeader = (STATE && STATE.page_header) || {};
  const parts = [
    formatDateForFilename(pageHeader.date),
    sanitizeFilenamePart(pageHeader.title) || 'Untitled show',
  ];
  const venue = sanitizeFilenamePart(pageHeader.venue);
  if (venue) parts.push(venue);
  if (STATE && STATE.upload_revision) parts.push(`Rev ${STATE.upload_revision}`);
  if (suffix) parts.push(suffix);
  return parts.join(' - ');
}

function runPrint(modeClass, pageCss, gridColumns, fitPage, filenameSuffix) {
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
  // Forces the browser to actually resolve the new @page rule into its
  // CSSOM synchronously, right now -- same "don't trust an async gap that
  // doesn't exist" precaution fitContentToPage already takes for zoom (see
  // its own comment below), just applied to the stylesheet mutation above
  // instead of a layout one. Belt-and-suspenders: setting textContent on
  // an inline <style> is spec'd to apply synchronously with no real gap,
  // but this project's print exports have repeatedly hit Chrome quirks
  // that didn't show up until tested for real (see the print-export
  // debugging notes) -- cheap enough to keep even if it turns out not to
  // be the missing piece.
  void document.getElementById('printPageStyle').sheet;
  if (fitPage) fitContentToPage(fitPage.widthIn, fitPage.heightIn, fitPage.marginMm);
  // Chrome's "Save as PDF" print destination uses document.title as the
  // suggested filename -- there's no other hook into that dialog from a
  // page triggering window.print() itself, so this is the only way to
  // get a meaningful name on the saved file instead of the page's fixed
  // "Pinning Sheet Editor" title.
  const prevTitle = document.title;
  document.title = buildExportFilename(filenameSuffix);
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
    '1fr',
    undefined,
    'Mobile'
  );
}

// Same identity a hang keeps across PDF revisions, for reconcileUploaded
// Sections below -- lowercased/trimmed/whitespace-collapsed, and with the
// same "(Pair)" suffix formatHangTitle already strips for display, so a
// sim export's own inconsistent capitalization/spacing doesn't break the
// match on its own.
function normalizeHangIdentity(header) {
  return (header || '').replace(PAIR_SUFFIX_RE, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Whether some saved Hang Profile already answers to a given (normalized)
// hang name -- checked against the profile's own `name` first, then its
// learned `aliases` (see the match-confirmation dialog below, and the
// aliases endpoint in app.py). Used both for the upload-time suggestion and
// to decide whether confirming a match there needs to POST a new alias at
// all, or already knows this name.
function findHangProfileMatch(key) {
  const byName = HANG_PROFILES.find(p => normalizeHangIdentity(p.name) === key);
  if (byName) return { profile: byName, reason: 'name' };
  const byAlias = HANG_PROFILES.find(p => (p.aliases || []).some(a => normalizeHangIdentity(a) === key));
  if (byAlias) return { profile: byAlias, reason: 'alias' };
  return null;
}

// Every per-hang setting that isn't parsed straight from the file --
// carried forward by reconcileUploadedSections when a re-uploaded hang's
// name matches one that already had it dialed in. Anything NOT in this
// list (cabinets, splay, metadata, hanging_mode, ...) is exactly what a
// revision is FOR, so it always comes from the fresh parse instead.
const HANG_CARRY_FORWARD_FIELDS = [
  'hang_profile_id', 'hang_profile_version', 'hid_reverse_order',
  'hid_manual_breaks', 'hid_cable_overrides', 'tape_burn_ft', 'hang_color',
  'hidden_tags_overrides', 'apply_manual_circuiting', 'manual_circuit_pattern',
  'notes', 'pick_manual_breaks', 'pick_manual_merges', 'pick_group_size', 'pick_group_names',
];

// build_job (app.py) always rebuilds `sections` from scratch on upload,
// with none of the customization a previous file's hangs had -- this
// reconnects it by hang name so a revised PDF doesn't force redoing every
// Hang Profile link, trunk split, cable override, tape burn, etc. by hand.
// Old sections sharing one hang's name are consumed in the order they
// appear, so if a name repeats (two hangs both called "SUB"), the Nth new
// occurrence matches the Nth old one rather than every new one grabbing
// the same old section. A hang with no old-section match at all (new to
// this Date, or renamed since the last upload) is left for the caller --
// see the returned `unresolved` list and maybeShowHangProfileMatchDialog --
// rather than silently auto-linking a Hang Profile here, so the SE gets a
// chance to see and confirm/change the guess instead of it happening
// invisibly.
function reconcileUploadedSections(oldSections, newSections) {
  const cfg = STATE.circuit_color_config;
  const bundleSize = (cfg && cfg.hid_bundle_size) || 4;
  const oldByName = {};
  (oldSections || []).forEach(s => {
    const key = normalizeHangIdentity(s.header);
    (oldByName[key] = oldByName[key] || []).push(s);
  });

  const unresolved = [];
  (newSections || []).forEach(newSection => {
    const key = normalizeHangIdentity(newSection.header);
    const pool = oldByName[key];
    const oldMatch = pool && pool.length ? pool.shift() : null;
    if (oldMatch) {
      HANG_CARRY_FORWARD_FIELDS.forEach(f => {
        if (oldMatch[f] !== undefined) newSection[f] = oldMatch[f];
      });
      // Cabinets are all fresh from this upload's parse, so whatever
      // numbering was carried forward above has to be re-derived onto
      // them -- same order applyHangProfileToSection uses (manual
      // circuiting fully replaces the numbers and wins outright, Hi-D
      // only applies when the show isn't already in manual mode).
      if (newSection.apply_manual_circuiting && (newSection.manual_circuit_pattern || []).length) {
        applyManualCircuitPattern(newSection);
      } else if (cfg && cfg.numbering_mode === 'hid') {
        applyHiDNumbering([newSection], bundleSize);
      }
    } else {
      // Brand-new hang, nothing carried forward -- still has to pick up the
      // show/date's own Hi-D default (reverse leg order included, via
      // resolveHidReverseOrder) so the sheet isn't left unnumbered while the
      // SE decides on a Hang Profile in the dialog. A profile applied there
      // afterward re-derives this anyway if it changes anything.
      if (cfg && cfg.numbering_mode === 'hid') {
        applyHiDNumbering([newSection], bundleSize);
      }
      unresolved.push(newSection);
    }
  });
  return { sections: newSections, unresolved };
}

async function uploadFile(file) {
  flashStatus('Uploading...');
  const oldSections = STATE.sections || [];
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
  // The server always saves a freshly-rebuilt, un-merged `sections` (see
  // build_job in app.py) -- reconcile by hang name against what was on
  // screen before this upload, then save that merge back over it so a
  // reload doesn't lose it again.
  const { unresolved } = reconcileUploadedSections(oldSections, STATE.sections || []);
  render();
  saveState(false);
  flashStatus('Loaded ' + file.name);
  maybeShowHangProfileMatchDialog(unresolved);
}

// Teaches a Hang Profile one more pinning-sheet name it should be suggested
// for next time (see findHangProfileMatch) -- fire-and-await from the match
// dialog's Confirm handler, never from anywhere version-sensitive, since
// this deliberately does NOT bump the profile's version (see app.py).
async function addHangProfileAlias(profileId, name) {
  try {
    const res = await fetch('/api/hang-profiles/' + encodeURIComponent(profileId) + '/aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null; // best-effort -- worst case, this same hang gets asked again next upload
  }
}

// Called from every place a Hang Profile actually gets linked to a hang --
// not just the upload match-confirmation dialog below, but also the Hang
// Define popover's "Apply a profile..." and "Save as new profile..."
// controls (renderHangDefinePopover/renderSaveHangProfileForm), since
// that's how most profiles get attached to a hang in the first place. Without
// this, a profile only ever auto-suggests on some later, different Date if
// its typed name happens to exactly equal that sheet's parsed hang name --
// which is exactly the gap that left the association not carrying between
// event days of the same show.
async function ensureHangProfileKnowsSection(profile, section) {
  const key = normalizeHangIdentity(section.section_name || section.header);
  const alreadyKnown = normalizeHangIdentity(profile.name) === key
    || (profile.aliases || []).some(a => normalizeHangIdentity(a) === key);
  if (alreadyKnown) return;
  const updated = await addHangProfileAlias(profile.id, section.section_name || section.header);
  if (updated) {
    const idx = HANG_PROFILES.findIndex(p => p.id === updated.id);
    if (idx !== -1) HANG_PROFILES[idx] = updated;
    profile.aliases = updated.aliases;
  }
}

// Entry point from uploadFile: of the hangs this upload couldn't carry
// forward from an old section (brand new to this Date, or renamed), figures
// out which ones a saved Hang Profile would be suggested for. If nothing
// matched anything, there's nothing to confirm -- stay silent rather than
// popping a dialog full of "No profile" rows on every routine first upload.
function maybeShowHangProfileMatchDialog(sections) {
  const rows = (sections || []).map(section => {
    // section_name (no "N. " ordinal prefix, unlike header) is what a saved
    // profile's name/aliases actually get compared against -- a profile
    // named "16 Sub - Start Brown" means that regardless of which position
    // it lands in on a given file, not only when it happens to be hang #16.
    const key = normalizeHangIdentity(section.section_name || section.header);
    const match = findHangProfileMatch(key);
    return { section, key, suggested: match ? match.profile : null };
  });
  if (!rows.some(r => r.suggested)) return;
  renderHangProfileMatchDialog(rows);
}

// The confirmation dialog itself -- one row per unresolved hang, each with a
// dropdown defaulted to its suggested profile (or "No profile" if nothing
// matched, so the SE can still assign one by hand while they're here).
// Built entirely in JS (like showNextHangProfileMismatch's banner) rather
// than templated into index.html, since it only ever needs to exist while
// open. Reuses the .modal-backdrop/.modal-box/.modal-header/.modal-body/
// .modal-footer shell show.js's Configure Show modal already established,
// so it looks and behaves the same without new base CSS.
function renderHangProfileMatchDialog(rows) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box hang-match-modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  backdrop.appendChild(box);

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = 'Hang Profile matches';
  header.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  box.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const list = document.createElement('div');
  list.className = 'hang-match-list';
  body.appendChild(list);
  box.appendChild(body);

  const intro = document.createElement('p');
  intro.className = 'hang-match-intro';
  intro.textContent = 'These hangs are new to this Date. Confirm, change, or clear the Hang Profile each one should use.';
  list.appendChild(intro);

  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'hang-match-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'hang-match-name';
    nameEl.textContent = row.section.section_name || row.section.header;
    rowEl.appendChild(nameEl);

    const select = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'No profile';
    select.appendChild(noneOpt);
    HANG_PROFILES.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    select.value = row.suggested ? row.suggested.id : '';
    row.select = select;
    rowEl.appendChild(select);

    list.appendChild(rowEl);
  });

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  footer.appendChild(cancelBtn);
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const aliasWork = [];
    rows.forEach(row => {
      const profile = HANG_PROFILES.find(p => p.id === row.select.value);
      if (!profile) return;
      applyHangProfileToSection(row.section, profile);
      aliasWork.push(ensureHangProfileKnowsSection(profile, row.section));
    });
    await Promise.all(aliasWork);
    close();
    render();
    saveState(false);
  });
  footer.appendChild(confirmBtn);
  box.appendChild(footer);

  function close() {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(backdrop);
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
  const alwaysEnabled = ['printGridBtn', 'printMobileBtn', 'printMobileBtnVO', 'colorToggleBtn', 'numberingToggleBtn', 'pickGroupsToggleBtn', 'dataTagsToggleBtn', 'dataTagsToggleBtnVO', 'pageDesignToggleBtn', 'advancedToggleBtn', 'menuToggleBtn', 'menuCloseBtn', 'authLockBtn', 'sidebarToggleTab'];
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
// Address also supports plain manual typing/editing via this same path
// (in case a search result needs correcting, or the venue never shows up
// in search at all) -- picking a search result below is just a second,
// faster way to fill it in, not the only way.
bindShowField('showAddressInput', 'address');

const VENUE_SEARCH_MIN_QUERY_LEN = 3;
// Explicit submit (Enter or the button), not search-as-you-type -- OSM's
// Nominatim (which /api/venue-search proxies, see app.py) explicitly
// disallows client-side autocomplete in its usage policy, and this is a
// deliberate on-demand search either way.
function openVenueSearch() {
  const wrap = document.querySelector('.show-venue-search-wrap');
  const existing = wrap.querySelector('.venue-search-dropdown');
  if (existing) { existing.remove(); return; }
  const query = document.getElementById('showVenueInput').value.trim();
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
      // second search fired) by the time this resolves -- nothing left
      // to fill in.
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
          selectVenueResult(result);
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
// Sets STATE directly (not by dispatching a synthetic 'change' event) --
// bindShowField's own listener only fires from real user interaction with
// the input, so a programmatic .value assignment wouldn't reach it. This
// mirrors exactly what that listener does, just for both fields in one
// save instead of one field per blur.
function selectVenueResult(result) {
  if (!STATE) return;
  STATE.page_header = STATE.page_header || {};
  STATE.page_header.venue = result.name;
  STATE.page_header.address = result.address_short || '';
  document.getElementById('showVenueInput').value = result.name;
  document.getElementById('showAddressInput').value = result.address_short || '';
  saveState(false);
}
document.getElementById('venueSearchBtn').addEventListener('click', openVenueSearch);
document.getElementById('showVenueInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); openVenueSearch(); }
});
document.getElementById('saveBtn').addEventListener('click', () => saveState(true));
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
const PAGE_DESIGN_SUBPANEL_IDS = ['dataTagsPanel', 'numberingPanel', 'colorPanel', 'pickGroupsPanel', 'dataBarPanel', 'trimUnitsPanel', 'advancedPanel'];
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
document.getElementById('pickGroupsToggleBtn').addEventListener('click', () => toggleSubpanel('pickGroupsPanel'));
document.getElementById('dataBarToggleBtn').addEventListener('click', () => toggleSubpanel('dataBarPanel'));
document.getElementById('trimUnitsToggleBtn').addEventListener('click', () => toggleSubpanel('trimUnitsPanel'));
document.getElementById('advancedToggleBtn').addEventListener('click', () => toggleSubpanel('advancedPanel'));
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
  pickGroupsPanel: '#pickGroupsToggleBtn',
  dataBarPanel: '#dataBarToggleBtn',
  trimUnitsPanel: '#trimUnitsToggleBtn',
  advancedPanel: '#advancedToggleBtn',
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
// Same click-outside-to-close approach for the trunk-stripe menu (see
// openTrunkStripeMenu) -- it isn't tracked by a module-scoped variable
// like the popover above since it doesn't need to survive a render() (no
// field inside it triggers one until an option is actually picked), so
// this just closes whatever instance happens to be open in the DOM.
document.addEventListener('click', e => {
  if (e.target.closest('.hid-cable-dropdown, .circuit-set-stripe-editable, .pick-group-name-label-editable')) return;
  const open = document.querySelector('.hid-cable-dropdown');
  if (open) open.remove();
});
// Own listener, own class -- deliberately not folded into the one above,
// which assumes only one .hid-cable-dropdown exists at a time (a single
// document.querySelector). Keeping these independent means the two
// dropdowns can never accidentally close each other.
document.addEventListener('click', e => {
  if (e.target.closest('.venue-search-dropdown, #venueSearchBtn, #showVenueInput')) return;
  const open = document.querySelector('.venue-search-dropdown');
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

// --- Advanced: face-pill design tuner ----------------------------------
// Live knobs for the --face-* CSS variables (style.css, near
// .model-cell-wrap) so the CO12-style overlay pill/text-stroke can be
// dialed in without editing CSS and reloading. Lives in the Page design
// menu's "Advanced" flyout (#advancedPanel, index.html) rather than always
// on screen -- it's still a per-browser preview tool, not a per-show
// setting (nothing here is saved to STATE/job.json), just tucked away
// instead of floating over the page by default. The --face-* defaults in
// style.css match the settings below, so deleting this IIFE later leaves
// the look unchanged.
(function initFaceDesignTuner() {
  function hexToRgba(hex, alphaPct) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${(alphaPct / 100).toFixed(2)})`;
  }

  const root = document.documentElement;

  const state = {
    pillColor: '#ffffff',
    pillOpacity: 0,
    fontSize: 124,
    fontWeight: 600,
    invertIcon: false,
    borderColor: '#000000',
    borderOpacity: 0,
    borderWidth: 1,
  };

  let out;
  function apply() {
    root.style.setProperty('--face-pill-bg', hexToRgba(state.pillColor, state.pillOpacity));
    // A single unitless scale, not a baked px snapshot -- style.css derives
    // font-size from this via calc() against rem/--md-type-body-sm, so it
    // stays proportional to the type scale instead of freezing whatever
    // --md-type-body-sm resolved to right now. Padding is NOT driven from
    // here -- style.css's --face-pill-padding is in em, relative to the
    // font-size this produces, so the pill conforms to the chosen font
    // size on its own rather than being sized independently of it.
    root.style.setProperty('--face-pill-scale', (state.fontSize / 100).toFixed(3));
    // A heavier weight is legible over the honeycomb art on its own --
    // the font's own hinting handles the letterforms/spacing at that
    // weight, no artificial outline or letter-spacing override needed.
    root.style.setProperty('--face-pill-font-weight', state.fontWeight);
    // Removed (not set to 0) when unchecked, so it falls back to
    // :root.theme-dark's own automatic rule in style.css instead of
    // pinning it to "never invert" -- this checkbox is only for
    // previewing the inverted look on demand, not overriding the theme.
    if (state.invertIcon) root.style.setProperty('--face-icon-invert', '1');
    else root.style.removeProperty('--face-icon-invert');
    // Opacity 0 collapses to 'none' rather than a technically-invisible
    // 0-alpha border, so a 0-width layout box never gets reserved for a
    // border nobody asked to see.
    root.style.setProperty('--face-pill-border', state.borderOpacity > 0
      ? `${state.borderWidth}px solid ${hexToRgba(state.borderColor, state.borderOpacity)}`
      : 'none');
    if (out) out.textContent = JSON.stringify(state, null, 2);
  }

  function row(label, input) {
    const r = document.createElement('label');
    r.className = 'swatchRow';
    r.style.justifyContent = 'space-between';
    const span = document.createElement('span');
    span.textContent = label;
    r.appendChild(span);
    r.appendChild(input);
    return r;
  }
  function colorInput(key) {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = state[key];
    inp.addEventListener('input', () => { state[key] = inp.value; apply(); });
    return inp;
  }
  function rangeInput(key, min, max, step) {
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = state[key];
    inp.style.width = '110px';
    inp.addEventListener('input', () => { state[key] = parseFloat(inp.value); apply(); });
    return inp;
  }
  function checkboxInput(key) {
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = state[key];
    inp.addEventListener('change', () => { state[key] = inp.checked; apply(); });
    return inp;
  }

  const panel = document.getElementById('advancedPanel');
  if (!panel) return;

  const title = document.createElement('div');
  title.className = 'panel-label';
  title.textContent = 'Face pill tuner';
  panel.appendChild(title);

  panel.appendChild(row('Pill color', colorInput('pillColor')));
  panel.appendChild(row('Pill opacity', rangeInput('pillOpacity', 0, 100, 1)));
  panel.appendChild(row('Font size', rangeInput('fontSize', 40, 150, 1)));
  function divider() {
    const hr = document.createElement('div');
    hr.style.cssText = 'border-top:1px solid var(--md-color-outline-variant); margin:8px 0;';
    return hr;
  }
  panel.appendChild(divider());
  panel.appendChild(row('Font weight', rangeInput('fontWeight', 100, 900, 100)));
  panel.appendChild(divider());
  panel.appendChild(row('Preview inverted', checkboxInput('invertIcon')));
  panel.appendChild(divider());
  panel.appendChild(row('Border color', colorInput('borderColor')));
  panel.appendChild(row('Border opacity', rangeInput('borderOpacity', 0, 100, 1)));
  panel.appendChild(row('Border width', rangeInput('borderWidth', 1, 4, 1)));

  out = document.createElement('pre');
  out.style.cssText = 'margin-top:8px; font-size:10px; background:var(--md-color-surface-variant); color:var(--md-color-on-surface-variant); padding:6px; border-radius:var(--md-shape-xs); max-height:110px; overflow:auto; white-space:pre-wrap;';
  panel.appendChild(out);

  apply();
})();
