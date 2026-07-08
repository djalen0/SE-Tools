"""
Extracts pinning-sheet sections directly from a Canvas/Cohesion PDF export,
producing the exact same `sections` list-of-dicts shape that
pinning_parser.parse_pinning_data() produces from a .txt export -- so
write_master_workbook() and everything downstream needs zero changes to
accept either input format.

Why this can't just reuse pinning_parser.py's text-based state machine
directly: a PDF page lays out 1-3 section "cards" side by side, and each
card's box list sits beside its own metadata block (not stacked below it).
Naively extracting a PDF's text top-to-bottom, left-to-right across the
whole page interleaves all of that -- row 1 of card A, row 1 of card B, row
1 of card C, row 2 of card A, ... -- which is nothing like the strictly
linear, one-thing-after-another format the .txt parser expects.

So this module first reconstructs *geometry*: which words belong to which
card (via the vertical rule-lines pdfplumber exposes as `rects`), then
within a card, which physical table CELL each box-list word belongs to
(also via `rects` -- Canvas draws every cell border as its own tiny
rectangle, so the horizontal border segments of any one row give the exact
left/right edge of every column, cell by cell) rather than guessing column
boundaries from word spacing. That distinction matters: naive word-gap
clustering was tried first and silently merged the "Model" and
"Dispersion" columns in this export, because the gap between those two
columns (~2pt) is smaller than the gap Canvas leaves between some other
column's individual characters -- there's no gap-size threshold that gets
every column right. The real cell borders have no such ambiguity.
"""
import math
import re


HANG_MODE_VALUES = {'Compression', 'Tension', 'Hard Pin', 'Soft Pin'}

# Same header-detection convention as pinning_parser.py.
NUMBERED_HEADER_RE = re.compile(r'^\d+\.\s+[A-Z]+\s+-\s+')
BARE_HEADER_RE = re.compile(r'\((?:Pair|Single|Quad|Trio|Mono|Stereo)\)\s*$', re.IGNORECASE)


def _is_section_header_text(text):
    return bool(NUMBERED_HEADER_RE.match(text) or BARE_HEADER_RE.search(text))


def _extract_card_x_bands(page):
    """
    Every section "card" on a page is drawn as a fully-bordered table (a
    dense grid of little rectangle cell borders, one per cell -- this is how
    Canvas renders these tables, not as one big outer rectangle per card).
    Because the grid tiles edge-to-edge with no drawn cell in the margin
    between cards, a simple x-axis "is anything drawn here" occupancy scan
    still shows a clean gap between one card's rectangles and the next's --
    that gap is what this looks for, returning the list of (x0, x1) bands
    that actually have table content, left to right.
    """
    rects = page.rects
    width = int(page.width) + 2
    covered = [False] * width
    for r in rects:
        a, b = max(0, int(r['x0'])), min(width, int(r['x1']) + 1)
        for x in range(a, b):
            covered[x] = True

    bands = []
    x = 0
    while x < width:
        if covered[x]:
            start = x
            while x < width and covered[x]:
                x += 1
            bands.append((start, x))
        else:
            x += 1
    return bands


def _detect_box_cells(page, bx0, bx1):
    """
    Find the box-list's real column cell boundaries for one card, using the
    table's own vector-drawn borders rather than inferring them from word
    spacing. Every cell border is drawn as its own thin rectangle; the
    horizontal (wide, short) rectangles along any single row's top edge,
    read left to right, are exactly that row's column boundaries -- and
    since this is a rigid table, every row shares the same boundaries.

    Returns a list of (x0, x1) tuples for just the box-list columns (label,
    model/dispersion, splay, ckt, nfc -- however many are actually present),
    stopping before the wide metadata cell that follows them (identified as
    the single largest gap between consecutive cells).
    """
    cand = [
        r for r in page.rects
        if bx0 - 2 <= r['x0'] and r['x1'] <= bx1 + 2
        and (r['bottom'] - r['top']) < 2
        and r['top'] > 150
    ]
    if not cand:
        return []
    row_top = sorted(set(round(r['top'], 1) for r in cand))[0]
    segs = sorted([r for r in cand if abs(r['top'] - row_top) < 0.5], key=lambda r: r['x0'])
    all_cells = [(r['x0'], r['x1']) for r in segs]
    if len(all_cells) < 2:
        return all_cells

    gaps = [(all_cells[i + 1][0] - all_cells[i][1], i) for i in range(len(all_cells) - 1)]
    _, split_after = max(gaps)
    return all_cells[:split_after + 1]


def _group_by_row(words, row_tol=1):
    """Group words into visual rows by their vertical position ('top'),
    rounding to the nearest whole point -- table rows in these PDFs are
    consistently ~12-13pt apart, far more than enough separation for this
    rounding to never merge two real rows or split one real row in two."""
    rows = {}
    for w in words:
        key = round(w['top'] / row_tol) * row_tol
        rows.setdefault(key, []).append(w)
    return [sorted(rows[t], key=lambda w: w['x0']) for t in sorted(rows.keys())]


def _nearest_cell(word, cells):
    wc = (word['x0'] + word['x1']) / 2
    for i, (c0, c1) in enumerate(cells):
        if c0 - 1 <= wc <= c1 + 1:
            return i
    # Fall back to whichever cell center is closest (handles a value that
    # slightly overflows its own cell's drawn border).
    centers = [(c0 + c1) / 2 for c0, c1 in cells]
    return min(range(len(centers)), key=lambda i: abs(centers[i] - wc))


# Positional semantic role of each box-list cell, left to right, as Canvas
# always lays them out (Cab | Model/Dispersion | Splay | CKT | NFC). Not
# every card populates every cell (e.g. no cabinet in a section ever has an
# NFC value), but the *cells themselves* are always drawn -- so the cell
# count is trusted, and roles are simply truncated to however many cells
# were actually found on this card.
BOX_CELL_ROLES = ['label', 'model_dispersion', 'splay', 'ckt', 'nfc']


def _extract_card(card_words, box_cells):
    """
    Turn one card's raw words (already isolated to this card's x-band, and
    already excluding the page-level header/footer) into
    {'header', 'hanging_mode', 'cabinets', 'metadata', 'safety_alerts'} --
    the same shape pinning_parser.parse_pinning_data() produces per section.
    """
    rows = _group_by_row(card_words)
    if not rows:
        return None

    row_iter = iter(rows)

    # Row 1: section title (e.g. "1. MAIN - CO12(Pair)" or "CO8 1(Pair)").
    title_row = next(row_iter)
    title_text = ' '.join(w['text'] for w in title_row)
    if not _is_section_header_text(title_text):
        return None  # not actually a card (e.g. stray page furniture)

    section = {
        'header': title_text,
        'hanging_mode': None,
        'cabinets': [],
        'metadata': {},
    }

    # Row 2 (optional): hanging mode -- "Compression" / "Tension" /
    # "Hard Pin" / "Soft Pin". Peek at it; if it isn't one of those, it's
    # already the box-list header row and there's no mode to record.
    remaining_rows = list(row_iter)
    if remaining_rows:
        second_text = ' '.join(w['text'] for w in remaining_rows[0]).strip()
        if second_text in HANG_MODE_VALUES:
            section['hanging_mode'] = second_text
            remaining_rows = remaining_rows[1:]

    # Where the box list ends and the metadata block starts. The box
    # cells' own real right edge (from the PDF's vector-drawn cell borders)
    # is the authoritative boundary -- using it instead of inferring a
    # threshold from the "Aim" label's position avoids misclassifying long
    # metadata values (e.g. "OuterMiddleCardioid") that start well to the
    # left of "Aim" itself as box-list content. Only fall back to the
    # Aim-anchor heuristic if no box cells were found at all.
    if box_cells:
        meta_x_threshold = box_cells[-1][1] + 3
    else:
        aim_words = [w for row in remaining_rows for w in row if w['text'] == 'Aim']
        meta_x_threshold = (min(w['x0'] for w in aim_words) - 12) if aim_words else None

    # Split each row into its box-list portion and its metadata portion
    # *before* deciding whether this is the box-list header row -- the
    # "Aim" label actually sits on the exact same physical PDF row as the
    # "Cab Model() Splay CKT NFC" header text (Canvas draws it that way),
    # so checking the row's combined text and skipping the whole row
    # outright was silently dropping the "Aim" label along with the
    # header, leaving Aim's value with no label to attach to later.
    box_rows = []
    meta_rows = []
    for row in remaining_rows:
        if meta_x_threshold is not None:
            box_words = [w for w in row if w['x0'] < meta_x_threshold]
            meta_words = [w for w in row if w['x0'] >= meta_x_threshold]
        else:
            box_words, meta_words = row, []

        box_text = ' '.join(w['text'] for w in box_words)
        if box_text.startswith('*Array') or box_text == 'NOTES:':
            break  # footer/page furniture -- nothing real follows either column
        is_header_row = box_text.startswith('CabModel') or 'SplayCKT' in box_text
        if box_words and not is_header_row:
            box_rows.append(box_words)
        if meta_words:
            meta_rows.append(meta_words)

    _extract_cabinets(box_rows, box_cells, section)
    _extract_metadata(meta_rows, section)

    return section


def _extract_cabinets(box_rows, box_cells, section):
    """
    Cell-boundary-aware cabinet extraction. Every word is assigned to the
    real drawn table cell it falls inside (via `box_cells`, sourced from
    the PDF's own vector borders) rather than a fixed left-to-right token
    position -- so a row missing a value (e.g. a stacked sub cabinet with
    no splay entry) just leaves that one cell blank instead of shifting
    every value after it one slot to the left, which is what silently
    corrupted the circuit-number column under naive token counting.
    """
    if not box_rows:
        return

    roles = BOX_CELL_ROLES[:len(box_cells)] if box_cells else []
    if not roles:
        return

    # Auto-detected circuit grouping (mirrors pinning_parser.py's
    # detect_group_size/fill_remaining logic): a row containing *only* a
    # ckt-cell value (no model on that row) is a standalone circuit
    # announcement applying to however many boxes come right after it,
    # until the next such announcement.
    row_role_maps = []
    for row in box_rows:
        role_map = {}
        for w in row:
            idx = _nearest_cell(w, box_cells)
            if idx < len(roles):
                role = roles[idx]
                role_map[role] = (role_map[role] + ' ' + w['text']) if role in role_map else w['text']
        row_role_maps.append(role_map)

    def is_announcement(role_map):
        return 'ckt' in role_map and 'model_dispersion' not in role_map

    ann_positions = [i for i, rm in enumerate(row_role_maps) if is_announcement(rm)]
    if ann_positions:
        start = ann_positions[0]
        end = ann_positions[1] if len(ann_positions) >= 2 else len(row_role_maps)
        group_size = sum(1 for i in range(start + 1, end) if not is_announcement(row_role_maps[i]))
        group_size = group_size if group_size > 0 else 2
    else:
        group_size = 2

    pending_cabinet = None
    fill_ckt = None
    fill_remaining = 0
    position = 0

    for role_map in row_role_maps:
        if is_announcement(role_map):
            ckt = role_map.get('ckt', '')
            if pending_cabinet is not None:
                pending_cabinet['ckt'] = ckt
                pending_cabinet = None
            fill_ckt = ckt
            fill_remaining = group_size - 1
            continue

        if 'model_dispersion' not in role_map:
            continue  # stray row (shouldn't normally happen)

        model_disp = role_map['model_dispersion'].split(None, 1)
        model = model_disp[0] if model_disp else ''
        dispersion = model_disp[1] if len(model_disp) > 1 else ''

        position += 1
        cabinet = {
            'position': position,
            'model': model,
            'dispersion': dispersion,
            'splay': role_map.get('splay', ''),
            'ckt': role_map.get('ckt', ''),
            'nfc': role_map.get('nfc', ''),
        }
        if not cabinet['ckt']:
            if fill_remaining > 0:
                cabinet['ckt'] = fill_ckt
                fill_remaining -= 1
            else:
                pending_cabinet = cabinet
        section['cabinets'].append(cabinet)


# Reduces PDF-extracted label/value row pairs to the same flat
# list-of-line-strings shape pinning_parser.py works with, then hands off
# to its shared parse_metadata_field() for the actual field recognition --
# this used to be a near-verbatim duplicate of that logic maintained here
# separately (same keys, same "Alarm" -> safety_alerts behavior, kept in
# sync by hand across two files).
def _extract_metadata(meta_rows, section):
    from pinning_parser import parse_metadata_field
    lines = [' '.join(w['text'] for w in row) for row in meta_rows]

    i = 0
    n = len(lines)
    while i < n:
        consumed = parse_metadata_field(lines[i], lines, i, section)
        i += consumed if consumed else 1


def extract_sections_from_pdf(pdf_path):
    """
    Top-level entry point: reads every page of `pdf_path`, and returns the
    same `sections` list-of-dicts shape pinning_parser.parse_pinning_data()
    produces, in page/left-to-right order, renumbered sequentially exactly
    the way the .txt path does.
    """
    import pdfplumber
    from pinning_parser import renumber_sections

    sections = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            bands = _extract_card_x_bands(page)
            words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
            for (bx0, bx1) in bands:
                box_cells = _detect_box_cells(page, bx0, bx1)
                card_words = [
                    w for w in words
                    if bx0 <= (w['x0'] + w['x1']) / 2 <= bx1 and w['top'] > 100
                ]
                section = _extract_card(card_words, box_cells)
                if section is not None:
                    sections.append(section)

    renumber_sections(sections)
    return sections
