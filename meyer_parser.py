"""
Extracts pinning-sheet sections from a Meyer Sound MAPP 3D "System Report"
PDF export, producing the same `sections` list-of-dicts shape
pinning_parser.parse_pinning_data() and pdf_parser.extract_sections_from_pdf()
produce -- so build_job() and everything downstream needs zero changes to
accept this format too.

MAPP 3D's report has nothing like Canvas's side-by-side card layout: it's
one loudspeaker "System" (== one hang/section) after another, stacked
vertically, each made of three bordered tables in sequence -- a metadata
table ("Position and weight"), an "Array Elements" table (model/splay/
tilt/facing per element, top-to-bottom rig order), and a "Processing
Patch" table (model/processor/output-channel per element, same element
IDs as the Array Elements table). Because these tables are real
vector-bordered grids, pdfplumber's own extract_tables() reconstructs
their rows/columns reliably -- unlike pdf_parser.py's Canvas geometry
code, there's no need to hand-roll cell-boundary detection here.

The one real wrinkle: a hang's Processing Patch table can spill onto a
new PDF page with no header repeated (MAPP just continues the rows), so
this reads every page's tables as one continuous stream, tracking which
system/table it's currently inside rather than resetting per page.

Two fields Meyer reports that Canvas's schema has no column for both get
folded into existing columns rather than left on the floor:
  - "Output Channel N" (Processing Patch) is Meyer's ckt equivalent --
    multiple elements sharing one channel is exactly the "boxes sharing a
    circuit" concept pinning_parser.py's ckt field already models.
  - "Element Face" (Front/Rear -- which way a cardioid-array element
    points) has no dedicated column, so it rides in `dispersion`: blank
    for the (near-always) Front case, 'Rear' when flagged, which
    static/app.js's formatModelDispersion() already renders as
    "<model> (Rear)" verbatim since 'Rear' doesn't match its "<letter>
    <digits>" dispersion pattern.
Rear/Front Load and Total Weight map onto the existing weight_rear/
weight_front/total_weight fields; Distance to Base, Array Dimensions,
Grid tilt and Total splay have no xlsx-template column of their own, so
they're recorded under metadata_registry.py's EXTRA_METADATA_FIELDS keys
instead -- build_job() only surfaces one of those in the UI when at
least one parsed section actually has a value for it, so they show up
for a Meyer show without cluttering a Canvas show's Data Tags panel.
Meyer's raw rigging geometry (X/Y/Z rear/front points, roll/tilt/pan
rotation) is deliberately NOT captured -- those are MAPP's own 3D design
coordinates, not something a rigger reads off a printed pin sheet, and
capturing them would mean guessing at a schema for a use case nobody's
asked for yet. Add them the same way as the fields below if that changes.
"""
import re


SYSTEM_NAME_RE = re.compile(r'Loudspeaker System Name:\s*(.+)')
REAR_LOAD_RE = re.compile(r'Rear Load:\s*([\-\d.]+)\s*lb')
FRONT_LOAD_RE = re.compile(r'Front Load:\s*([\-\d.]+)\s*lb')
TOTAL_WEIGHT_RE = re.compile(r'Total Weight:\s*([\-\d.]+)\s*lb')
DISTANCE_TO_BASE_RE = re.compile(r'Distance to Base[^:]*:\s*([\-\d.]+)\s*ft')
ARRAY_DEPTH_HEADER_RE = re.compile(r'^Array depth\b')
GRID_TILT_RE = re.compile(r'Grid tilt:\s*([\-\d.]+)')
TOTAL_SPLAY_RE = re.compile(r'Total splay:\s*([\-\d.]+)')
FACING_SUFFIX_RE = re.compile(r'\s+(front|rear)\s+facing\s*$', re.IGNORECASE)
TRAILING_NUMBER_RE = re.compile(r'(\d+)\s*$')


def _row_cells(row):
    """Non-empty cell texts for one table row, in column order, with each
    cell's internal whitespace (including the newlines pdfplumber leaves
    in a word-wrapped cell, e.g. 'MG-PANTHER-\\nForward') collapsed to
    single spaces."""
    return [' '.join(c.split()) for c in row if c and c.strip()]


def _new_system():
    return {
        'name': None,
        'metadata_blob': '',
        'awaiting_array_dims': False,  # True right after the "Array depth / Array width / Array height" header row
        'extra': {},            # metadata_registry.py EXTRA_METADATA_FIELDS keys -> raw string value
        'elements': {},         # id (int) -> {model, splay, face}
        'patch': {},            # id (int) -> {model, channel}
        'element_order': [],    # ids in first-seen order
    }


def _consume_metadata_row(system, cells, joined):
    if system['awaiting_array_dims']:
        system['awaiting_array_dims'] = False
        if len(cells) >= 3:
            system['extra']['array_depth_ft'] = cells[0].replace('ft', '').strip()
            system['extra']['array_width_ft'] = cells[1].replace('ft', '').strip()
            system['extra']['array_height_ft'] = cells[2].replace('ft', '').strip()
        return
    if ARRAY_DEPTH_HEADER_RE.match(joined):
        system['awaiting_array_dims'] = True
        return
    system['metadata_blob'] += ' ' + joined


def _consume_element_row(system, cells, joined):
    # "Grid tilt: 0.00 Total splay: 52.50" -- the Array Elements table's
    # own header row, not an element row (no leading ID cell at all).
    if 'Grid tilt' in joined or 'Total splay' in joined:
        grid_tilt = GRID_TILT_RE.search(joined)
        total_splay = TOTAL_SPLAY_RE.search(joined)
        if grid_tilt:
            system['extra']['grid_tilt_deg'] = grid_tilt.group(1)
        if total_splay:
            system['extra']['total_splay_deg'] = total_splay.group(1)
        return
    if not cells or not cells[0].isdigit():
        return  # frame/group-header row (e.g. "MG-PANTHER-Forward") -- no element ID
    eid = int(cells[0])
    # cells: [id, model, splay_angle, element_tilt, face] -- element_tilt
    # (cumulative angle from the top of the array) is dropped: it has no
    # home in the existing schema and is redundant with splay anyway.
    model = cells[1] if len(cells) > 1 else ''
    splay = cells[2] if len(cells) > 2 else ''
    face = cells[4] if len(cells) > 4 else ''
    if eid not in system['elements']:
        system['element_order'].append(eid)
    system['elements'][eid] = {'model': model, 'splay': splay, 'face': face}


def _consume_patch_row(system, cells):
    if not cells or not cells[0].isdigit():
        return
    eid = int(cells[0])
    model = cells[1] if len(cells) > 1 else ''
    channel_text = cells[-1] if len(cells) > 2 else ''
    system['patch'][eid] = {'model': model, 'channel': channel_text}


def _build_section(system):
    section = {
        'header': system['name'],
        'hanging_mode': None,
        'cabinets': [],
        'metadata': {},
    }

    blob = system['metadata_blob']
    rear = REAR_LOAD_RE.search(blob)
    front = FRONT_LOAD_RE.search(blob)
    total = TOTAL_WEIGHT_RE.search(blob)
    distance = DISTANCE_TO_BASE_RE.search(blob)
    if rear:
        section['metadata']['weight_rear'] = round(float(rear.group(1)))
    if front:
        section['metadata']['weight_front'] = round(float(front.group(1)))
    if total:
        section['metadata']['total_weight'] = round(float(total.group(1)))
    if distance:
        section['metadata']['distance_to_base_ft'] = round(float(distance.group(1)), 2)

    for key in ('array_depth_ft', 'array_width_ft', 'array_height_ft', 'grid_tilt_deg', 'total_splay_deg'):
        raw = system['extra'].get(key)
        if raw:
            try:
                section['metadata'][key] = round(float(raw), 2)
            except ValueError:
                pass

    for eid in system['element_order']:
        el = system['elements'][eid]
        patch = system['patch'].get(eid, {})
        model = FACING_SUFFIX_RE.sub('', el['model']).strip()
        face = (el.get('face') or '').strip().lower()
        dispersion = 'Rear' if face == 'rear' else ''
        ckt_match = TRAILING_NUMBER_RE.search(patch.get('channel', ''))
        section['cabinets'].append({
            'position': eid,
            'model': model,
            'dispersion': dispersion,
            'splay': el.get('splay', ''),
            'ckt': ckt_match.group(1) if ckt_match else '',
            'nfc': '',
        })

    return section


def extract_sections_from_meyer_pdf(pdf_path):
    """
    Top-level entry point: reads every page of `pdf_path`, and returns the
    same `sections` list-of-dicts shape pinning_parser.parse_pinning_data()
    produces, one section per MAPP "Loudspeaker System", in document order.
    """
    import pdfplumber
    from pinning_parser import renumber_sections

    systems = []
    current = None
    mode = None  # None | 'metadata' | 'elements' | 'patch'

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    cells = _row_cells(row)
                    if not cells:
                        continue
                    joined = ' '.join(cells)

                    name_match = SYSTEM_NAME_RE.search(joined)
                    if name_match:
                        current = _new_system()
                        current['name'] = name_match.group(1).strip()
                        systems.append(current)
                        mode = 'metadata'
                        continue

                    if joined.startswith('Array Elements'):
                        mode = 'elements'
                        continue

                    if joined.startswith('Processing') and 'Patch' in joined:
                        mode = 'patch'
                        continue

                    if current is None:
                        continue

                    if mode == 'metadata':
                        _consume_metadata_row(current, cells, joined)
                    elif mode == 'elements':
                        _consume_element_row(current, cells, joined)
                    elif mode == 'patch':
                        _consume_patch_row(current, cells)

    sections = [_build_section(s) for s in systems if s['name']]
    renumber_sections(sections)
    return sections


def is_meyer_mapp3d_pdf(pdf_path):
    """
    Format sniff for the upload route: MAPP 3D stamps its own product name
    at the top of every report page, so that's a reliable, cheap signal to
    dispatch on without needing a manual "pick your manufacturer" step.
    """
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        if not pdf.pages:
            return False
        first_page_text = pdf.pages[0].extract_text() or ''
    return 'MAPP 3D' in first_page_text or 'MAPP3D' in first_page_text
