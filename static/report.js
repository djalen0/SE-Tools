// Tour Report -- a post-mortem across every Date under a Show. The main
// question is box number x angle: for each box in a hang, what splay did it
// run on each date, and how consistent was that over the tour? NFC is the
// secondary question (how it tracked splay) and gets its own section below.
// Data comes pre-flattened and pre-parsed from /api/shows/<slug>/report (see
// build_tour_report, app.py): splay/NFC are already numbers or null, box 1
// (the frame) already has splay null.
//
// Everything on screen is computed per hang "role" (MAIN/SIDE/REAR...,
// matched across dates by _hang_key) from the dates currently checked in
// the Dates picker. Print renders every hang one after another, not just
// the selected tab -- the whole report is the export.
//
// Box numbers can be counted from the top (as on the pinning sheet) or
// from the bottom. Hang length changes date to date (14 vs 16 boxes), so
// "box 12" from the top is a different part of the array on a longer hang
// -- counting from the bottom lines up the near-field boxes instead.

const SHOW_SLUG = document.body.getAttribute('data-show-slug');
const PREFS_KEY = 'pa-pinner-report-prefs:' + SHOW_SLUG;
const EXCLUDED_KEY = 'pa-pinner-report-excluded:' + SHOW_SLUG;
const SVG_NS = 'http://www.w3.org/2000/svg';

let REPORT = null;          // {show, dates}
let EXCLUDED = null;        // Set of date slugs left out of the analysis
let ACTIVE_HANG = null;
// Per-device view prefs. align: 'top' | 'bottom'. shade: 'angle' | 'nfc'.
// overlay: {hangKey: dateSlug} -- the one date drawn over the angle chart.
// size: 'all' | '<box count>' -- the page-wide Hang size filter.
// align can also be 'zones'; far/near are the zone sizes (boxes) it uses,
// and labels picks Zones-mode row labels: 'function' (F#/M#/N#) or 'array'
// (each box's absolute B#).
let PREFS = { align: 'top', shade: 'angle', overlay: {}, size: 'all', far: 4, near: 5, labels: 'function' };

// --- Small helpers ------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
}
function fmtDeg(v) { return v === null || v === undefined ? '—' : fmtNum(v) + '°'; }
function fmtDelta(v) { return v === null || v === undefined ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtNum(Math.abs(v)) + '°'; }
// "No filter" and 0 are the same thing for analysis -- a blank NFC cell
// on the sheet just means nothing was applied to that box.
function nfcVal(box) { return box.nfc === null ? 0 : box.nfc; }
function fmtNfc(v) { return v === null || v === undefined || v === 0 ? 'none' : fmtNum(v); }
function fmtPct(v) { return v === null || v === undefined ? '—' : Math.round(v * 100) + '%'; }
function fmtRho(v) { return v === null || v === undefined ? '—' : (v >= 0 ? '' : '−') + Math.abs(v).toFixed(2); }

function shortDate(d) {
  if (!d.iso) return d.date;
  const [, m, day] = d.iso.split('-');
  return `${+m}/${+day}`;
}

// --- Zones ------------------------------------------------------------------
// An array covers audience zones: the top boxes throw to the back of the
// room (far), the bottom boxes cover the closest seats (near), and the
// middle covers everything between. Hangs of different box counts line up
// by what each box does, not its raw number: the far boxes match from the
// top (B1-4 of a 16 ~ B1-4 of a 12), the near boxes match from the bottom
// (B12-16 of a 16 ~ B8-12 of a 12), and the middle -- which stretches or
// shrinks with box count (B5-11 of a 16 vs B5-7 of a 12) -- is matched by
// relative position. Section sizes are adjustable (PREFS.far/near).
//
// Zone slots encode section + index as one sortable number so the rest of
// the analysis can treat them like any other box number:
// far box i -> i, mid bucket b -> 100 + b, near box j -> 200 + j (j = N is
// the bottom box).
const MID_BASE = 100, NEAR_BASE = 200;

// Far/near box counts actually used on a `len`-box hang -- short hangs give
// up near boxes first, then far, so there's always a top.
function zoneSizes(len) {
  const far = Math.min(PREFS.far, len);
  return { far, near: Math.min(PREFS.near, len - far) };
}
function midCount(len) { const z = zoneSizes(len); return len - z.far - z.near; }

// Which section box `top` (1-based from the top) of a `len`-box hang is in.
function zoneOf(top, len) {
  const { far, near } = zoneSizes(len);
  const fromBottom = len - top + 1;
  if (top <= far) return { section: 'far', index: top };
  if (fromBottom <= near) return { section: 'near', index: PREFS.near - fromBottom + 1 };
  return { section: 'mid', index: top - far, of: len - far - near };
}

// Set b.slot on every box for the current Line-up mode. In zones mode the
// middle is bucketed into as many rows as the SHORTEST middle in play, each
// box landing in a bucket by its relative position -- so a 7-box middle
// and a 3-box middle both read as three rows (upper/centre/lower middle).
function assignSlots(runs) {
  const mids = runs.map(r => midCount(r.len)).filter(n => n > 0);
  const buckets = mids.length ? Math.min(...mids) : 0;
  runs.forEach(r => r.boxes.forEach(b => {
    if (PREFS.align === 'bottom') b.slot = b.fromBottom;
    else if (PREFS.align !== 'zones') b.slot = b.top;
    else if (b.zone.section === 'far') b.slot = b.zone.index;
    else if (b.zone.section === 'near') b.slot = NEAR_BASE + b.zone.index;
    else b.slot = MID_BASE + Math.min(buckets, Math.floor(((b.zone.index - 0.5) / b.zone.of) * buckets) + 1);
  }));
}

function slotSection(slot) { return slot >= NEAR_BASE ? 'near' : slot >= MID_BASE ? 'mid' : 'far'; }

// Display names for the three zones, used everywhere they're shown.
const ZONE_NAMES = { far: 'Far-Field', mid: 'Mid-Field', near: 'Near-Field' };

// Box labels. "B#" is ALWAYS a box's absolute number in its hang (B1 = top
// box), never a position counted some other way. A row (slot) can hold
// different absolute boxes on hangs of different lengths -- near-field N5
// is B16 on a 16 but B12 on a 12 -- so a row's B# label lists every box
// number that lands in it: "B16", "B6–7", "B12/14/16". The functional
// labels (F#/M#/N#) exist only in Zones mode, where PREFS.labels picks
// between them and B#.
function useFunctionLabels() { return PREFS.align === 'zones' && PREFS.labels === 'function'; }

function absLabel(nums) {
  const n = [...new Set(nums)].sort((p, q) => p - q);
  if (!n.length) return '';
  if (n.length === 1) return 'B' + n[0];
  if (n[n.length - 1] - n[0] === n.length - 1) return `B${n[0]}–${n[n.length - 1]}`;
  return 'B' + n.join('/');
}

function functionLabel(slot) {
  if (slot >= NEAR_BASE) return 'N' + (slot - NEAR_BASE);
  if (slot >= MID_BASE) return 'M' + (slot - MID_BASE);
  return 'F' + slot;
}

// Short row label, e.g. for the grid's first column. `a` is the hang's
// analysis (its slotBoxes say which absolute boxes each row holds).
function slotLabel(slot, a) {
  return useFunctionLabels() ? functionLabel(slot) : absLabel(a.slotBoxes.get(slot) || []);
}

// One specific box on one specific date -- its own B# when showing box
// numbers, else its row's functional label.
function boxLabel(box, a) { return useFunctionLabels() ? functionLabel(box.slot) : 'B' + box.top; }

// Long description for tooltips: where the row sits, plus its box numbers.
function slotLabelLong(slot, a) {
  const abs = absLabel(a.slotBoxes.get(slot) || []);
  if (PREFS.align === 'bottom') return `${ordinal(slot)} box from the bottom (${abs})`;
  if (PREFS.align !== 'zones') return abs;
  let where;
  if (slot >= NEAR_BASE) {
    const j = slot - NEAR_BASE;
    where = `${ZONE_NAMES.near} ${j} of ${PREFS.near}${j === PREFS.near ? ', bottom box' : ''}`;
  } else if (slot >= MID_BASE) where = `${ZONE_NAMES.mid}, part ${slot - MID_BASE}`;
  else where = `${ZONE_NAMES.far} ${slot} of ${PREFS.far}`;
  return useFunctionLabels() ? `${functionLabel(slot)} · ${where} (${abs})` : `${abs} · ${where}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Spearman's rho: Pearson correlation of the two variables' ranks, ties
// sharing their average rank. Splay and NFC are both heavily tied (a dozen
// boxes at 8°, a dozen at -8) so plain Pearson on raw values would overstate
// how "linear" a stepped relationship is; rank correlation just asks "does
// more splay go with a deeper filter".
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx, dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Most common value per group, ties going to whichever value was seen
// latest in the tour (where the tour ended up is the better guess at the
// intended setting). items: [{group, value, date}] in tour order.
function typicalBy(items) {
  const groups = new Map();
  items.forEach((it, idx) => {
    if (!groups.has(it.group)) groups.set(it.group, new Map());
    const counts = groups.get(it.group);
    const c = counts.get(it.value) || { count: 0, last: -1, dates: new Set() };
    c.count++; c.last = idx; c.dates.add(it.date);
    counts.set(it.value, c);
  });
  const out = new Map();
  groups.forEach((counts, group) => {
    let best = null, n = 0;
    counts.forEach((c, value) => {
      n += c.count;
      if (!best || c.count > best.count || (c.count === best.count && c.last > best.last)) best = { value, count: c.count, last: c.last };
    });
    const values = [...counts.keys()];
    out.set(group, { group, value: best.value, agree: best.count / n, n, counts, min: Math.min(...values), max: Math.max(...values) });
  });
  return out;
}

// --- Analysis -------------------------------------------------------------

function includedDates() {
  return REPORT.dates.filter(d => !EXCLUDED.has(d.slug));
}

// A hang only belongs in this report if it actually has joint angles --
// flown subs etc. come through with no splay on any box.
function hangKeys(dates) {
  const keys = [];
  dates.forEach(d => d.hangs.forEach(h => {
    if (!keys.includes(h.key) && h.boxes.some(b => b.splay !== null)) keys.push(h.key);
  }));
  return keys;
}

// sizeFilter: a hang length (box count) to limit the analysis to, or
// null/'all' for every length. The CSV export always passes null.
function analyzeHang(key, dates, sizeFilter) {
  let runs = [];
  dates.forEach(d => {
    const hang = d.hangs.find(h => h.key === key);
    if (!hang) return;
    const len = hang.boxes.length;
    // top/fromBottom are counted off the box's index in the hang (not its
    // stored position) so every numbering scheme agrees with the others.
    // slot (this box's row under the current Line-up mode) is assigned
    // below, once the size filter has settled which runs are in play.
    const boxes = hang.boxes
      .map((b, i) => ({ ...b, top: i + 1, fromBottom: len - i, zone: zoneOf(i + 1, len) }))
      .filter(b => b.splay !== null);
    if (!boxes.length) return;
    // A date whose hang has no NFC on any box is treated as "NFC not
    // recorded" (a test sheet, or one exported without that column) rather
    // than "every filter was off" -- it stays out of every NFC statistic.
    runs.push({ date: d, hang, len, boxes, hasNfc: boxes.some(b => b.nfc !== null && b.nfc !== 0) });
  });
  // Every length this hang ran in the selected dates, with how many dates
  // each -- feeds the Hang size filter, so it's counted before filtering.
  const sizeCounts = new Map();
  runs.forEach(r => sizeCounts.set(r.len, (sizeCounts.get(r.len) || 0) + 1));
  const sizes = [...sizeCounts.entries()].sort((p, q) => p[0] - q[0]);
  const size = sizeFilter && sizeFilter !== 'all' && sizeCounts.has(+sizeFilter) ? +sizeFilter : null;
  if (size !== null) runs = runs.filter(r => r.len === size);
  assignSlots(runs);

  // --- Box x angle (the main analysis) ---
  const angleItems = [];
  runs.forEach(r => r.boxes.forEach(b => angleItems.push({ group: b.slot, value: b.splay, date: r.date.slug, run: r, box: b })));
  const typicalAngle = typicalBy(angleItems);
  // Which absolute box numbers (B#) land in each row, for row labels.
  const slotBoxes = new Map();
  angleItems.forEach(it => { if (!slotBoxes.has(it.group)) slotBoxes.set(it.group, []); slotBoxes.get(it.group).push(it.box.top); });
  // Always top-down reading order: descending box-from-bottom numbers, or
  // ascending otherwise (zone slots are encoded far < mid < near).
  const slots = [...typicalAngle.keys()].sort((a, b) => (PREFS.align === 'bottom' ? b - a : a - b));
  const angleMatch = it => typicalAngle.get(it.group).value === it.value;
  const angleChanges = angleItems.filter(it => !angleMatch(it)).map(it => ({
    run: it.run, box: it.box, slot: it.group, splay: it.value,
    typical: typicalAngle.get(it.group).value, delta: it.value - typicalAngle.get(it.group).value,
  }));
  // Only positions seen on 2+ dates can say anything about consistency.
  const comparable = slots.filter(s => typicalAngle.get(s).n >= 2);
  const locked = comparable.filter(s => typicalAngle.get(s).agree === 1);
  const mostVariable = comparable.length
    ? comparable.reduce((a, s) => {
      const A = typicalAngle.get(a), S = typicalAngle.get(s);
      return S.agree < A.agree || (S.agree === A.agree && S.max - S.min > A.max - A.min) ? s : a;
    })
    : null;

  // --- NFC vs splay (secondary) ---
  const withNfc = runs.filter(r => r.hasNfc);
  const nfcItems = [];
  withNfc.forEach(r => r.boxes.forEach(b => nfcItems.push({ group: b.splay, value: nfcVal(b), date: r.date.slug, run: r, box: b })));
  const nfcRule = typicalBy(nfcItems);
  const nfcRuleList = [...nfcRule.values()].sort((a, b) => a.group - b.group);
  const nfcMatch = it => nfcRule.get(it.group).value === it.value;
  const nfcDeviations = nfcItems.filter(it => !nfcMatch(it));
  const changes = [];
  runs.forEach(r => r.boxes.forEach(b => { if (b.nfc_changed) changes.push({ run: r, box: b }); }));

  // Curve (sum of joint angles) each zone got on each date, plus the
  // tour's median per zone -- see renderZoneCurve.
  const zoneCurve = runs.map(r => {
    const sum = z => r.boxes.filter(b => b.zone.section === z).reduce((s, b) => s + b.splay, 0);
    const count = z => r.hang.boxes.filter((b, i) => zoneOf(i + 1, r.len).section === z).length;
    return { run: r, far: sum('far'), mid: sum('mid'), near: sum('near'), midBoxes: count('mid'), total: r.boxes.reduce((s, b) => s + b.splay, 0) };
  });
  const zoneMedian = {
    far: median(zoneCurve.map(z => z.far)), mid: median(zoneCurve.map(z => z.mid)),
    near: median(zoneCurve.map(z => z.near)), total: median(zoneCurve.map(z => z.total)),
  };

  const perDate = runs.map(r => {
    const offs = angleChanges.filter(c => c.run === r);
    const biggest = offs.reduce((a, c) => (!a || Math.abs(c.delta) > Math.abs(a.delta) ? c : a), null);
    const onsetBox = r.hasNfc ? r.boxes.find(b => nfcVal(b) !== 0) : null;
    return {
      run: r,
      totalSplay: r.boxes.reduce((a, b) => a + b.splay, 0),
      offCount: offs.length,
      biggest,
      match: (r.boxes.length - offs.length) / r.boxes.length,
      nfcOnset: onsetBox,
      changed: r.boxes.filter(b => b.nfc_changed).length,
    };
  });

  const onsets = perDate.filter(p => p.nfcOnset).map(p => p.nfcOnset.splay);
  return {
    key, runs, slots, slotBoxes, typicalAngle, angleItems, angleChanges, comparable, locked, mostVariable, perDate,
    angleConsistency: angleItems.length ? angleItems.filter(angleMatch).length / angleItems.length : null,
    lengths: runs.length ? [Math.min(...runs.map(r => r.len)), Math.max(...runs.map(r => r.len))] : null,
    sizes, size, zoneCurve, zoneMedian,
    nfc: {
      withNfc, items: nfcItems, rule: nfcRule, ruleList: nfcRuleList, deviations: nfcDeviations, changes,
      consistency: nfcItems.length ? nfcItems.filter(nfcMatch).length / nfcItems.length : null,
      rho: spearman(nfcItems.map(p => p.group), nfcItems.map(p => Math.abs(p.value))),
      onsetMedian: median(onsets),
      onsetRange: onsets.length ? [Math.min(...onsets), Math.max(...onsets)] : null,
    },
  };
}

// --- Tooltip ----------------------------------------------------------------

const tooltip = document.getElementById('reportTooltip');

// lines: [{value, label}] -- values lead (strong), labels follow.
function showTooltip(evt, title, lines) {
  tooltip.innerHTML = '';
  tooltip.appendChild(el('div', 'report-tooltip-title', title));
  lines.forEach(l => {
    const row = el('div', 'report-tooltip-row');
    row.appendChild(el('strong', null, l.value));
    row.appendChild(el('span', null, l.label));
    tooltip.appendChild(row);
  });
  tooltip.hidden = false;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tooltip.style.left = Math.max(8, x) + 'px';
  tooltip.style.top = Math.max(8, y) + 'px';
}
function hideTooltip() { tooltip.hidden = true; }

function attachTip(node, title, lines) {
  node.addEventListener('pointermove', e => showTooltip(e, title, lines()));
  node.addEventListener('pointerleave', hideTooltip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTooltip({ clientX: r.right, clientY: r.top }, title, lines());
  });
  node.addEventListener('blur', hideTooltip);
}

// --- Building blocks ----------------------------------------------------------

function statTile(label, value, note) {
  const tile = el('div', 'report-stat');
  tile.appendChild(el('div', 'report-stat-label', label));
  tile.appendChild(el('div', 'report-stat-value', value));
  if (note) tile.appendChild(el('div', 'report-stat-note', note));
  return tile;
}

// A report card: title + one-line subtitle on the left, `c.actions` (for
// per-card controls) on the right. `collapsible` makes it a <details>
// whose header is the toggle -- used for the long reference tables so the
// page leads with the charts. Print opens every one (see beforeprint).
function card(title, sub, { collapsible = false, open = false } = {}) {
  const c = el(collapsible ? 'details' : 'section', 'report-card' + (collapsible ? ' report-collapsible' : ''));
  if (collapsible) c.open = open;
  const head = el(collapsible ? 'summary' : 'div', 'report-card-head');
  const text = el('div', 'report-card-text');
  text.appendChild(el('h3', 'report-card-title', title));
  if (sub) text.appendChild(el('p', 'report-card-sub', sub));
  head.appendChild(text);
  c.actions = el('div', 'report-card-actions');
  if (!collapsible) head.appendChild(c.actions);
  c.appendChild(head);
  return c;
}

// Collapsible sub-section inside a card (e.g. a chart's reference table).
function disclosure(label, content) {
  const d = el('details', 'report-disclosure');
  d.appendChild(el('summary', null, label));
  d.appendChild(content);
  return d;
}

function meter(fraction) {
  const m = el('span', 'report-meter');
  const fill = el('span', 'report-meter-fill');
  fill.style.width = Math.round((fraction || 0) * 100) + '%';
  m.appendChild(fill);
  return m;
}

function tableWrap(headers, rows) {
  const table = el('table', 'report-table');
  const head = el('tr');
  headers.forEach(h => head.appendChild(el('th', null, h)));
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  rows.forEach(r => body.appendChild(r));
  table.appendChild(body);
  const wrap = el('div', 'report-table-wrap');
  wrap.appendChild(table);
  return wrap;
}

function td(className, content) {
  const cell = el('td', className);
  (Array.isArray(content) ? content : [content]).forEach(c => {
    cell.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return cell;
}

function meterCell(fraction) { return td('num', [meter(fraction), ' ' + fmtPct(fraction)]); }

function legendItem(keyClass, text) {
  const item = el('span', 'viz-legend-item');
  item.appendChild(el('span', keyClass));
  item.appendChild(document.createTextNode(text));
  return item;
}

// Categorical-x bubble chart shared by the angle and NFC views: each
// (x, y) pair seen gets a bubble sized by how often it came up; `line` is
// the typical value per x; `overlay` optionally draws one date's profile.
function bubbleChart({ xs, xLabel, yMin, yMax, yStep, yLabel, xTitle, yTitle, bubbles, line, overlay, ariaLabel }) {
  const W = 640, H = 300, m = { l: 48, r: 22, t: 20, b: 42 };
  const band = (W - m.l - m.r) / xs.length;
  const xIndex = new Map(xs.map((v, i) => [v, i]));
  const x = v => m.l + (xIndex.get(v) + 0.5) * band;
  const span = (yMax - yMin) || 1;
  const y = v => m.t + ((yMax - v) / span) * (H - m.t - m.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'report-chart', role: 'img', 'aria-label': ariaLabel });
  for (let v = yMin; v <= yMax + 1e-9; v += yStep) {
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'viz-baseline' : 'viz-grid' }));
    const t = svgEl('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-tick' });
    t.textContent = yLabel(v);
    svg.appendChild(t);
  }
  // Thin out x labels when there are too many to fit.
  const every = Math.ceil(xs.length / Math.floor((W - m.l - m.r) / 26));
  xs.forEach((v, i) => {
    if (i % every) return;
    const t = svgEl('text', { x: x(v), y: H - m.b + 18, 'text-anchor': 'middle', class: 'viz-tick' });
    t.textContent = xLabel(v);
    svg.appendChild(t);
  });
  const xl = svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'viz-axis-label' });
  xl.textContent = xTitle;
  svg.appendChild(xl);
  const midY = (m.t + H - m.b) / 2;
  const yl = svgEl('text', { x: 12, y: midY, 'text-anchor': 'middle', class: 'viz-axis-label', transform: `rotate(-90 12 ${midY})` });
  yl.textContent = yTitle;
  svg.appendChild(yl);

  const pathOf = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  if (line && line.length) svg.appendChild(svgEl('path', { d: pathOf(line), class: 'viz-rule-line' }));

  const maxCount = Math.max(1, ...bubbles.map(b => b.count));
  const maxR = Math.min(13, band / 2 - 1);
  bubbles.forEach(b => {
    const radius = Math.max(3, maxR * Math.sqrt(b.count / maxCount));
    const g = svgEl('g', { class: 'viz-hit', tabindex: '0' });
    g.appendChild(svgEl('circle', { cx: x(b.x), cy: y(b.y), r: Math.max(12, radius + 4), class: 'viz-hit-area' }));
    g.appendChild(svgEl('circle', { cx: x(b.x), cy: y(b.y), r: radius, class: 'viz-bubble' }));
    attachTip(g, b.title, b.lines);
    svg.appendChild(g);
  });

  if (overlay && overlay.length) {
    svg.appendChild(svgEl('path', { d: pathOf(overlay), class: 'viz-overlay-line' }));
    overlay.forEach(p => svg.appendChild(svgEl('circle', { cx: x(p.x), cy: y(p.y), r: 4, class: 'viz-overlay-dot' })));
  }
  return svg;
}

// --- Box x angle sections -----------------------------------------------------

function renderStats(a) {
  const wrap = el('div', 'report-stats');
  wrap.appendChild(statTile('Dates compared', String(a.runs.length),
    a.lengths ? (a.lengths[0] === a.lengths[1] ? `${a.lengths[0]} boxes every date` : `Hang ran ${a.lengths[0]}–${a.lengths[1]} boxes`) : ''));
  wrap.appendChild(statTile('Boxes that never changed', `${a.locked.length} of ${a.comparable.length}`,
    'Same angle at that box on every date'));
  wrap.appendChild(statTile('Angle consistency', fmtPct(a.angleConsistency),
    'Box-dates that ran their box’s typical angle'));
  const mv = a.mostVariable !== null ? a.typicalAngle.get(a.mostVariable) : null;
  wrap.appendChild(statTile('Most variable box', mv && mv.agree < 1 ? slotLabel(a.mostVariable, a) : '—',
    mv && mv.agree < 1 ? `Ran ${fmtDeg(mv.min)}–${fmtDeg(mv.max)}; typical ${fmtDeg(mv.value)} on ${fmtPct(mv.agree)} of dates` : 'Every box held its angle'));
  return wrap;
}

// Side view of the hang built only from its joint angles -- the top box is
// always drawn upright (no Angle (T)/trim/tilt), so this shows curvature
// alone: small joint angles stack into a straight, flat section, large
// ones into the curl. Boxes hinge at the front and each joint angle opens
// a wedge at the rear, so the curl goes back under the hang the way a real
// J-array does (audience to the right).
// CO12 side profile, from the manufacturer CAD side view: about 2:1
// depth:height. Units are box heights.
// The side is a symmetric trapezoid, not a rectangle: the front is taller
// than the rear, with the top and bottom faces each tapering MAX_SPLAY/2
// toward the rear. So at MAX_SPLAY (10° on CO12) a box's top sits flush
// against the bottom of the box above; anything smaller leaves a wedge gap
// at the rear, widest at 0°.
const BOX_H = 1, BOX_D = 2.05, MAX_SPLAY = 10;
const BOX_TAPER = BOX_D * Math.tan((MAX_SPLAY / 2) * Math.PI / 180);

// Box outline in box-local coordinates (see co12SideDetail below).
function co12Outline() {
  const D = BOX_D, H = BOX_H, t = BOX_TAPER;
  return [[0, 0], [D, t], [D, H - t], [0, H]];
}

// The CO12 side view in box-local coordinates: u = depth from the front
// face (0) back to the rear (BOX_D), v = height from the top (0) down
// (BOX_H). renderShape maps this onto each box with one SVG matrix, so the
// drawing tilts with the box. Oriented exactly as the CAD side view reads
// (not mirrored): the rigging-hole column and link bracket are at the front
// hinge (the chart's right, toward the audience), the handle plate and the
// chamfered corners at the rear (the chart's left).
function co12SideDetail() {
  const g = svgEl('g', { class: 'viz-shape-detail' });
  const D = BOX_D;
  g.appendChild(svgEl('polygon', { class: 'viz-shape-outline', points: co12Outline().map(p => p.join(',')).join(' ') }));
  // Rear handle plate + handle cutout -- sized to sit inside the tapered
  // rear, which is only ~0.64 box-heights tall.
  g.appendChild(svgEl('rect', { x: D - 0.78, y: 0.24, width: 0.62, height: 0.52, rx: 0.04 }));
  g.appendChild(svgEl('rect', { x: D - 0.62, y: 0.35, width: 0.3, height: 0.3, rx: 0.1 }));
  // Front rigging: rail, angle-hole column, bottom link bracket.
  g.appendChild(svgEl('line', { x1: 0.3, y1: 0.08, x2: 0.3, y2: 0.92 }));
  [0.2, 0.34, 0.48, 0.62, 0.76].forEach(v => g.appendChild(svgEl('circle', { cx: 0.15, cy: v, r: 0.035 })));
  g.appendChild(svgEl('rect', { x: 0.06, y: 0.8, width: 0.2, height: 0.14, rx: 0.02 }));
  return g;
}

function arrayProfile(splays) {
  // splays: joint angles for boxes 2..n, top-down (box 1 has none).
  let theta = 0;
  let fx = 0, fy = 0;
  const boxes = [];
  [0, ...splays].forEach(s => {
    theta += s;
    const r = theta * Math.PI / 180;
    const dir = [-Math.sin(r), Math.cos(r)];     // down along the front face
    const back = [-Math.cos(r), -Math.sin(r)];   // front -> rear
    const bx = fx + dir[0] * BOX_H, by = fy + dir[1] * BOX_H;
    // Box-local (u back, v down) -> chart coordinates.
    const toWorld = ([u, v]) => [fx + u * back[0] + v * dir[0], fy + u * back[1] + v * dir[1]];
    boxes.push({
      theta,
      matrix: [back[0], back[1], dir[0], dir[1], fx, fy],
      // [front-top, front-bottom, rear-bottom, rear-top]
      poly: [co12Outline()[0], co12Outline()[3], co12Outline()[2], co12Outline()[1]].map(toWorld),
    });
    fx = bx; fy = by;
  });
  const face = [[0, 0], ...boxes.map(b => b.poly[1])];
  return { boxes, face };
}

function renderShape(a) {
  // (The CO12 is taller at the front than the rear, so a 10° joint closes
  // flush at the back and smaller angles leave a wedge gap -- see
  // co12Outline.)
  const c = card('Array shape', 'Side view from the joint angles: the typical hang, with every other date traced behind it.');
  c.classList.add('report-card-shape');
  if (!a.runs.length) return c;

  const select = el('select', 'report-select');
  select.setAttribute('aria-label', 'Highlight a date');
  select.appendChild(new Option('Highlight a date', ''));
  a.runs.forEach(r => select.appendChild(new Option(`${shortDate(r.date)}${r.date.venue ? ' · ' + r.date.venue : ''}`, r.date.slug)));
  const chosen = PREFS.overlay[a.key] || '';
  select.value = a.runs.some(r => r.date.slug === chosen) ? chosen : '';
  select.addEventListener('change', () => { PREFS.overlay[a.key] = select.value; savePrefs(); render(); });
  c.actions.appendChild(select);

  // a.slots is already top-down in either numbering mode.
  const typical = arrayProfile(a.slots.map(s => a.typicalAngle.get(s).value));
  const runProfile = r => arrayProfile([...r.boxes].sort((p, q) => p.top - q.top).map(b => b.splay));
  const dateProfiles = a.runs.map(r => ({ run: r, prof: runProfile(r) }));
  const highlighted = dateProfiles.find(p => p.run.date.slug === select.value);

  const pts = [typical, ...dateProfiles.map(p => p.prof)].flatMap(p => p.boxes.flatMap(b => b.poly));
  const pad = 0.6;
  const minX = Math.min(...pts.map(p => p[0])) - pad, maxX = Math.max(...pts.map(p => p[0])) + pad;
  const minY = Math.min(...pts.map(p => p[1])) - pad, maxY = Math.max(...pts.map(p => p[1])) + pad;
  const svg = svgEl('svg', {
    viewBox: `${minX.toFixed(2)} ${minY.toFixed(2)} ${(maxX - minX).toFixed(2)} ${(maxY - minY).toFixed(2)}`,
    class: 'report-shape', role: 'img', 'aria-label': `Array shape for ${a.key}`,
  });
  const polyStr = poly => poly.map(p => p.map(v => v.toFixed(3)).join(',')).join(' ');

  dateProfiles.forEach(({ run, prof }) => {
    if (highlighted && run === highlighted.run) return;
    const line = svgEl('polyline', { points: polyStr(prof.face), class: 'viz-shape-date' });
    const hit = svgEl('polyline', { points: polyStr(prof.face), class: 'viz-shape-hit' });
    const total = run.boxes.reduce((s, b) => s + b.splay, 0);
    attachTip(hit, `${shortDate(run.date)}${run.date.venue ? ' · ' + run.date.venue : ''}`, () => [
      { value: String(run.len), label: 'boxes' },
      { value: fmtDeg(total), label: 'total curve' },
    ]);
    svg.appendChild(line);
    svg.appendChild(hit);
  });

  // Typical hang, box by box; slot order matches a.slots (box 1 first).
  const slotOrder = [null, ...a.slots];
  typical.boxes.forEach((b, i) => {
    const g = svgEl('g', { class: 'viz-shape-box', tabindex: '0' });
    const detail = co12SideDetail();
    detail.setAttribute('transform', `matrix(${b.matrix.map(v => v.toFixed(4)).join(' ')})`);
    g.appendChild(detail);
    const slot = slotOrder[i];
    if (slot !== null) {
      const t = a.typicalAngle.get(slot);
      attachTip(g, slotLabelLong(slot, a), () => [
        { value: fmtDeg(t.value), label: 'typical joint angle' },
        { value: fmtPct(t.agree), label: 'of dates ran it' },
        { value: fmtDeg(b.theta), label: 'curve from the top box' },
      ]);
    } else {
      attachTip(g, 'Top box', () => [{ value: 'Frame', label: 'no joint angle' }]);
    }
    svg.appendChild(g);
  });

  if (highlighted) {
    highlighted.prof.boxes.forEach(b => svg.appendChild(svgEl('polygon', { points: polyStr(b.poly), class: 'viz-shape-highlight' })));
  }
  c.appendChild(svg);

  const legend = el('div', 'viz-legend');
  legend.appendChild(legendItem('viz-key-swatch shape', 'Typical angle at every box'));
  legend.appendChild(legendItem('viz-key-line muted', 'Other dates (box fronts)'));
  if (highlighted) legend.appendChild(legendItem('viz-key-line overlay', `${shortDate(highlighted.run.date)}${highlighted.run.date.venue ? ' · ' + highlighted.run.date.venue : ''}`));
  c.appendChild(legend);
  return c;
}

function renderAngleChart(a) {
  const c = card('Angle by box', 'Each date’s joint angle at every box. Bigger bubbles mean more dates; the line is the typical angle.');
  if (!a.angleItems.length) return c;

  const bubbles = [];
  a.slots.forEach(slot => {
    const t = a.typicalAngle.get(slot);
    t.counts.forEach((cnt, splay) => bubbles.push({
      x: slot, y: splay, count: cnt.count,
      title: `${slotLabelLong(slot, a)} · ${fmtDeg(splay)}`,
      lines: () => [
        { value: String(cnt.dates.size), label: cnt.dates.size === 1 ? 'date' : 'dates' },
        { value: fmtPct(cnt.count / t.n), label: `of dates at this box` },
        { value: fmtDeg(t.value), label: 'typical here' },
      ],
    }));
  });
  const maxSplay = Math.max(...a.angleItems.map(it => it.value));
  const yMax = Math.max(2, Math.ceil(maxSplay / 2) * 2);
  // Same highlighted date as the Array shape chart's picker above.
  const overlayRun = a.runs.find(r => r.date.slug === PREFS.overlay[a.key]);
  const overlay = overlayRun
    ? a.slots.map(s => {
      // Mean if a zones-mode middle row holds several of this hang's boxes.
      const bs = overlayRun.boxes.filter(b => b.slot === s);
      return bs.length ? { x: s, y: bs.reduce((t, b) => t + b.splay, 0) / bs.length } : null;
    }).filter(Boolean)
    : null;
  c.appendChild(bubbleChart({
    xs: a.slots, xLabel: s => slotLabel(s, a), yMin: 0, yMax, yStep: 2, yLabel: v => v + '°',
    xTitle: PREFS.align === 'zones' ? 'Box by zone: Far-Field (from the top) · Mid-Field (by position) · Near-Field (from the bottom)'
      : PREFS.align === 'bottom' ? 'Box, counted from the bottom (top of hang on the left)' : 'Box, counted from the top',
    yTitle: 'Splay (bigger = more curve)', bubbles,
    line: a.slots.map(s => ({ x: s, y: a.typicalAngle.get(s).value })),
    overlay, ariaLabel: `Splay by box for ${a.key}`,
  }));

  const legend = el('div', 'viz-legend');
  legend.appendChild(legendItem('viz-key-dot', 'Dates at that angle (size = how many)'));
  legend.appendChild(legendItem('viz-key-line', 'Typical angle'));
  if (overlayRun) legend.appendChild(legendItem('viz-key-line overlay', `${shortDate(overlayRun.date)}${overlayRun.date.venue ? ' · ' + overlayRun.date.venue : ''}`));
  c.appendChild(legend);

  let curveSoFar = 0;
  const rows = a.slots.map(slot => {
    const t = a.typicalAngle.get(slot);
    curveSoFar += t.value;
    const tr = el('tr');
    tr.appendChild(td('num strong', slotLabel(slot, a)));
    tr.appendChild(td('num strong', fmtDeg(t.value)));
    tr.appendChild(td('num muted', fmtDeg(curveSoFar)));
    tr.appendChild(meterCell(t.agree));
    tr.appendChild(td('num', t.min === t.max ? fmtDeg(t.min) : `${fmtDeg(t.min)}–${fmtDeg(t.max)}`));
    tr.appendChild(td('num', String(t.n)));
    const others = [...t.counts.entries()].filter(([v]) => v !== t.value)
      .sort((p, q) => q[1].count - p[1].count)
      .map(([v, cnt]) => `${fmtDeg(v)} ×${cnt.count}`).join(', ');
    tr.appendChild(td('muted', others || '—'));
    return tr;
  });
  c.appendChild(disclosure('Per-box table', tableWrap(['Box', 'Typical angle', 'Curve to here', 'Held', 'Range', 'Dates', 'Also ran'], rows)));
  return c;
}

// Sequential single-hue ramp (light -> dark = shallow -> deep filter).
const SEQ_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
// Diverging blue <-> red around a neutral (the cell's own gray): blue =
// a smaller angle than that box's typical one (flatter), red = a larger one
// (more curve).
const DIV_FLAT = ['#b7d3f6', '#6da7ec', '#256abf'];
const DIV_CURVE = ['#f6c4c3', '#ec8a89', '#c93b3b'];

function inkFor(idx) { return idx >= 2 ? '#ffffff' : '#0b0b0b'; }
function nfcColor(depth, maxDepth) {
  if (!depth) return null;
  const idx = Math.min(SEQ_RAMP.length - 1, Math.round((depth / (maxDepth || 1)) * (SEQ_RAMP.length - 1)));
  return { fill: SEQ_RAMP[idx], ink: idx >= 3 ? '#ffffff' : '#0b0b0b' };
}
function deltaColor(delta, maxDelta) {
  if (!delta) return null;
  const arm = delta < 0 ? DIV_FLAT : DIV_CURVE;
  const idx = Math.min(arm.length - 1, Math.max(0, Math.ceil((Math.abs(delta) / (maxDelta || 1)) * arm.length) - 1));
  return { fill: arm[idx], ink: inkFor(idx) };
}

// Box x Date grid: each column is one date, each row one box. The cell text
// is that box's splay; the fill is either how far it moved from the box's
// typical angle (default) or its NFC depth.
function renderGrid(a) {
  const byAngle = PREFS.shade !== 'nfc';
  const c = card('Box × date',
    byAngle
      ? 'Joint angle per box per date, shaded against that box’s typical angle.'
      : 'Joint angle per box per date, shaded by NFC depth. A corner mark means the NFC was changed on site.');
  if (!a.runs.length) return c;
  c.actions.appendChild(segmented('Shade by', [['angle', 'Angle'], ['nfc', 'NFC']], PREFS.shade, v => { PREFS.shade = v; savePrefs(); render(); }));

  const maxDepth = Math.max(1, ...a.nfc.items.map(p => Math.abs(p.value)));
  const maxDelta = Math.max(1, ...a.angleChanges.map(ch => Math.abs(ch.delta)));

  const table = el('table', 'report-grid');
  const head = el('tr');
  head.appendChild(el('th', 'report-grid-corner', 'Box'));
  a.runs.forEach(r => {
    const th = el('th', !byAngle && !r.hasNfc ? 'no-nfc' : '');
    th.appendChild(el('div', 'report-grid-date', shortDate(r.date)));
    th.appendChild(el('div', 'report-grid-venue', r.date.venue || `${r.len} boxes`));
    if (!byAngle && !r.hasNfc) th.appendChild(el('div', 'report-grid-venue', 'no NFC'));
    th.title = [r.date.date, r.date.venue, `${r.len} boxes`, r.date.source_file].filter(Boolean).join(' · ');
    head.appendChild(th);
  });
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  a.slots.forEach((slot, si) => {
    const tr = el('tr');
    // Zones mode: a heavier rule where far -> mid -> near changes.
    if (PREFS.align === 'zones' && si > 0 && slotSection(a.slots[si - 1]) !== slotSection(slot)) tr.className = 'zone-start';
    tr.appendChild(el('th', 'report-grid-pos', slotLabel(slot, a)));
    const typical = a.typicalAngle.get(slot).value;
    a.runs.forEach(r => {
      // Usually one box; a zones-mode middle row can hold several boxes
      // of a longer hang (its middle squeezed into fewer rows).
      const boxes = r.boxes.filter(b => b.slot === slot);
      const cell = el('td');
      if (!boxes.length) { cell.className = 'empty'; tr.appendChild(cell); return; }
      cell.textContent = boxes.map(b => fmtNum(b.splay)).join('·');
      cell.tabIndex = 0;
      const mean = boxes.reduce((s, b) => s + b.splay, 0) / boxes.length;
      const delta = mean - typical;
      let color = null;
      if (byAngle) color = deltaColor(delta, maxDelta);
      else if (r.hasNfc) color = nfcColor(Math.max(...boxes.map(b => Math.abs(nfcVal(b)))), maxDepth);
      else cell.classList.add('no-nfc');
      if (color) { cell.style.background = color.fill; cell.style.color = color.ink; }
      if (!byAngle && boxes.some(b => b.nfc_changed)) cell.classList.add('changed');
      attachTip(cell, `${shortDate(r.date)}${r.date.venue ? ' · ' + r.date.venue : ''} · ${slotLabelLong(slot, a)}`, () => {
        const lines = [
          { value: boxes.map(b => fmtDeg(b.splay)).join(', '), label: boxes.length > 1 ? `splay (${boxes.length} boxes)` : 'splay' },
          { value: fmtDeg(typical), label: 'typical here' },
        ];
        if (delta) lines.push({ value: fmtDelta(delta), label: (delta < 0 ? 'flatter' : 'more curve') + (boxes.length > 1 ? ' on average' : '') });
        if (PREFS.align !== 'top') lines.push({ value: boxes.map(b => 'B' + b.top).join(', '), label: 'on this hang' });
        lines.push({ value: r.hasNfc ? boxes.map(b => fmtNfc(nfcVal(b))).join(', ') : 'not recorded', label: 'NFC' });
        boxes.filter(b => b.nfc_changed).forEach(b => lines.push({ value: fmtNfc(b.nfc_sheet === null ? 0 : b.nfc_sheet), label: `NFC on the sheet (B${b.top})` }));
        return lines;
      });
      tr.appendChild(cell);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  const wrap = el('div', 'report-table-wrap');
  wrap.appendChild(table);
  c.appendChild(wrap);

  const legend = el('div', 'viz-legend');
  const swatch = (fill, text, extra) => {
    const item = el('span', 'viz-legend-item');
    const sw = el('span', 'viz-key-swatch' + (extra ? ' ' + extra : ''));
    if (fill) sw.style.background = fill;
    item.appendChild(sw);
    item.appendChild(document.createTextNode(text));
    return item;
  };
  if (byAngle) {
    legend.appendChild(el('span', 'viz-legend-caption', 'Vs. typical'));
    legend.appendChild(swatch(DIV_FLAT[2], 'Flatter'));
    legend.appendChild(swatch(null, 'Typical', 'neutral'));
    legend.appendChild(swatch(DIV_CURVE[2], 'More curve'));
  } else {
    const depths = [...new Set(a.nfc.items.map(p => Math.abs(p.value)).filter(Boolean))].sort((p, q) => p - q);
    legend.appendChild(el('span', 'viz-legend-caption', 'NFC depth'));
    depths.forEach(dp => legend.appendChild(swatch(nfcColor(dp, maxDepth).fill, fmtNum(dp))));
    legend.appendChild(swatch(null, 'Changed on site', 'changed'));
  }
  c.appendChild(legend);
  return c;
}

function renderPerDate(a) {
  const c = card('Date by date', 'How closely each date ran the typical angle at every box.');
  const rows = a.perDate.map(p => {
    const d = p.run.date;
    const tr = el('tr');
    const link = el('a', null, d.date);
    link.href = '/' + encodeURIComponent(SHOW_SLUG) + '/' + encodeURIComponent(d.slug);
    tr.appendChild(td(null, link));
    tr.appendChild(td('muted', d.venue || '—'));
    tr.appendChild(td('num', String(p.run.len)));
    tr.appendChild(td('num', fmtDeg(p.totalSplay)));
    tr.appendChild(meterCell(p.match));
    tr.appendChild(td('num', p.offCount ? String(p.offCount) : '—'));
    tr.appendChild(td('num', p.biggest ? `${boxLabel(p.biggest.box, a)} · ${fmtDeg(p.biggest.typical)} → ${fmtDeg(p.biggest.splay)}` : '—'));
    tr.appendChild(td('num muted', p.nfcOnset ? `${boxLabel(p.nfcOnset, a)} · ${fmtDeg(p.nfcOnset.splay)}` : '—'));
    return tr;
  });
  c.appendChild(tableWrap(['Date', 'Venue', 'Boxes', 'Total splay', 'On typical', 'Boxes changed', 'Biggest change', 'NFC starts'], rows));
  return c;
}

function renderAngleChanges(a) {
  const c = card(`Angle changes (${a.angleChanges.length})`,
    'Every box that ran something other than its typical angle, by box.', { collapsible: true });
  if (!a.angleChanges.length) {
    c.appendChild(el('p', 'report-empty', 'Every box ran its typical angle on every date.'));
    return c;
  }
  const sorted = [...a.angleChanges].sort((p, q) => a.slots.indexOf(p.slot) - a.slots.indexOf(q.slot));
  const rows = sorted.map(ch => {
    const tr = el('tr');
    tr.appendChild(td('num strong', boxLabel(ch.box, a)));
    tr.appendChild(td(null, `${shortDate(ch.run.date)}${ch.run.date.venue ? ' · ' + ch.run.date.venue : ''}`));
    tr.appendChild(td('num muted', fmtDeg(ch.typical)));
    tr.appendChild(td('num strong', fmtDeg(ch.splay)));
    tr.appendChild(td('num', `${fmtDelta(ch.delta)} ${ch.delta < 0 ? 'flatter' : 'more curve'}`));
    tr.appendChild(td('num muted', `${ch.run.len} boxes`));
    return tr;
  });
  c.appendChild(tableWrap(['Box', 'Date', 'Typical', 'Ran', 'Change', 'Hang length'], rows));
  return c;
}

// --- NFC (secondary) ------------------------------------------------------------

function renderNfc(a) {
  const n = a.nfc;
  const c = card('NFC vs. splay',
    'How the NFC filter tracked each box’s joint angle, on dates with NFC recorded.', { collapsible: true });
  if (!n.items.length) {
    c.appendChild(el('p', 'report-empty', 'No NFC recorded on this hang for the selected dates.'));
    return c;
  }
  const facts = el('div', 'report-facts');
  const fact = (label, value) => {
    const f = el('div', 'report-fact');
    f.appendChild(el('span', 'report-fact-value', value));
    f.appendChild(el('span', 'report-fact-label', label));
    return f;
  };
  facts.appendChild(fact('dates with NFC', `${n.withNfc.length} of ${a.runs.length}`));
  facts.appendChild(fact(n.onsetRange && n.onsetRange[0] !== n.onsetRange[1] ? `NFC starts (median, ${fmtDeg(n.onsetRange[0])}–${fmtDeg(n.onsetRange[1])})` : 'NFC starts', fmtDeg(n.onsetMedian)));
  facts.appendChild(fact('follow the typical NFC for their splay', fmtPct(n.consistency)));
  facts.appendChild(fact('splay ↔ NFC depth (Spearman ρ)', fmtRho(n.rho)));
  c.appendChild(facts);

  const splays = n.ruleList.map(r => r.group);
  const bubbles = [];
  n.ruleList.forEach(r => r.counts.forEach((cnt, nfc) => bubbles.push({
    x: r.group, y: nfc, count: cnt.count,
    title: `${fmtDeg(r.group)} splay · NFC ${fmtNfc(nfc)}`,
    lines: () => [
      { value: String(cnt.count), label: cnt.count === 1 ? 'box' : 'boxes' },
      { value: String(cnt.dates.size), label: cnt.dates.size === 1 ? 'date' : 'dates' },
      { value: fmtPct(cnt.count / r.n), label: `of boxes at ${fmtDeg(r.group)}` },
    ],
  })));
  const vals = n.items.map(p => p.value);
  const yMin = Math.floor(Math.min(0, ...vals) / 2) * 2, yMax = Math.ceil(Math.max(0, ...vals) / 2) * 2;
  c.appendChild(bubbleChart({
    xs: splays, xLabel: v => fmtNum(v) + '°', yMin, yMax: yMax === yMin ? yMin + 2 : yMax, yStep: 2,
    yLabel: v => fmtNum(v), xTitle: 'Splay angle to the box above', yTitle: 'NFC', bubbles,
    line: n.ruleList.map(r => ({ x: r.group, y: r.value })), ariaLabel: `Splay versus NFC for ${a.key}`,
  }));
  const legend = el('div', 'viz-legend');
  legend.appendChild(legendItem('viz-key-dot', 'Boxes (size = how often)'));
  legend.appendChild(legendItem('viz-key-line', 'Typical NFC at that splay'));
  c.appendChild(legend);

  const ruleRows = n.ruleList.map(r => {
    const tr = el('tr');
    tr.appendChild(td('num', fmtDeg(r.group)));
    tr.appendChild(td('num strong', fmtNfc(r.value)));
    tr.appendChild(meterCell(r.agree));
    tr.appendChild(td('num', String(r.n)));
    const others = [...r.counts.entries()].filter(([v]) => v !== r.value)
      .sort((p, q) => q[1].count - p[1].count).map(([v, cnt]) => `${fmtNfc(v)} ×${cnt.count}`).join(', ');
    tr.appendChild(td('muted', others || '—'));
    return tr;
  });
  c.appendChild(tableWrap(['Splay', 'Typical NFC', 'Agreement', 'Boxes', 'Also used'], ruleRows));

  const grid = el('div', 'report-exceptions');
  const dev = el('div');
  dev.appendChild(el('h4', null, `Off the typical NFC (${n.deviations.length})`));
  if (!n.deviations.length) dev.appendChild(el('p', 'report-empty', 'Every box matched the typical NFC for its splay.'));
  else {
    dev.appendChild(tableWrap(['Date', 'Box', 'Splay', 'NFC', 'Typical'], n.deviations.map(it => {
      const tr = el('tr');
      tr.appendChild(td(null, shortDate(it.run.date)));
      tr.appendChild(td('num', boxLabel(it.box, a)));
      tr.appendChild(td('num', fmtDeg(it.group)));
      tr.appendChild(td('num strong', fmtNfc(it.value)));
      tr.appendChild(td('num muted', fmtNfc(n.rule.get(it.group).value)));
      return tr;
    })));
  }
  grid.appendChild(dev);
  const chg = el('div');
  chg.appendChild(el('h4', null, `NFC changed on site (${n.changes.length})`));
  if (!n.changes.length) {
    chg.appendChild(el('p', 'report-empty',
      'None recorded. To log one, open a date and type the NFC that actually ran into that box’s NFC cell.'));
  } else {
    chg.appendChild(tableWrap(['Date', 'Box', 'Splay', 'Sheet', 'Ran'], n.changes.map(({ run, box }) => {
      const tr = el('tr');
      tr.appendChild(td(null, shortDate(run.date)));
      tr.appendChild(td('num', boxLabel(box, a)));
      tr.appendChild(td('num', fmtDeg(box.splay)));
      tr.appendChild(td('num muted', fmtNfc(box.nfc_sheet === null ? 0 : box.nfc_sheet)));
      tr.appendChild(td('num strong', fmtNfc(nfcVal(box))));
      return tr;
    })));
  }
  grid.appendChild(chg);
  c.appendChild(grid);
  return c;
}

// --- Page -------------------------------------------------------------------

// One segmented control style for every choice on the page: a pill track
// with the active option filled. `label` names the group (shown as a small
// caption unless `hideLabel`).
function segmented(label, options, current, onChange, { hideLabel = false } = {}) {
  const seg = el('div', 'report-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  options.forEach(([value, text]) => {
    const b = el('button', 'report-seg-btn' + (value === current ? ' is-active' : ''), text);
    b.type = 'button';
    b.setAttribute('aria-pressed', value === current ? 'true' : 'false');
    b.addEventListener('click', () => onChange(value));
    seg.appendChild(b);
  });
  return hideLabel ? seg : field(label, seg);
}

// A captioned control: small label, then the control.
function field(label, control) {
  const f = el('div', 'report-field');
  f.appendChild(el('span', 'report-field-label', label));
  f.appendChild(control);
  return f;
}

// Every hang length (box count) in the selected dates, across all hangs
// that have joint angles: Map len -> {hangs: count of hang-dates, keys}.
function hangSizes(dates) {
  const sizes = new Map();
  dates.forEach(d => d.hangs.forEach(h => {
    if (!h.boxes.some(b => b.splay !== null)) return;
    const s = sizes.get(h.boxes.length) || { hangs: 0, keys: new Set() };
    s.hangs++; s.keys.add(h.key);
    sizes.set(h.boxes.length, s);
  }));
  return new Map([...sizes.entries()].sort((p, q) => p[0] - q[0]));
}

// The page-wide box-count filter currently in effect, or null for all --
// falls back to all if the saved size isn't in the selected dates.
function activeSize(sizes) {
  const s = PREFS.size && PREFS.size !== 'all' ? +PREFS.size : null;
  return s !== null && sizes.has(s) ? s : null;
}

// Hang size filter -- the whole page (every hang, chart, table, the CSV
// and print) limited to hangs of one box count, so a 12-box hang is only
// compared with other 12-box hangs. A dropdown: real tours run many sizes.
function renderSizeFilterBar(sizes, size, mixed) {
  const host = document.getElementById('sizeFilter');
  host.innerHTML = '';
  host.hidden = sizes.size < 2;
  const hintEl = document.getElementById('filterHint');
  hintEl.innerHTML = '';
  hintEl.hidden = true;
  if (sizes.size < 2) return;
  const total = [...sizes.values()].reduce((n, s) => n + s.hangs, 0);
  const select = el('select', 'report-select');
  select.setAttribute('aria-label', 'Hang size');
  select.appendChild(new Option(`All sizes (${total})`, 'all'));
  sizes.forEach((s, len) => select.appendChild(new Option(`${len} boxes (${s.hangs})`, String(len))));
  select.value = size ? String(size) : 'all';
  select.addEventListener('change', () => { PREFS.size = select.value; savePrefs(); render(); });
  host.appendChild(field('Hang size', select));
  // Mixed lengths on one hang and not lined up by zone yet: offer it --
  // it's the mode that compares different box counts fairly.
  if (!size && mixed && PREFS.align !== 'zones') {
    hintEl.appendChild(document.createTextNode('Mixed hang sizes: zones line boxes up by the job they do (Far-Field, Mid-Field, Near-Field), not their number. '));
    const btn = el('button', 'report-link-btn', 'Line up by zone');
    btn.type = 'button';
    btn.addEventListener('click', () => { PREFS.align = 'zones'; savePrefs(); render(); });
    hintEl.appendChild(btn);
    hintEl.hidden = false;
  }
}

function renderHangTabs(keys) {
  const tabs = document.getElementById('hangTabs');
  tabs.innerHTML = '';
  keys.forEach(k => {
    const b = el('button', 'report-seg-btn' + (k === ACTIVE_HANG ? ' is-active' : ''), k);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', k === ACTIVE_HANG ? 'true' : 'false');
    b.addEventListener('click', () => { ACTIVE_HANG = k; render(); });
    tabs.appendChild(b);
  });
}

function renderAlignToggle() {
  const host = document.getElementById('alignToggle');
  host.innerHTML = '';
  host.appendChild(segmented('Line up boxes by', [['top', 'Top'], ['bottom', 'Bottom'], ['zones', 'Zones']], PREFS.align,
    v => { PREFS.align = v; savePrefs(); render(); }));
  if (PREFS.align !== 'zones') return;
  host.appendChild(stepper(ZONE_NAMES.far, 'top boxes', 'far'));
  host.appendChild(stepper(ZONE_NAMES.near, 'bottom boxes', 'near'));
  host.appendChild(segmented('Label boxes', [['array', 'Absolute'], ['function', 'Zone']], PREFS.labels,
    v => { PREFS.labels = v; savePrefs(); render(); }));
}

// Compact −/+ control for a zone size (PREFS[key], 1-8 boxes).
function stepper(label, unit, key) {
  const wrap = el('div', 'report-stepper');
  const make = (text, delta, aria) => {
    const b = el('button', 'report-stepper-btn', text);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.disabled = PREFS[key] + delta < 1 || PREFS[key] + delta > 8;
    b.addEventListener('click', () => { PREFS[key] += delta; savePrefs(); render(); });
    return b;
  };
  wrap.appendChild(make('−', -1, `Fewer ${unit}`));
  wrap.appendChild(el('span', 'report-stepper-value', String(PREFS[key])));
  wrap.appendChild(make('+', 1, `More ${unit}`));
  return field(`${label} (${unit})`, wrap);
}

// How much curve (sum of joint angles) each zone got on each date. This is
// the zone-level answer to "was the array doing the same job every night",
// independent of box count: the far zone's curve on a 12 is directly
// comparable to a 16's, even though the middle has a different box count.
function renderZoneCurve(a) {
  // Far = the top PREFS.far boxes (back of the room), near = the bottom
  // PREFS.near (closest seats), middle = everything between.
  const c = card('Curve by zone', `Sum of joint angles per zone, shaded against the tour median. ${ZONE_NAMES.far} = top ${PREFS.far}, ${ZONE_NAMES.near} = bottom ${PREFS.near}.`);
  c.classList.add('report-card-zones');
  if (!a.zoneCurve.length) return c;
  const med = a.zoneMedian;
  const zones = [['far', ZONE_NAMES.far], ['mid', ZONE_NAMES.mid], ['near', ZONE_NAMES.near], ['total', 'Total']];
  const maxDelta = Math.max(1, ...a.zoneCurve.flatMap(z => zones.map(([k]) => Math.abs(z[k] - med[k]))));

  const table = el('table', 'report-heat');
  const head = el('tr');
  head.appendChild(el('th', 'report-heat-date', 'Date'));
  zones.forEach(([, label]) => head.appendChild(el('th', null, label)));
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  const medRow = el('tr', 'report-heat-median');
  medRow.appendChild(el('th', 'report-heat-date', 'Median'));
  zones.forEach(([k]) => medRow.appendChild(el('td', null, fmtDeg(med[k]))));
  body.appendChild(medRow);
  a.zoneCurve.forEach(z => {
    const tr = el('tr');
    const dateCell = el('th', 'report-heat-date');
    dateCell.appendChild(el('span', null, shortDate(z.run.date)));
    if (z.run.date.venue) dateCell.appendChild(el('span', 'report-heat-venue', z.run.date.venue));
    tr.appendChild(dateCell);
    zones.forEach(([k, label]) => {
      const cell = el('td', null, fmtDeg(z[k]));
      cell.tabIndex = 0;
      const d = z[k] - med[k];
      const color = deltaColor(d, maxDelta);
      if (color) { cell.style.background = color.fill; cell.style.color = color.ink; }
      attachTip(cell, `${shortDate(z.run.date)}${z.run.date.venue ? ' · ' + z.run.date.venue : ''} · ${label}`, () => {
        const lines = [{ value: fmtDeg(z[k]), label: 'curve' }, { value: fmtDeg(med[k]), label: 'tour median' }];
        if (d) lines.push({ value: fmtDelta(d), label: d < 0 ? 'flatter' : 'more curve' });
        if (k === 'mid') lines.push({ value: String(z.midBoxes), label: 'mid-field boxes' });
        lines.push({ value: String(z.run.len), label: 'boxes in the hang' });
        return lines;
      });
      tr.appendChild(cell);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  const wrap = el('div', 'report-table-wrap');
  wrap.appendChild(table);
  c.appendChild(wrap);
  return c;
}

function renderDatePicker() {
  const list = document.getElementById('dateCheckList');
  list.innerHTML = '';
  REPORT.dates.forEach(d => {
    const label = el('label', 'report-date-option');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !EXCLUDED.has(d.slug);
    cb.addEventListener('change', () => {
      if (cb.checked) EXCLUDED.delete(d.slug); else EXCLUDED.add(d.slug);
      saveExcluded();
      render();
    });
    label.appendChild(cb);
    label.appendChild(el('span', null, d.date));
    if (d.venue) label.appendChild(el('span', 'muted', d.venue));
    list.appendChild(label);
  });
  const n = includedDates().length;
  document.getElementById('datePickerSummary').textContent = `Dates (${n} of ${REPORT.dates.length})`;
}

function render() {
  hideTooltip();
  const dates = includedDates();
  const sizes = hangSizes(dates);
  const size = activeSize(sizes);
  // With a size picked, only hangs that ran at that size get a tab.
  const keys = hangKeys(dates).filter(k => size === null || sizes.get(size).keys.has(k));
  if (!keys.includes(ACTIVE_HANG)) ACTIVE_HANG = keys[0] || null;
  const mixed = keys.some(k => [...sizes.values()].filter(s => s.keys.has(k)).length > 1);
  renderHangTabs(keys);
  renderAlignToggle();
  renderSizeFilterBar(sizes, size, mixed);
  renderDatePicker();

  const first = dates.find(d => d.iso), last = [...dates].reverse().find(d => d.iso);
  document.getElementById('reportSub').textContent = dates.length
    ? `${dates.length} date${dates.length === 1 ? '' : 's'}${first && last ? `, ${first.date} – ${last.date}` : ''}${size ? `, ${size}-box hangs only` : ''}. Box-by-box angles across the tour.`
    : 'No dates selected.';

  const body = document.getElementById('reportBody');
  body.innerHTML = '';
  if (!keys.length) {
    body.appendChild(el('p', 'report-empty', 'No hangs with splay angles in the selected dates.'));
    return;
  }
  // Every hang is rendered; only the active one shows on screen, and print
  // shows them all (see .report-hang in style.css).
  keys.forEach(k => {
    const a = analyzeHang(k, dates, size);
    const section = el('div', 'report-hang' + (k === ACTIVE_HANG ? ' is-active' : ''));
    section.appendChild(el('h2', 'report-hang-title', a.size ? `${k} · ${a.size}-box hangs` : k));
    section.appendChild(renderStats(a));
    // Shape and zone curve side by side: the drawing is tall and narrow,
    // and the two answer the same question (how the hang was shaped).
    const pair = el('div', 'report-pair');
    pair.appendChild(renderShape(a));
    pair.appendChild(renderZoneCurve(a));
    section.appendChild(pair);
    section.appendChild(renderAngleChart(a));
    section.appendChild(renderGrid(a));
    section.appendChild(renderPerDate(a));
    section.appendChild(renderAngleChanges(a));
    section.appendChild(renderNfc(a));
    body.appendChild(section);
  });
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One row per box per date, with both top- and bottom-counted box numbers
// regardless of the on-screen toggle, so the file works for either
// analysis in a spreadsheet. Follows the page's Dates and Hang size
// filters -- the CSV is the page's export.
function exportCsv() {
  const dates = includedDates();
  const size = activeSize(hangSizes(dates));
  const savedAlign = PREFS.align;
  const rows = [['show', 'date', 'iso_date', 'venue', 'address', 'hang', 'hang_title', 'hang_length',
    'box_from_top', 'box_from_bottom', 'zone', 'zone_box', 'model', 'dispersion', 'splay_deg',
    'typical_splay_from_top', 'splay_change_from_top', 'typical_splay_from_bottom', 'splay_change_from_bottom',
    'nfc_sheet', 'nfc_run', 'nfc_changed_on_site', 'typical_nfc_for_splay']];
  const byAlign = {};
  ['top', 'bottom'].forEach(al => {
    PREFS.align = al;
    byAlign[al] = new Map(hangKeys(dates).map(k => [k, analyzeHang(k, dates, size)]));
  });
  PREFS.align = savedAlign;
  byAlign.top.forEach((a, k) => {
    const b2 = byAlign.bottom.get(k);
    a.runs.forEach(r => r.boxes.forEach(b => {
      const fromBottom = r.len - b.top + 1;
      const tTop = a.typicalAngle.get(b.top).value;
      const tBot = b2.typicalAngle.get(fromBottom).value;
      const nfcRule = a.nfc.rule.get(b.splay);
      rows.push([
        REPORT.show.name, r.date.date, r.date.iso || '', r.date.venue, r.date.address, k, r.hang.name, r.len,
        b.top, fromBottom, ZONE_NAMES[b.zone.section],
        ({ far: 'F', mid: 'M', near: 'N' })[b.zone.section] + (b.zone.section === 'mid' ? `${b.zone.index} of ${b.zone.of}` : b.zone.index),
        b.model, b.dispersion, b.splay,
        tTop, b.splay - tTop, tBot, b.splay - tBot,
        r.hasNfc ? (b.nfc_sheet === null ? 0 : b.nfc_sheet) : '',
        r.hasNfc ? nfcVal(b) : '',
        b.nfc_changed ? 'yes' : '',
        r.hasNfc && nfcRule ? nfcRule.value : '',
      ]);
    }));
  });
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${SHOW_SLUG}-tour-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadExcluded() {
  try {
    const raw = localStorage.getItem(EXCLUDED_KEY);
    if (raw !== null) return new Set(JSON.parse(raw));
  } catch (e) {}
  // First visit: leave out entries whose "date" isn't a real date -- those
  // are test/scratch dates, not shows on the tour.
  return new Set(REPORT.dates.filter(d => !d.iso).map(d => d.slug));
}
function saveExcluded() {
  try { localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...EXCLUDED])); } catch (e) {}
}
function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (['top', 'bottom', 'zones'].includes(raw.align)) PREFS.align = raw.align;
    if (Number.isInteger(raw.far) && raw.far >= 1 && raw.far <= 8) PREFS.far = raw.far;
    if (Number.isInteger(raw.near) && raw.near >= 1 && raw.near <= 8) PREFS.near = raw.near;
    if (raw.labels === 'function' || raw.labels === 'array') PREFS.labels = raw.labels;
    if (raw.shade === 'angle' || raw.shade === 'nfc') PREFS.shade = raw.shade;
    if (raw.overlay && typeof raw.overlay === 'object') PREFS.overlay = raw.overlay;
    if (typeof raw.size === 'string') PREFS.size = raw.size;
  } catch (e) {}
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS)); } catch (e) {}
}

document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
document.getElementById('printReportBtn').addEventListener('click', () => window.print());
// Paper can't expand a collapsed section, so print opens them all and puts
// back whatever the screen had closed.
let CLOSED_FOR_PRINT = [];
window.addEventListener('beforeprint', () => {
  CLOSED_FOR_PRINT = [...document.querySelectorAll('#reportBody details:not([open])')];
  CLOSED_FOR_PRINT.forEach(d => { d.open = true; });
});
window.addEventListener('afterprint', () => {
  CLOSED_FOR_PRINT.forEach(d => { d.open = false; });
  CLOSED_FOR_PRINT = [];
});
document.addEventListener('click', e => {
  const picker = document.getElementById('datePicker');
  if (picker.open && !picker.contains(e.target)) picker.open = false;
});

loadPrefs();
fetch('/api/shows/' + encodeURIComponent(SHOW_SLUG) + '/report')
  .then(r => r.json())
  .then(data => {
    REPORT = data;
    EXCLUDED = loadExcluded();
    render();
  })
  .catch(() => {
    document.getElementById('reportBody').appendChild(el('p', 'report-empty', 'Could not load the tour report.'));
  });
