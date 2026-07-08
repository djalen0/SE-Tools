// Pinning Sheet Editor -- webapp client. Ported from the local desktop
// editor's embedded script with no changes to the rendering/color/Hi-D
// logic (already tested there) -- only the additions needed to be a real
// webapp: upload instead of a local input/ folder, an empty state before
// anything's been uploaded, view-only mode for read-only links, and
// export streaming an actual .xlsx download instead of writing to a local
// output/ folder.

const FIELD_LABELS = {label:'Cab', model:'Model', dispersion:'Disp', angle:'Splay', circuit:'CKT', nfc:'NFC'};
let STATE = null;

// Read-only links: open the page as .../?view=1 to hand someone a
// look-but-don't-touch copy -- everything stays visible, but every input,
// upload, and Save control is disabled. Export is left enabled since
// downloading a copy doesn't touch the shared job.
const VIEW_ONLY = new URLSearchParams(location.search).get('view') === '1';

// The card grid is mobile-first: below this width cards always stack one
// per row (a "cards per row" setting of 2+ would be unreadably narrow on a
// phone), regardless of the user's cards_per_row preference -- only above
// it does that preference actually take effect. Re-renders on cross-over
// so rotating a phone or resizing a window updates the layout live.
const DESKTOP_MQL = window.matchMedia('(min-width: 700px)');
DESKTOP_MQL.addEventListener('change', () => render());

async function loadState() {
  const res = await fetch('/api/state');
  STATE = await res.json();
  render();
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
  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('emptyState');

  if (!STATE) {
    grid.style.display = 'none';
    emptyState.style.display = 'block';
    document.getElementById('colorPanel').innerHTML = '';
    document.getElementById('numberingPanel').innerHTML = '';
    applyViewOnlyLock();
    return;
  }
  grid.style.display = 'grid';
  emptyState.style.display = 'none';

  document.getElementById('cardsPerRow').value = STATE.cards_per_row;
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = DESKTOP_MQL.matches ? `repeat(${STATE.cards_per_row}, 1fr)` : '1fr';

  const cfg = STATE.circuit_color_config || {};
  const cycleLen = Math.max(1, Math.min(cfg.cycle_length || 4, (cfg.circuit_colors || []).length || 1));
  const activePalette = (cfg.circuit_colors || []).slice(0, cycleLen);

  STATE.sections.forEach(section => grid.appendChild(renderCard(section, cfg, activePalette, cycleLen)));
  renderColorPanel();
  renderNumberingPanel();
  applyViewOnlyLock();
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
  title.textContent = section.header;
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
        const input = document.createElement('input');
        input.type = 'text';
        input.value = cab.ckt || '';
        input.className = 'ckt-input';
        input.addEventListener('change', e => { cab.ckt = e.target.value; render(); });
        cell.appendChild(input);
        const setColor = circuitSetFillMap[cab._normalCkt !== undefined ? cab._normalCkt : cab.ckt];
        if (setColor) {
          const stripe = document.createElement('div');
          stripe.className = 'circuit-set-stripe';
          stripe.style.background = argbToCss(setColor);
          cell.appendChild(stripe);
        }
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
  // Compression/Tension/Hard Pin/Soft Pin used to get its own dedicated
  // spot under the card title -- now it's just the first metadata chip,
  // same visual treatment as everything else, ahead of Aim/Slider/etc.
  if (section.hanging_mode) {
    const row = document.createElement('div');
    row.className = 'meta-row';
    const l = document.createElement('div');
    l.className = 'meta-label';
    l.textContent = 'Mode';
    const v = document.createElement('div');
    v.className = 'meta-value';
    v.textContent = section.hanging_mode;
    row.appendChild(l); row.appendChild(v);
    meta.appendChild(row);
  }
  // A metadata field with no value is just an empty label chip floating in
  // the column -- skip it entirely instead of rendering "Aim:" with
  // nothing after it, so the column only ever shows fields this section
  // actually has data for.
  (STATE.metadata_fields || []).forEach(({label, key}) => {
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
    meta.appendChild(row);
  });
  body.appendChild(meta);

  content.appendChild(body);
  return card;
}

function renderColorPanel() {
  const panel = document.getElementById('colorPanel');
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Hi-D'});
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

  const paletteRow = document.createElement('div');
  paletteRow.className = 'swatchRow';
  paletteRow.appendChild(document.createTextNode('Circuit colors:'));
  (cfg.circuit_colors || []).forEach((hex, i) => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_colors[i] = cssToArgb(e.target.value); render(); saveState(false); });
    paletteRow.appendChild(inp);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_colors.splice(i,1); render(); saveState(false); });
    paletteRow.appendChild(rm);
  });
  const addColorBtn = document.createElement('button');
  addColorBtn.textContent = '+ color';
  addColorBtn.addEventListener('click', () => { (cfg.circuit_colors = cfg.circuit_colors || []).push('FFCCCCCC'); render(); saveState(false); });
  paletteRow.appendChild(addColorBtn);
  panel.appendChild(paletteRow);

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
  const cfg = STATE.circuit_color_config || (STATE.circuit_color_config = {enabled:false, show_row_fill:true, circuit_colors:[], cycle_length:4, hang_colors:[], circuit_set_enabled:false, circuit_set_colors:[], numbering_mode:'normal', hid_bundle_size:4, breakout_cable_name:'Hi-D'});
  const cableName = cfg.breakout_cable_name || 'Hi-D';
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
  nameInput.placeholder = 'Hi-D / Socapex / NL8...';
  nameInput.addEventListener('change', e => {
    cfg.breakout_cable_name = e.target.value.trim() || 'Hi-D';
    render();
    saveState(false);
  });
  nameRow.appendChild(nameInput);
  panel.appendChild(nameRow);

  const numberingModeRow = document.createElement('div');
  numberingModeRow.className = 'swatchRow';
  numberingModeRow.appendChild(document.createTextNode('Current numbering:'));
  const modeText = document.createElement('strong');
  modeText.textContent = cfg.numbering_mode === 'hid' ? cableName : 'Normal';
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
  convertBtn.textContent = goingToHiD ? `Convert to ${cableName} numbering` : 'Convert back to Normal numbering';
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

  const setPaletteRow = document.createElement('div');
  setPaletteRow.className = 'swatchRow';
  setPaletteRow.appendChild(document.createTextNode('Stripe colors:'));
  (cfg.circuit_set_colors || []).forEach((hex, i) => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = argbToCss(hex) || '#cccccc';
    inp.addEventListener('change', e => { cfg.circuit_set_colors[i] = cssToArgb(e.target.value); render(); saveState(false); });
    setPaletteRow.appendChild(inp);
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.addEventListener('click', () => { cfg.circuit_set_colors.splice(i,1); render(); saveState(false); });
    setPaletteRow.appendChild(rm);
  });
  const addSetColorBtn = document.createElement('button');
  addSetColorBtn.textContent = '+ color';
  addSetColorBtn.addEventListener('click', () => { (cfg.circuit_set_colors = cfg.circuit_set_colors || []).push('FFCCCCCC'); render(); saveState(false); });
  setPaletteRow.appendChild(addSetColorBtn);
  panel.appendChild(setPaletteRow);
}

async function saveState(showStatus) {
  if (!STATE) return;
  const res = await fetch('/api/state', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
  if (showStatus !== false) {
    if (res.ok) flashStatus('Saved');
    else flashStatus('Save failed');
  }
}

async function exportXlsx() {
  if (!STATE) return;
  await saveState(false);
  flashStatus('Exporting...');
  const res = await fetch('/api/export', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
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

async function uploadFile(file) {
  flashStatus('Uploading...');
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
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
  if (!VIEW_ONLY) return;
  document.getElementById('viewOnlyBanner').style.display = 'inline';
  document.getElementById('uploadLabel').style.display = 'none';
  document.getElementById('saveBtn').style.display = 'none';
  document.querySelectorAll('input, select').forEach(el => { el.disabled = true; });
  document.querySelectorAll('button').forEach(btn => {
    if (btn.id !== 'exportBtn' && btn.id !== 'colorToggleBtn' && btn.id !== 'numberingToggleBtn') {
      btn.disabled = true;
    }
  });
}

document.getElementById('cardsPerRow').addEventListener('change', e => {
  if (!STATE) return;
  STATE.cards_per_row = parseInt(e.target.value) || 1;
  render();
  saveState(false);
});
document.getElementById('saveBtn').addEventListener('click', () => saveState(true));
document.getElementById('exportBtn').addEventListener('click', exportXlsx);
document.getElementById('colorToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('colorPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('numberingToggleBtn').addEventListener('click', () => {
  const p = document.getElementById('numberingPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('uploadInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) uploadFile(file);
  e.target.value = '';
});

loadState();
