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
    if (!(ckt in map)) map[ckt] = palette[Object.keys(map).length % palette.length];
  });
  return map;
}

function assignCircuitSetColors(cabinets, palette, cycleLength) {
  const assignment = {};
  if (!palette || !palette.length) return assignment;
  const cl = Math.max(1, cycleLength || 1);
  const seenOrder = [];
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
  cabinets.forEach(cab => {
    const ckt = cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt;
    if (!(ckt in assignment)) {
      seenOrder.push(ckt);
      const setIndex = Math.floor((seenOrder.length - 1) / cl);
      assignment[ckt] = palette[setIndex % palette.length];
    }
  });
  return assignment;
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
function applyHiDNumbering(sections, bundleSize) {
  const bs = Math.max(1, bundleSize || 4);
  (sections || []).forEach(section => {
    const cabinets = section.cabinets || [];
    cabinets.forEach(c => { if (c._normalCkt === undefined) c._normalCkt = c.ckt; });

    const distinctOrder = [];
    const seen = new Set();
    cabinets.forEach(c => {
      const orig = c._normalCkt;
      if (orig && !seen.has(orig)) { seen.add(orig); distinctOrder.push(orig); }
    });

    const mapping = {};
    distinctOrder.forEach((label, idx) => {
      const posInBundle = idx % bs;
      mapping[label] = String(bs - posInBundle);
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
  for (const entry of (hangColors || [])) {
    const match = (entry.match || '').toLowerCase();
    if (match && lower.includes(match)) return entry.fill;
  }
  return null;
}

function render() {
  // Belt-and-suspenders alongside PRINT_IN_PROGRESS (see its own comment
  // for the individual listeners that check it) -- this is the backstop
  // for any render()-triggering path that flag *hasn't* been threaded
  // through, known or not yet discovered. A PDF export sets its own
  // "print-mode-*" class on body for its entire duration (see runPrint),
  // so as long as that's present, render() has no business touching the
  // grid at all -- whatever called it, it would be overwriting the
  // export's own column count/content with the on-screen version,
  // corrupting the very layout the browser is mid-paginating.
  if (document.body.classList.contains('print-mode-grid') || document.body.classList.contains('print-mode-mobile')) return;
  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('emptyState');

  if (!STATE) {
    grid.style.display = 'none';
    emptyState.style.display = 'block';
    document.getElementById('colorPanel').innerHTML = '';
    document.getElementById('numberingPanel').innerHTML = '';
    document.getElementById('dataTagsPanel').innerHTML = '';
    document.getElementById('dataBarPanel').innerHTML = '';
    applyViewOnlyLock();
    return;
  }
  document.getElementById('cardsPerRow').value = STATE.cards_per_row;
  document.getElementById('stripPairLabelsInput').checked = !!STATE.strip_pair_labels;
  const viewMode = STATE.view_mode === 'tabs' ? 'tabs' : 'grid';
  document.querySelectorAll('#viewModeToggle .view-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === viewMode);
  });
  // Cards-per-row only means anything when every hang is laid out at
  // once -- Tabs view showing a single hang has no use for it, but the
  // All tab (see renderHangTabs) lays out every hang just like Grid view,
  // so it needs the field back.
  document.getElementById('cardsPerRowField').style.display = (viewMode === 'tabs' && activeHangIndex !== 'all') ? 'none' : '';
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
  const printMetaBits = [pageHeader.venue, pageHeader.date].filter(Boolean).join(' • ');
  if (printMetaBits) {
    const m = document.createElement('div');
    m.className = 'ph-meta';
    m.textContent = printMetaBits;
    printHeader.appendChild(m);
  }

  // Only ever visible for view-only + mobile (see body.view-only rules in
  // style.css) -- same title/venue/date as printHeader above, just shown
  // on screen instead of only when printing.
  document.getElementById('voTitle').textContent = pageHeader.title || '';
  document.getElementById('voMeta').textContent = printMetaBits;

  // A brand new Date (created but nothing uploaded to it yet) has a job
  // with sections: [] -- same empty-state prompt as no job at all, rather
  // than an empty grid with no cards and no explanation.
  const hasSections = STATE.sections && STATE.sections.length > 0;
  grid.style.display = hasSections ? 'grid' : 'none';
  emptyState.style.display = hasSections ? 'none' : 'block';
  grid.innerHTML = '';

  const hangTabs = document.getElementById('hangTabs');
  if (hasSections && viewMode === 'tabs') {
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
    const showingOneHang = viewMode === 'tabs' && activeHangIndex !== 'all';
    // A single hang always shows full-width -- the cards-per-row
    // breakpoints only matter when several hangs share the grid at once
    // (Grid view, or the All tab within Tabs view).
    const columns = showingOneHang ? 1 : (DESKTOP_MQL.matches && MULTI_CARD_MQL.matches ? computeGridColumns(STATE.cards_per_row) : 1);
    grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    const sectionsToRender = showingOneHang ? [STATE.sections[activeHangIndex]] : STATE.sections;
    populateGrid(grid, sectionsToRender);
  }
  renderColorPanel();
  renderNumberingPanel();
  renderDataTagsPanel();
  renderDataBarPanel();
  applyViewOnlyLock();
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
    tab.textContent = formatHangTitle(section.header) || `Hang ${i + 1}`;
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

function renderCard(section, cfg, activePalette, cycleLen) {
  const card = document.createElement('div');
  card.className = 'card';

  // Always reserve this gutter's width, whether or not this section's
  // header actually matches a hang-color rule -- otherwise a card with no
  // match gets its whole card-content area wider than one that does,
  // throwing off column alignment across the grid.
  const stripeColor = hangStripeColor(section.header, cfg.hang_colors);
  const bar = document.createElement('div');
  bar.className = 'hang-stripe-bar';
  if (stripeColor) {
    bar.style.background = argbToCss(stripeColor);
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
  content.appendChild(title);

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
    ? assignCircuitSetColors(section.cabinets, cfg.circuit_set_colors, cfg.hid_bundle_size || 4)
    : {};

  section.cabinets.forEach((cab, i) => {
    const row = document.createElement('div');
    row.className = 'box-row';
    const fillHex = circuitFillMap[cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt];
    if (fillHex && cfg.show_row_fill !== false) {
      row.style.background = argbToCss(fillHex);
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
        const setColor = circuitSetFillMap[cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt];
        if (setColor) {
          const stripe = document.createElement('div');
          stripe.className = 'circuit-set-stripe';
          stripe.style.background = argbToCss(setColor);
          wrap.appendChild(stripe);
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
    v.textContent = val;
    row.appendChild(l); row.appendChild(v);
    row.appendChild(makeTagHideBtn(section, key, label));
    meta.appendChild(row);
  });
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

function renderColorPanel() {
  const panel = document.getElementById('colorPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable'});
  panel.innerHTML = '';

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
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Trunk Cable'});
  const cableName = cfg.breakout_cable_name || 'Trunk Cable';
  panel.innerHTML = '';

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
  document.body.classList.toggle('view-only', readOnly);
  document.getElementById('viewOnlyBanner').style.display = readOnly ? 'inline' : 'none';
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
  const alwaysEnabled = ['exportBtn', 'printGridBtn', 'printMobileBtn', 'colorToggleBtn', 'numberingToggleBtn', 'dataTagsToggleBtn', 'dataTagsToggleBtnVO', 'menuToggleBtn', 'menuCloseBtn', 'authLockBtn', 'sidebarToggleTab'];
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
document.querySelectorAll('#viewModeToggle .view-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!STATE) return;
    // All is always where Tabs view starts -- switching to it (from Grid,
    // or re-clicking Tabs) shouldn't resume whatever single hang was last
    // viewed, since that's easy to forget you left it on and mistake for
    // "this is everything."
    if (btn.dataset.mode === 'tabs') activeHangIndex = 'all';
    STATE.view_mode = btn.dataset.mode;
    render();
    saveState(false);
  });
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
document.getElementById('colorToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('colorPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('numberingToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('numberingPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('dataBarToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('dataBarPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
// Two trigger buttons, one panel -- the sidebar's (editor + desktop
// view-only) and .view-only-topbar's (mobile view-only, which has no
// sidebar to put a trigger in -- see the comment on #dataTagsPanel in
// index.html).
function toggleDataTagsPanel() {
  const p = document.getElementById('dataTagsPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}
document.getElementById('dataTagsToggleBtn').addEventListener('click', toggleDataTagsPanel);
document.getElementById('dataTagsToggleBtnVO').addEventListener('click', toggleDataTagsPanel);
// Click-outside-to-close -- same pattern as the auth popover (see
// auth.js), but stopping propagation at the panel itself rather than
// checking panel.contains(e.target) from the document listener: every
// control inside re-renders the panel (setDateTagOverride/
// setLocalTagHidden -> render() -> renderDataTagsPanel wipes and rebuilds
// its innerHTML), which detaches the very element that was clicked BEFORE
// the document listener below gets a chance to check it -- contains()
// on an already-detached node returns false, so the panel was closing
// itself right after every single click inside it.
document.getElementById('dataTagsPanel').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', e => {
  const panel = document.getElementById('dataTagsPanel');
  if (panel.style.display === 'none') return;
  if (e.target.closest('#dataTagsToggleBtn, #dataTagsToggleBtnVO')) return;
  panel.style.display = 'none';
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

// Touch swipe between hangs in Tabs view -- lets a phone user page through
// hangs with a swipe instead of reaching for the (potentially many, small)
// tab buttons. Only does anything in Tabs view; Grid view already shows
// every hang at once, so there's no "next card" to swipe to.
(function setupHangSwipe() {
  const grid = document.getElementById('grid');
  let startX = 0, startY = 0, tracking = false;
  grid.addEventListener('touchstart', e => {
    tracking = !!STATE && STATE.view_mode === 'tabs' && activeHangIndex !== 'all' && e.touches.length === 1;
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
    if (dx < 0 && activeHangIndex < STATE.sections.length - 1) {
      activeHangIndex++; render();
    } else if (dx > 0 && activeHangIndex > 0) {
      activeHangIndex--; render();
    }
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
loadState();
