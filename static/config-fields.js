// Shared field definitions for the Colors / Circuit Numbering / Pick
// (Box) Groups settings groups, plus the shared option lists for Data Bar
// placement and Trim Units. Both the Show page's "Configure Pinning
// Sheets" modal (static/show.js, editing a Show's own default
// circuit_color_config) and the Date page's own Colors/Numbering/Pick
// Groups panels (static/app.js, editing that Date's circuit_color_config,
// seeded from the Show default) render from the SAME field list here --
// add a field once and it exists on both surfaces, instead of hand-editing
// two near-identical copies of the same panel and having them drift apart
// (which is how the Show page ended up missing "Label CKT as" and
// "Default leg order" for a while).
//
// A field descriptor is: { key, type, label, ...type-specific props,
// showIf?: fn(cfg)=>bool, get?: fn(cfg)=>rawValue, set?: fn(cfg,rawValue) }
// get/set let a field's on-screen value differ from its stored shape (see
// hid_reverse_order_default below, stored as a bool but shown as a
// asc/desc select).

const FLAT_FIELD_GROUPS = {
  colors: [
    { key: 'enabled', type: 'checkbox', label: 'Enable circuit coloring' },
    { key: 'show_row_fill', type: 'checkbox', label: 'Show color across whole row',
      get: cfg => cfg.show_row_fill !== false },
    { key: 'ink_friendly_patterns', type: 'checkbox', label: 'Use ink-friendly patterns (for black & white printing)' },
    { key: 'hang_colors', type: 'match-color-list', label: "Hang identity stripes (matched against each card's title)" },
    { key: 'circuit_colors', type: 'color-list', label: 'Circuit colors' },
    { key: 'cycle_length', type: 'number', label: 'Repeats after N colors:', min: 1, fallback: 4 },
  ],
  numbering: [
    { key: 'breakout_cable_name', type: 'text', label: 'Breakout cable name:', placeholder: 'Trunk Cable / Socapex / NL8...',
      get: cfg => cfg.breakout_cable_name || 'Trunk Cable',
      set: (cfg, v) => { cfg.breakout_cable_name = v.trim() || 'Trunk Cable'; } },
    { key: 'numbering_mode', type: 'select', label: 'Label CKT as:',
      options: cfg => [['normal', 'Actual circuit number'], ['hid', `${cfg.breakout_cable_name || 'Trunk Cable'} #`]],
      get: cfg => cfg.numbering_mode === 'hid' ? 'hid' : 'normal' },
    { key: 'hid_bundle_size', type: 'number', label: 'Circuits per breakout cable:', min: 1, fallback: 4 },
    { key: 'hid_reverse_order_default', type: 'select', label: 'Default leg order:',
      showIf: cfg => cfg.numbering_mode === 'hid',
      options: () => [['asc', 'Ascending (1,2,3,4)'], ['desc', 'Descending (4,3,2,1)']],
      get: cfg => cfg.hid_reverse_order_default === false ? 'asc' : 'desc',
      set: (cfg, v) => { cfg.hid_reverse_order_default = v !== 'asc'; } },
    { key: 'circuit_set_enabled', type: 'checkbox',
      label: cfg => `Show ${cfg.breakout_cable_name || 'Trunk Cable'} stripe` },
    { key: 'circuit_set_colors', type: 'color-list', label: 'Stripe colors' },
  ],
  pickGroups: [
    { key: 'pick_group_enabled', type: 'checkbox', label: 'Show pick group badges' },
    { key: 'pick_group_size', type: 'number', label: 'Boxes per pick (typical):', min: 1, fallback: 4,
      showIf: cfg => cfg.pick_group_enabled },
  ],
};

// Data Bar / Trim Units option lists -- the two surfaces keep their own
// renderers (Show sets a flat default; Date adds a leading "Default
// (currently X)" choice on top of it), but share these lists so a new mode
// or format only needs to be added in one place.
const DATA_BAR_MODES = ['side-left', 'side-right', 'bottom', 'hidden'];
const DATA_BAR_MODE_OPTIONS = [
  ['side-left', 'Side (left)'], ['side-right', 'Side (right)'], ['bottom', 'Bottom'], ['hidden', 'Hidden'],
];
const TRIM_UNIT_FORMATS = ['decimal', 'feet_inches'];
const TRIM_UNIT_FORMAT_OPTIONS = [['decimal', 'Decimal feet (e.g. 56.89 ft)'], ['feet_inches', 'Feet & inches (e.g. 56\' 11")']];
const TRIM_INCHES_PRECISIONS = ['whole', 'half', 'quarter'];
const TRIM_INCHES_PRECISION_OPTIONS = [['whole', 'Whole inch'], ['half', 'Half inch'], ['quarter', 'Quarter inch']];

function argbToCssShared(argb) {
  if (!argb) return null;
  const h = argb.replace('#', '');
  const rgb = h.length >= 6 ? h.slice(-6) : h.padStart(6, '0');
  return '#' + rgb;
}

function cssToArgbShared(css) {
  return 'FF' + css.replace('#', '').toUpperCase();
}

function resolveLabel(label, cfg) {
  return typeof label === 'function' ? label(cfg) : label;
}

function fieldValue(field, cfg) {
  return field.get ? field.get(cfg) : cfg[field.key];
}

function setFieldValue(field, cfg, rawValue) {
  if (field.set) field.set(cfg, rawValue);
  else cfg[field.key] = rawValue;
}

// Renders `fields` against `cfg` into `container`, rebuilding it from
// scratch (safe to call repeatedly, same convention every panel already
// used). `onChange(field, cfg)` fires after every edit -- app.js uses it
// to trigger live Hi-D renumbering and its own render()/saveState(); show.js
// (draft-only, saved on Apply) can omit it.
function renderFlatFieldList(container, fields, cfg, onChange) {
  container.innerHTML = '';
  const rerender = () => renderFlatFieldList(container, fields, cfg, onChange);
  const commit = (field, rawValue) => {
    setFieldValue(field, cfg, rawValue);
    if (onChange) onChange(field.key, cfg);
    rerender();
  };

  fields.forEach(field => {
    if (field.showIf && !field.showIf(cfg)) return;

    if (field.type === 'checkbox') {
      const row = document.createElement('label');
      row.className = 'swatchRow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!fieldValue(field, cfg);
      cb.addEventListener('change', e => commit(field, e.target.checked));
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + resolveLabel(field.label, cfg)));
      container.appendChild(row);
      return;
    }

    if (field.type === 'number') {
      const row = document.createElement('div');
      row.className = 'swatchRow';
      row.appendChild(document.createTextNode(resolveLabel(field.label, cfg)));
      const input = document.createElement('input');
      input.type = 'number';
      input.min = field.min != null ? field.min : '';
      if (field.step) input.step = field.step;
      input.value = fieldValue(field, cfg) || field.fallback || 0;
      input.addEventListener('change', e => commit(field, parseFloat(e.target.value) || field.fallback || 0));
      row.appendChild(input);
      container.appendChild(row);
      return;
    }

    if (field.type === 'text') {
      const row = document.createElement('div');
      row.className = 'swatchRow';
      row.appendChild(document.createTextNode(resolveLabel(field.label, cfg)));
      const input = document.createElement('input');
      input.type = 'text';
      input.value = fieldValue(field, cfg);
      if (field.placeholder) input.placeholder = field.placeholder;
      input.addEventListener('change', e => commit(field, e.target.value));
      row.appendChild(input);
      container.appendChild(row);
      return;
    }

    if (field.type === 'select') {
      const row = document.createElement('div');
      row.className = 'swatchRow';
      row.appendChild(document.createTextNode(resolveLabel(field.label, cfg)));
      const select = document.createElement('select');
      field.options(cfg).forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
      });
      select.value = fieldValue(field, cfg);
      select.addEventListener('change', e => commit(field, e.target.value));
      row.appendChild(select);
      container.appendChild(row);
      return;
    }

    if (field.type === 'color-list') {
      const label = document.createElement('div');
      label.className = 'panel-label';
      label.textContent = resolveLabel(field.label, cfg);
      container.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'swatch-grid';
      const list = cfg[field.key] || [];
      list.forEach((hex, i) => {
        const item = document.createElement('div');
        item.className = 'swatch-item';
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = argbToCssShared(hex) || '#cccccc';
        inp.addEventListener('change', e => {
          list[i] = cssToArgbShared(e.target.value);
          if (onChange) onChange(field.key, cfg);
          rerender();
        });
        item.appendChild(inp);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = 'x';
        rm.addEventListener('click', () => { list.splice(i, 1); if (onChange) onChange(field.key, cfg); rerender(); });
        item.appendChild(rm);
        grid.appendChild(item);
      });
      container.appendChild(grid);
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+ color';
      addBtn.addEventListener('click', () => {
        (cfg[field.key] = cfg[field.key] || []).push('FFCCCCCC');
        if (onChange) onChange(field.key, cfg);
        rerender();
      });
      container.appendChild(addBtn);
      return;
    }

    if (field.type === 'match-color-list') {
      const label = document.createElement('div');
      label.className = 'panel-label';
      label.textContent = resolveLabel(field.label, cfg);
      container.appendChild(label);
      const list = cfg[field.key] || [];
      list.forEach((entry, i) => {
        const row = document.createElement('div');
        row.className = 'swatchRow';
        const matchInp = document.createElement('input');
        matchInp.type = 'text';
        matchInp.placeholder = 'e.g. side';
        matchInp.value = entry.match || '';
        matchInp.addEventListener('change', e => { entry.match = e.target.value; if (onChange) onChange(field.key, cfg); });
        row.appendChild(matchInp);
        const colorInp = document.createElement('input');
        colorInp.type = 'color';
        colorInp.value = argbToCssShared(entry.fill) || '#ffffff';
        colorInp.addEventListener('change', e => { entry.fill = cssToArgbShared(e.target.value); if (onChange) onChange(field.key, cfg); rerender(); });
        row.appendChild(colorInp);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = 'x';
        rm.addEventListener('click', () => { list.splice(i, 1); if (onChange) onChange(field.key, cfg); rerender(); });
        row.appendChild(rm);
        container.appendChild(row);
      });
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+ hang stripe rule';
      addBtn.addEventListener('click', () => {
        (cfg[field.key] = cfg[field.key] || []).push({ match: '', fill: 'FFFFFFFF' });
        if (onChange) onChange(field.key, cfg);
        rerender();
      });
      container.appendChild(addBtn);
      return;
    }
  });
}
