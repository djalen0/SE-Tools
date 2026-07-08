import math
import re

# A section header is either the numbered "1. MAIN - CO12(Pair)" style, or a
# bare "CO8 1(Pair)" style header. Both are recognized by the trailing
# parenthetical cabinet-count word (Pair/Single/Quad/Trio/etc.), which keeps
# this from colliding with metadata lines like "Wt (F)" or "Trim (T)".
NUMBERED_HEADER_RE = re.compile(r'^\d+\.\s+[A-Z]+\s+-\s+')
BARE_HEADER_RE = re.compile(r'\((?:Pair|Single|Quad|Trio|Mono|Stereo)\)\s*$', re.IGNORECASE)


def is_section_header(line):
    return bool(NUMBERED_HEADER_RE.match(line) or BARE_HEADER_RE.search(line))


# Strips any existing "N. " prefix off a header so it can be cleanly
# renumbered (some sections, like "CO8 1(Pair)", never had a number to begin
# with; others may repeat or skip numbers in the source text).
LEADING_NUMBER_RE = re.compile(r'^\d+\.\s*')


def renumber_sections(sections):
    """
    Give every section a unique, sequential number, regardless of whether the
    source text numbered it at all. This guarantees "1. MAIN...", "2. SIDE...",
    "3. REAR...", "4. CO8 1(Pair)", etc. every time, which keeps section
    references stable when this data is mapped into a spreadsheet.
    """
    for idx, section in enumerate(sections, start=1):
        name = LEADING_NUMBER_RE.sub('', section['header']).strip()
        section['section_number'] = idx
        section['section_name'] = name
        section['header'] = f"{idx}. {name}"


def is_cabinet_line(line):
    """A cabinet line starts with an integer position and has >= 4 fields."""
    parts = line.split()
    if len(parts) < 4:
        return False
    try:
        int(parts[0])
    except ValueError:
        return False
    return True


def has_inline_ckt(line):
    """True if the cabinet line already carries its own CKT value (field 5)."""
    parts = line.split()
    if len(parts) >= 5:
        try:
            float(parts[4])
            return True
        except ValueError:
            return False
    return False


# Every metadata field that could show up as "Alarm" instead of a number.
# Each one gets its own dedicated "<field>_alert" column in the CSV output
# (rather than one shared column), so a warning always has a specific,
# named header calling it out.
ALARM_CAPABLE_FIELDS = [
    'total_weight', 'weight_front', 'weight_rear',
    'trim_top', 'trim_bottom', 'trim',
    'angle_top', 'angle_bottom', 'angle',
    'pick_front', 'pick_rear', 'pick',
]


def parse_metric(raw, pattern, key, section):
    """
    Parse a metadata value that's normally numeric (weight, trim, angle, ...).
    Some sheets replace the value with the word "Alarm" to flag a safety
    condition (e.g. a channel reporting an over-weight or fault state)
    instead of a number. When that happens, leave the numeric field blank
    and record the field name in the section's safety_alerts list, so the
    dedicated "<field>_alert" column can flag it explicitly in the output.
    """
    match = re.search(pattern, raw)
    if match:
        return float(match.group(1))
    if 'alarm' in raw.lower():
        section.setdefault('safety_alerts', []).append(key)
    return None


def parse_metadata_field(line, lines, i, section):
    """
    Recognize one metadata field starting at lines[i] (the label line) and
    record it into section['metadata'] (or section['safety_alerts'] for an
    ALARM value), mutating `section` in place. Shared by both this
    plain-text parser (parse_pinning_data, below) and the PDF parser
    (pdf_parser.py's extract_sections_from_pdf) -- both reduce their input
    to this same flat list-of-line-strings shape before reaching here, just
    by different means (this file splits the raw .txt on newlines;
    pdf_parser.py groups words into rows by their on-page position first).
    Used to be duplicated near-verbatim in both files.

    Returns how many lines starting at i this field consumed (0 if `line`
    isn't a recognized metadata label at all, so the caller falls through to
    its own cabinet/section-header logic instead; 1 or 2 otherwise).
    """
    n = len(lines)
    if line == 'Aim':
        if i + 1 < n:
            section['metadata']['aim'] = lines[i + 1]
            return 2
        return 0
    if line == 'Slider':
        if i + 1 < n:
            section['metadata']['slider_position'] = lines[i + 1]
            return 2
        return 0
    if line == 'Rear':
        if i + 1 < n and re.match(r'^[\+\-]?\s*[\d.]+', lines[i + 1]):
            section['metadata']['rear'] = lines[i + 1]
            return 2
        section['metadata']['slider_position'] = 'Rear'
        return 1
    if line.startswith('Wt*'):
        if i + 1 < n:
            value = parse_metric(lines[i + 1], r'([\d.]+)lbs', 'total_weight', section)
            if value is not None:
                # Rounded UP to the nearest whole pound -- a shop scale never
                # needs fractional-pound precision, and this keeps the value
                # consistent everywhere it's shown (web editor and the
                # exported spreadsheet both read this same field).
                section['metadata']['total_weight'] = int(math.ceil(value))
            return 2
        return 0
    if line.startswith('Trim'):
        if i + 1 < n:
            key = 'trim_top' if '(T)' in line else 'trim_bottom' if '(B)' in line else 'trim'
            value = parse_metric(lines[i + 1], r'([\d.]+)ft', key, section)
            if value is not None:
                section['metadata'][key] = value
            return 2
        return 0
    if line.startswith('Angle'):
        if i + 1 < n:
            key = 'angle_top' if '(T)' in line else 'angle_bottom' if '(B)' in line else 'angle'
            value = parse_metric(lines[i + 1], r'([\d.]+)°', key, section)
            if value is not None:
                section['metadata'][key] = value
            return 2
        return 0
    if line.startswith('Pick'):
        if i + 1 < n:
            val = lines[i + 1].strip()
            if 'Δ' in val:
                val = val.replace('Δ', '').strip()
            key = 'pick_front' if '(F)' in line else 'pick_rear' if '(R)' in line else 'pick'
            try:
                section['metadata'][key] = int(val)
            except ValueError:
                if 'alarm' in val.lower():
                    section.setdefault('safety_alerts', []).append(key)
                else:
                    # Non-numeric pick value (e.g. "OuterMiddleCardioid") --
                    # keep it as-is rather than silently dropping it. (This
                    # parser used to drop it silently here; folding both
                    # parsers into this one shared function also fixes that
                    # gap, since pdf_parser.py's own copy already handled it
                    # this way.)
                    section['metadata'][key] = val
            return 2
        return 0
    if line.startswith('Wt (F)') or line.startswith('Wt (R)'):
        if i + 1 < n:
            key = 'weight_front' if '(F)' in line else 'weight_rear'
            value = parse_metric(lines[i + 1], r'([\d.]+)lbs', key, section)
            if value is not None:
                section['metadata'][key] = int(math.ceil(value))
            return 2
        return 0
    return 0


def parse_pinning_data(text):
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    n = len(lines)

    sections = []
    current_section = None
    i = 0

    def detect_group_size(start_idx):
        """
        Given the index of a standalone-number ("CKT") line, scan forward to
        find how many circuit boxes make up one group.

        Circuit-sharing sections look like:
            box (no ckt)      <- "opener"
            NUMBER             <- ckt for opener + next (G-1) boxes
            box, box, ...      <- (G-1) boxes that share the ckt above
            box                <- opener of the *next* group
            NUMBER
            ...

        So the box count strictly between one standalone number and the next
        equals the group size G (the G-1 shared boxes, plus the next group's
        opener). This lets the same code handle "2 box a circuit" and
        "4 box a circuit" (or any other N) without hardcoding which one a
        given file/section uses.
        """
        count = 0
        j = start_idx + 1
        while j < n:
            line = lines[j]
            if line.isdigit():
                return count if count > 0 else 2
            if is_cabinet_line(line):
                if has_inline_ckt(line):
                    break  # grouping run ended before a second number showed up
                count += 1
                j += 1
                continue
            break
        return count if count > 0 else 2

    while i < n:
        line = lines[i]

        if is_section_header(line):
            if current_section:
                sections.append(current_section)
            current_section = {
                'header': line,
                'hanging_mode': None,
                'cabinets': [],
                'metadata': {},
                'pending_cabinet': None,  # last ckt-less cabinet awaiting a circuit number
                'group_size': None,       # boxes-per-circuit, auto-detected per section
                'fill_remaining': 0,      # how many more boxes still get the current fill ckt
                'fill_ckt': None,
            }
            i += 1
            continue

        if not current_section:
            i += 1
            continue

        # Check for hanging mode
        if line in ['Compression', 'Tension', 'Hard Pin', 'Soft Pin']:
            current_section['hanging_mode'] = line
            i += 1
            continue

        # Check for column headers
        if 'Cab Model' in line or 'Splay' in line:
            i += 1
            continue

        # Check if line is just a number (CKT value shared across a group of boxes)
        if line.isdigit():
            ckt = line

            if current_section.get('group_size') is None:
                current_section['group_size'] = detect_group_size(i)

            if current_section.get('pending_cabinet'):
                current_section['pending_cabinet']['ckt'] = ckt
                current_section['pending_cabinet'] = None

            current_section['fill_ckt'] = ckt
            current_section['fill_remaining'] = current_section['group_size'] - 1
            i += 1
            continue

        # Check if this is a cabinet line
        parts = line.split()
        if len(parts) >= 4:
            try:
                pos = int(parts[0])
                model = parts[1]
                dispersion = parts[2]
                splay = parts[3]

                # Check if CKT and NFC are on this line
                ckt = None
                nfc = None

                if len(parts) >= 5:
                    try:
                        float(parts[4])
                        ckt = parts[4]
                        if len(parts) >= 6:
                            try:
                                float(parts[5])
                                nfc = parts[5]
                            except ValueError:
                                pass
                    except ValueError:
                        pass

                cabinet = {
                    'position': pos,
                    'model': model,
                    'dispersion': dispersion,
                    'splay': splay,
                    'ckt': ckt if ckt else '',
                    'nfc': nfc if nfc else ''
                }

                if not ckt:
                    # This cabinet needs a ckt from a group circuit number.
                    if current_section.get('fill_remaining', 0) > 0:
                        cabinet['ckt'] = current_section['fill_ckt']
                        current_section['fill_remaining'] -= 1
                    else:
                        # Becomes the opener of the next group, awaiting a number.
                        current_section['pending_cabinet'] = cabinet

                current_section['cabinets'].append(cabinet)
                i += 1
                continue
            except ValueError:
                pass

        # Check for metadata fields -- shared with pdf_parser.py via
        # parse_metadata_field() (see above), since both parsers reduce
        # their input to this same flat list-of-line-strings shape before
        # reaching this point.
        consumed = parse_metadata_field(line, lines, i, current_section)
        if consumed:
            i += consumed
            continue

        # Skip notes
        if line.startswith('*Array') or line.startswith('NOTES:'):
            i += 1
            continue

        i += 1

    if current_section:
        sections.append(current_section)

    renumber_sections(sections)

    return sections
