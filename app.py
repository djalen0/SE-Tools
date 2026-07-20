"""
Pinning Sheet Editor -- webapp version.

Shows/dates model: content is organized Home -> Show -> Date, matching the
breadcrumb in the UI. Each Show (e.g. a tour) has its own folder under
data/shows/<show-slug>/, and each Date within it (e.g. a specific show day)
has its own job.json under data/shows/<show-slug>/dates/<date-slug>/ -- its
own URL, its own persisted state. Within one Date, it's still the same
single-shared-job model as before: one person edits at a time, everyone
else either waits their turn or opens the same URL with ?view=1 for a
read-only copy. There's no concurrent-edit merging, by design (see
DEPLOY.md) -- if two people save at the same time, the second save simply
wins, same as it would editing a single shared Google Sheet tab with no one
watching for conflicts.

All the actual pinning-sheet logic (parsing, layout scanning, coloring,
Hi-D/breakout numbering, Excel writing) is untouched from the desktop tool --
this file is just the HTTP surface around it: upload a file in, edit state,
export a file out.
"""
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import date as date_cls, timedelta
from pathlib import Path

from flask import Flask, jsonify, request, render_template, send_file, session

from pinning_parser import parse_pinning_data
from template_layout import scan_template_layout
from worksheet_writer import write_master_workbook, load_circuit_color_config

BASE_DIR = Path(__file__).resolve().parent
DESIGN_PATH = BASE_DIR / 'design.xlsx'
DATA_DIR = BASE_DIR / 'data'
PREFS_FILE = DATA_DIR / 'prefs.json'
PROFILES_FILE = DATA_DIR / 'platform_profiles.json'
HANG_PROFILES_FILE = DATA_DIR / 'hang_profiles.json'
SHOWS_DIR = DATA_DIR / 'shows'
LEGACY_JOB_FILE = DATA_DIR / 'current_job.json'  # pre-shows/dates single-job file

ALLOWED_EXTENSIONS = {'.pdf', '.txt'}

# Lots of sim software names a symmetrical hang pair with a trailing
# "(Pair)" marker baked right into the hang's own title/header string --
# redundant once an SE already knows their rig is symmetric, so job.json's
# strip_pair_labels toggle (see build_job) can strip it back out wherever a
# hang's header is shown or exported. Only ever strips a trailing marker,
# not one that happens to appear mid-title, so a hang genuinely named
# something like "1. Pair of Subs" is left alone.
PAIR_SUFFIX_RE = re.compile(r'\s*\(\s*pair\s*\)\s*$', re.IGNORECASE)


def strip_pair_label(header):
    return PAIR_SUFFIX_RE.sub('', header or '')


# Data Bar (the Mode/Aim/Trim/Angle/etc. panel) placement -- null means "no
# override, use the automatic width-driven placement" (see the CSS "Data
# Bar mode" rules), same null-means-inherit convention as hidden_tags_overrides.
DATA_BAR_MODES = {None, 'side-left', 'side-right', 'bottom', 'hidden'}

# How Trim values display -- decimal feet or feet/inches (see
# api_set_show_trim_units below); inches precision only matters in the
# feet_inches format, but validated as its own set regardless of which
# format is active so a stray value can't sneak into storage either way.
TRIM_UNIT_FORMATS = {'decimal', 'feet_inches'}
TRIM_INCHES_PRECISIONS = {'whole', 'half', 'quarter'}

# One shared password for the whole tool -- no usernames/accounts, this is
# a small private crew tool, not a multi-tenant product. Set APP_PASSWORD
# in the environment for real use (Render/Fly's dashboard, not this file);
# the fallback here only exists so a fresh local checkout still runs
# without extra setup. SECRET_KEY signs the login session cookie -- set it
# too in production, otherwise every server restart invalidates everyone's
# session (falls back to a random one so it still works, just logs
# everyone out on redeploy).
APP_PASSWORD = os.environ.get('APP_PASSWORD', 'pinning')
# There's no separate sign-in page -- every page (Home/Show/Date) always
# renders; only the JSON APIs are actually gated, and the page's own lock
# icon (see static/auth.js) shows/hides content client-side based on
# whether those calls 401. api/login and api/auth/status must stay
# reachable while locked, or nothing could ever unlock.
API_PUBLIC_PATHS = {'/api/login', '/api/auth/status'}

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB is generous for a text/PDF pinning sheet
app.secret_key = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)


@app.before_request
def require_login():
    # The password gates EDITING, not viewing -- anyone can browse Home/
    # Show/Date pages and read their data (GET) without signing in; only
    # requests that actually change something (POST/PUT/DELETE -- create a
    # show/date, save state, upload, export) need a session. Every mutating
    # route in this file is POST, so this one method check covers all of
    # them without having to list routes out by hand.
    if not request.path.startswith('/api/') or request.path in API_PUBLIC_PATHS:
        return None
    if request.method == 'GET':
        return None
    if session.get('authed'):
        return None
    return jsonify({'error': 'Not signed in.'}), 401


@app.route('/api/auth/status')
def api_auth_status():
    return jsonify({'authed': bool(session.get('authed'))})


@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json(force=True, silent=True) or {}
    if hmac.compare_digest(data.get('password', ''), APP_PASSWORD):
        session.permanent = True
        session['authed'] = True
        return jsonify({'ok': True})
    return jsonify({'error': 'Incorrect password.'}), 401


@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'ok': True})


# One global lock for all show/date reads+writes -- reads and writes both
# go through this, so an upload landing mid-save (or two people saving
# within the same few milliseconds, even on different dates) can't
# interleave and corrupt a JSON file. A small private tool never has
# enough concurrent traffic for one shared lock to matter perf-wise.
STATE_LOCK = threading.Lock()


def slugify(text):
    text = re.sub(r'[^a-z0-9]+', '-', (text or '').strip().lower()).strip('-')
    return text or 'untitled'


def unique_slug(base, existing):
    if base not in existing:
        return base
    n = 2
    while f'{base}-{n}' in existing:
        n += 1
    return f'{base}-{n}'


def show_dir(show_slug):
    return SHOWS_DIR / show_slug


def show_meta_path(show_slug):
    return show_dir(show_slug) / 'show.json'


def dates_dir(show_slug):
    return show_dir(show_slug) / 'dates'


def date_dir(show_slug, date_slug):
    return dates_dir(show_slug) / date_slug


def job_path(show_slug, date_slug):
    return date_dir(show_slug, date_slug) / 'job.json'


def _read_json(path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def list_shows():
    if not SHOWS_DIR.exists():
        return []
    shows = []
    for d in sorted(SHOWS_DIR.iterdir()):
        meta = _read_json(d / 'show.json')
        if meta:
            shows.append(meta)
    return shows


def get_show(show_slug):
    return _read_json(show_meta_path(show_slug))


def list_dates(show_slug):
    root = dates_dir(show_slug)
    if not root.exists():
        return []
    out = []
    for d in sorted(root.iterdir()):
        job = _read_json(d / 'job.json')
        if job is None:
            continue
        ph = job.get('page_header') or {}
        out.append({'slug': d.name, 'date': ph.get('date') or d.name, 'venue': ph.get('venue', '')})
    return out


def load_job(show_slug, date_slug):
    return _read_json(job_path(show_slug, date_slug))


def load_prefs():
    return _read_json(PREFS_FILE) or {}


def load_profiles():
    return (_read_json(PROFILES_FILE) or {}).get('profiles', [])


def save_profiles(profiles):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROFILES_FILE.write_text(json.dumps({'profiles': profiles}, indent=2), encoding='utf-8')


def load_hang_profiles():
    return (_read_json(HANG_PROFILES_FILE) or {}).get('profiles', [])


def save_hang_profiles(profiles):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HANG_PROFILES_FILE.write_text(json.dumps({'profiles': profiles}, indent=2), encoding='utf-8')


def save_prefs(prefs):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PREFS_FILE.write_text(json.dumps(prefs, indent=2), encoding='utf-8')


def save_global_settings(job):
    """
    Persist the settings that should carry over into the NEXT date's job
    regardless of which show/date it's created under -- cards-per-row, the
    default view mode, and the (Pair)-label-stripping preference. Lives in
    data/prefs.json. Intentionally global rather than per-show -- an SE's
    card-layout/naming conventions don't usually change show to show.
    hidden_tags_overrides is NOT carried forward here -- unlike these, it's
    specific to one Date's own quirks, not a standing preference (the
    show-wide default for that lives on the Show itself, see
    api_set_show_hidden_tags), so a new Date should always start with none.
    Circuit/hang colors and breakout numbering used to be carried forward
    globally here too, but that's now a per-Show default (see
    api_set_show_circuit_color_config) -- writing every Date's own config
    back into one shared file meant editing colors on any Date, in any
    Show, silently changed the default for every other Show as well.
    """
    save_prefs({
        'cards_per_row': job.get('cards_per_row', 2) if job else 2,
        'view_mode': job.get('view_mode', 'tabs') if job else 'tabs',
        'strip_pair_labels': job.get('strip_pair_labels', False) if job else False,
    })


def save_job(show_slug, date_slug, job):
    d = date_dir(show_slug, date_slug)
    d.mkdir(parents=True, exist_ok=True)
    job_path(show_slug, date_slug).write_text(json.dumps(job, indent=2), encoding='utf-8')
    save_global_settings(job)


def _fields_and_metadata_from_design():
    fields_enabled = ['label', 'model', 'dispersion', 'angle', 'circuit', 'nfc']
    metadata_fields = []
    if DESIGN_PATH.exists():
        from openpyxl import load_workbook
        wb = load_workbook(DESIGN_PATH)
        layout = scan_template_layout(wb.active)
        if layout:
            fields_enabled = sorted(layout['col_offsets'].keys(), key=lambda k: layout['col_offsets'][k])
            metadata_fields = [{'label': label, 'key': key} for label, _off, key in layout['metadata_rows']]
    return fields_enabled, metadata_fields


def build_job(sections, source_name, page_header=None, show=None):
    """
    Fresh job -- for a brand new Date (sections=[], source_name=None,
    before any file's been uploaded yet) or for a freshly-parsed upload
    into an existing Date. cards-per-row/view_mode are carried forward from
    whatever was last saved (see save_global_settings above) rather than
    reset to defaults. Circuit/hang colors and breakout numbering seed from
    the owning Show's own standing default (show['circuit_color_config']),
    falling back to the legacy global design.colors.json sidecar for a Show
    that hasn't set its own yet -- so starting a new date or uploading a
    new file mid-session doesn't lose the crew's color setup either way.
    """
    prefs = load_prefs()
    fields_enabled, metadata_fields = _fields_and_metadata_from_design()
    show_cfg = show.get('circuit_color_config') if show else None
    return {
        'source_file': source_name,
        'sections': sections,
        'cards_per_row': prefs.get('cards_per_row', 2),
        'view_mode': prefs.get('view_mode', 'tabs'),
        'circuit_color_config': show_cfg if show_cfg else load_circuit_color_config(DESIGN_PATH if DESIGN_PATH.exists() else None),
        'fields_enabled': fields_enabled,
        'metadata_fields': metadata_fields,
        # Show title/venue/date: title+date are set once at creation time
        # (see api_create_date) from the Show name and the date the editor
        # typed in; venue stays editable from the sidebar. Viewers see all
        # three as plain text -- and they're the same fields design.xlsx's
        # PAGE_TITLE/PAGE_VENUE/PAGE_DATE placeholders expect (see
        # api_export below), so they also carry through to the exported
        # workbook.
        'page_header': page_header or {'title': '', 'venue': '', 'date': ''},
        # Data Tags overrides for THIS Date only (key -> hidden bool) --
        # takes precedence over the Show's own hidden_tags default, but is
        # itself overridable per-hang (see each section's own
        # hidden_tags_overrides, set client-side and passed through
        # verbatim by _apply_incoming below). Always starts empty; see
        # save_global_settings for why it isn't carried forward.
        'hidden_tags_overrides': {},
        # This Date's own Data Bar placement override, same null-means-
        # "fall back to the Show default, then automatic" convention as
        # data_bar_mode on the Show itself (see DATA_BAR_MODES) -- also a
        # Date-specific setting, not carried forward to a new Date.
        'data_bar_mode_override': None,
        # This Date's own tape-burn-footage override, same null-cascade
        # convention as data_bar_mode_override -- falls back to the Show's
        # tape_burn_default_ft when unset. An individual hang can further
        # override this via its own section['tape_burn_ft'] (set
        # client-side, passed through verbatim same as
        # hidden_tags_overrides on a section).
        'tape_burn_override_ft': None,
        # This Date's own Trim display-format override -- same null-cascade
        # convention as data_bar_mode_override, falling back to the Show's
        # trim_unit_format/trim_inches_precision when unset. No per-hang
        # level -- see api_set_show_trim_units.
        'trim_unit_format_override': None,
        'trim_inches_precision_override': None,
        # Whether hang headers/titles get their trailing "(Pair)" marker
        # stripped for display/export -- an SE-wide naming convention, so
        # (unlike hidden_tags_overrides) it IS carried forward, same as
        # cards_per_row.
        'strip_pair_labels': prefs.get('strip_pair_labels', False),
    }


def _apply_incoming(job, data):
    if 'sections' in data:
        job['sections'] = data['sections']
    if 'cards_per_row' in data:
        job['cards_per_row'] = data['cards_per_row']
    if 'view_mode' in data:
        job['view_mode'] = data['view_mode']
    if 'circuit_color_config' in data:
        job['circuit_color_config'] = data['circuit_color_config']
    if 'page_header' in data:
        job['page_header'] = data['page_header']
    if 'hidden_tags_overrides' in data:
        job['hidden_tags_overrides'] = data['hidden_tags_overrides']
    if 'data_bar_mode_override' in data and data['data_bar_mode_override'] in DATA_BAR_MODES:
        job['data_bar_mode_override'] = data['data_bar_mode_override']
    if 'tape_burn_override_ft' in data:
        val = data['tape_burn_override_ft']
        job['tape_burn_override_ft'] = float(val) if isinstance(val, (int, float)) else None
    if 'trim_unit_format_override' in data:
        val = data['trim_unit_format_override']
        job['trim_unit_format_override'] = val if val in TRIM_UNIT_FORMATS else None
    if 'trim_inches_precision_override' in data:
        val = data['trim_inches_precision_override']
        job['trim_inches_precision_override'] = val if val in TRIM_INCHES_PRECISIONS else None
    if 'strip_pair_labels' in data:
        job['strip_pair_labels'] = data['strip_pair_labels']


def migrate_legacy_job():
    """
    One-time upgrade from the old single-shared-job version of this app
    (one pinning sheet, no shows/dates) -- if that old data/current_job.json
    is still sitting there and no real shows/dates exist yet, turn it into
    the first Show/Date instead of silently losing it. Renamed afterward so
    this only ever runs once.
    """
    if not LEGACY_JOB_FILE.exists():
        return
    if SHOWS_DIR.exists() and any(SHOWS_DIR.iterdir()):
        return
    job = _read_json(LEGACY_JOB_FILE)
    if job is None:
        return
    ph = job.get('page_header') or {}
    show_name = ph.get('title') or 'Untitled show'
    date_str = ph.get('date') or date_cls.today().isoformat()
    show_slug = slugify(show_name)
    show_dir(show_slug).mkdir(parents=True, exist_ok=True)
    show_meta_path(show_slug).write_text(
        json.dumps({'name': show_name, 'slug': show_slug}, indent=2), encoding='utf-8'
    )
    date_slug = slugify(date_str)
    save_job(show_slug, date_slug, job)
    LEGACY_JOB_FILE.rename(LEGACY_JOB_FILE.with_suffix('.json.migrated'))


# --- Pages ------------------------------------------------------------------

@app.route('/')
def home():
    return render_template('home.html')


@app.route('/<show_slug>')
def show_page(show_slug):
    show = get_show(show_slug)
    if not show:
        return render_template('not_found.html', kind='show'), 404
    return render_template('show.html', show=show)


@app.route('/<show_slug>/<date_slug>')
def date_page(show_slug, date_slug):
    show = get_show(show_slug)
    if not show:
        return render_template('not_found.html', kind='show'), 404
    if load_job(show_slug, date_slug) is None:
        return render_template('not_found.html', kind='date'), 404
    return render_template('index.html', show=show, date_slug=date_slug)


# --- Shows/dates APIs ---------------------------------------------------

@app.route('/api/shows', methods=['GET'])
def api_list_shows():
    return jsonify(list_shows())


@app.route('/api/shows', methods=['POST'])
def api_create_show():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Show name is required.'}), 400
    with STATE_LOCK:
        SHOWS_DIR.mkdir(parents=True, exist_ok=True)
        existing = {d.name for d in SHOWS_DIR.iterdir() if d.is_dir()}
        slug = unique_slug(slugify(name), existing)
        show_dir(slug).mkdir(parents=True, exist_ok=True)
        # hidden_tags is the SE's show-wide Data Tags default (see
        # api_set_show_hidden_tags below) -- every Date under this show
        # inherits it unless that Date (or an individual hang on it)
        # overrides a given tag. Empty here just means "nothing hidden by
        # default", same as before this setting existed.
        # data_bar_mode is the SE's show-wide Data Bar placement default
        # (see api_set_show_data_bar_mode below) -- one of 'side-left',
        # 'side-right', 'bottom', 'hidden', or null. Null means "no
        # override" -- every Date under this show (unless it sets its own
        # override) falls back to the automatic, card-width-driven
        # placement that's always existed (side on a wide card, bottom on
        # a narrower one, hidden below that), not to some other default.
        # circuit_color_config is this Show's own standing default for
        # circuit/hang colors and Hi-D/breakout numbering -- null means "no
        # override yet, fall back to the legacy global design.colors.json
        # sidecar" (see build_job below), same null-cascade convention as
        # data_bar_mode. Set from the Show page's Configure Pinning Sheets
        # modal (see api_set_show_circuit_color_config).
        # tape_burn_default_ft: this Show's standing default for how many
        # feet a tape measure's "burnt" (missing) first foot(s) throw off a
        # raw reading -- a Date, then an individual hang, can each override
        # it (see tape_burn_override_ft on job.json / tape_burn_ft on a
        # section), falling back down to this when neither is set.
        # trim_unit_format/trim_inches_precision: how Trim values display --
        # 'decimal' (e.g. "56.89 ft", the default) or 'feet_inches' (e.g.
        # "56' 11\""), the latter rounded to whole/half/quarter inches per
        # trim_inches_precision. A Date can override both (see
        # trim_unit_format_override/trim_inches_precision_override on
        # job.json) -- no per-hang level, this is a standing SE preference,
        # not something that varies hang to hang.
        meta = {
            'name': name, 'slug': slug, 'hidden_tags': [], 'data_bar_mode': None,
            'circuit_color_config': None, 'tape_burn_default_ft': 0,
            'trim_unit_format': 'decimal', 'trim_inches_precision': 'whole',
        }
        show_meta_path(slug).write_text(json.dumps(meta, indent=2), encoding='utf-8')
    return jsonify(meta)


@app.route('/api/shows/<show_slug>', methods=['GET'])
def api_get_show(show_slug):
    show = get_show(show_slug)
    if not show:
        return jsonify({'error': 'Show not found.'}), 404
    return jsonify(show)


@app.route('/api/shows/<show_slug>/hidden-tags', methods=['POST'])
def api_set_show_hidden_tags(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    tags = data.get('hidden_tags')
    if not isinstance(tags, list):
        return jsonify({'error': 'hidden_tags must be a list.'}), 400
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        show['hidden_tags'] = [str(t) for t in tags]
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
    return jsonify(show)


@app.route('/api/shows/<show_slug>/data-bar-mode', methods=['POST'])
def api_set_show_data_bar_mode(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    mode = data.get('data_bar_mode')
    if mode not in DATA_BAR_MODES:
        return jsonify({'error': 'Invalid data_bar_mode.'}), 400
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        show['data_bar_mode'] = mode
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
    return jsonify(show)


@app.route('/api/shows/<show_slug>/tape-burn-default', methods=['POST'])
def api_set_show_tape_burn_default(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    try:
        ft = float(data.get('tape_burn_default_ft'))
    except (TypeError, ValueError):
        return jsonify({'error': 'tape_burn_default_ft must be a number.'}), 400
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        show['tape_burn_default_ft'] = ft
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
    return jsonify(show)


@app.route('/api/shows/<show_slug>/trim-units', methods=['POST'])
def api_set_show_trim_units(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    unit_format = data.get('trim_unit_format')
    inches_precision = data.get('trim_inches_precision')
    if unit_format not in TRIM_UNIT_FORMATS or inches_precision not in TRIM_INCHES_PRECISIONS:
        return jsonify({'error': 'Invalid trim_unit_format/trim_inches_precision.'}), 400
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        show['trim_unit_format'] = unit_format
        show['trim_inches_precision'] = inches_precision
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
    return jsonify(show)


@app.route('/api/shows/<show_slug>/circuit-color-config', methods=['POST'])
def api_set_show_circuit_color_config(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    cfg = data.get('circuit_color_config')
    if not isinstance(cfg, dict):
        return jsonify({'error': 'circuit_color_config must be an object.'}), 400
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        show['circuit_color_config'] = cfg
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
    return jsonify(show)


@app.route('/api/design-fields', methods=['GET'])
def api_design_fields():
    # Same field/metadata list every job's build_job() pulls from -- the
    # Show page needs it too (to list which Data Tags the SE can set a
    # show-wide default for) without needing any actual Date's job.json to
    # exist yet.
    fields_enabled, metadata_fields = _fields_and_metadata_from_design()
    return jsonify({'fields_enabled': fields_enabled, 'metadata_fields': metadata_fields})


@app.route('/api/circuit-color-config', methods=['GET'])
def api_get_circuit_color_config():
    # Circuit/hang colors and breakout numbering aren't per-show -- they're
    # the same global "next new date" carry-forward settings build_job()
    # seeds every fresh Date from (see save_global_settings) -- so the Show
    # page's Configure Pinning Sheets modal edits this directly, same
    # convention as api_design_fields above, rather than needing any
    # particular Date's job.json to exist first.
    return jsonify(load_circuit_color_config(DESIGN_PATH if DESIGN_PATH.exists() else None))


@app.route('/api/circuit-color-config', methods=['POST'])
def api_set_circuit_color_config():
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        colors_path = DESIGN_PATH.with_suffix('.colors.json')
        colors_path.write_text(json.dumps(data, indent=2), encoding='utf-8')
    return jsonify(data)


@app.route('/api/shows/<show_slug>/dates', methods=['GET'])
def api_list_dates(show_slug):
    show = get_show(show_slug)
    if not show:
        return jsonify({'error': 'Show not found.'}), 404
    return jsonify({'show': show, 'dates': list_dates(show_slug)})


@app.route('/api/shows/<show_slug>/dates', methods=['POST'])
def api_create_date(show_slug):
    show = get_show(show_slug)
    if not show:
        return jsonify({'error': 'Show not found.'}), 404
    data = request.get_json(force=True, silent=True) or {}
    date_str = (data.get('date') or '').strip()
    if not date_str:
        return jsonify({'error': 'Date is required.'}), 400
    with STATE_LOCK:
        root = dates_dir(show_slug)
        existing = {d.name for d in root.iterdir() if d.is_dir()} if root.exists() else set()
        slug = unique_slug(slugify(date_str), existing)
        job = build_job([], None, page_header={'title': show['name'], 'venue': '', 'date': date_str}, show=show)
        save_job(show_slug, slug, job)
    return jsonify({'slug': slug})


# --- Platform profile APIs -------------------------------------------------
# A PA Platform Profile (e.g. "Hi-D") is a named, global (not per-show)
# snapshot of the settings that are otherwise scattered across the Date
# page's Colors/Numbering panels plus a Show's own Data Tags/Data Bar
# defaults -- see CONFIG_GROUPS in show.js for where these get applied from.
# Applying a profile is a one-time copy, same convention as
# save_global_settings below: it overwrites the target show's own
# hidden_tags/data_bar_mode plus the *global* "next new date" carry-forward
# prefs/colors sidecar, but never touches any date's already-saved job.json.

@app.route('/api/platform-profiles', methods=['GET'])
def api_list_platform_profiles():
    return jsonify({'profiles': load_profiles()})


@app.route('/api/platform-profiles', methods=['POST'])
def api_create_platform_profile():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Profile name is required.'}), 400
    show_slug = data.get('show_slug') or ''
    show = get_show(show_slug)
    if not show:
        return jsonify({'error': 'Show not found.'}), 404
    with STATE_LOCK:
        profiles = load_profiles()
        existing = {p['id'] for p in profiles}
        profile_id = unique_slug(slugify(name), existing)
        prefs = load_prefs()
        profile = {
            'id': profile_id,
            'name': name,
            'settings': {
                'circuit_color_config': show.get('circuit_color_config') or load_circuit_color_config(DESIGN_PATH if DESIGN_PATH.exists() else None),
                'hidden_tags': show.get('hidden_tags', []),
                'data_bar_mode': show.get('data_bar_mode'),
                'strip_pair_labels': prefs.get('strip_pair_labels', False),
                'view_mode': prefs.get('view_mode', 'tabs'),
                'cards_per_row': prefs.get('cards_per_row', 2),
            },
        }
        profiles.append(profile)
        save_profiles(profiles)
    return jsonify(profile)


@app.route('/api/platform-profiles/<profile_id>', methods=['DELETE'])
def api_delete_platform_profile(profile_id):
    with STATE_LOCK:
        profiles = load_profiles()
        remaining = [p for p in profiles if p['id'] != profile_id]
        if len(remaining) == len(profiles):
            return jsonify({'error': 'Profile not found.'}), 404
        save_profiles(remaining)
    return jsonify({'ok': True})


@app.route('/api/shows/<show_slug>/apply-platform-profile', methods=['POST'])
def api_apply_platform_profile(show_slug):
    data = request.get_json(force=True, silent=True) or {}
    profile_id = data.get('profile_id') or ''
    with STATE_LOCK:
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        profile = next((p for p in load_profiles() if p['id'] == profile_id), None)
        if not profile:
            return jsonify({'error': 'Profile not found.'}), 404
        settings = profile['settings']
        show['hidden_tags'] = settings.get('hidden_tags', [])
        show['data_bar_mode'] = settings.get('data_bar_mode')
        show['circuit_color_config'] = settings.get('circuit_color_config') or None
        show_meta_path(show_slug).write_text(json.dumps(show, indent=2), encoding='utf-8')
        save_prefs({
            'cards_per_row': settings.get('cards_per_row', 2),
            'view_mode': settings.get('view_mode', 'tabs'),
            'strip_pair_labels': settings.get('strip_pair_labels', False),
        })
    return jsonify(show)


# --- Hang Profile APIs ------------------------------------------------
# A Hang Profile (e.g. "16 Sub - Start Brown") is a named, global (not
# per-show) snapshot of everything that varies hang-to-hang on tour --
# which Hi-D cable it starts on, tape-burn footage, an optional manual
# circuit-numbering pattern (e.g. cardioid subs wired 1,2,1), a direct
# stripe color, a rename, and its Data Tags. Unlike Platform Profiles
# (applied once, immediately, to a Show's own defaults), a Hang Profile is
# *linked* to a specific hang (see hang_profile_id/hang_profile_version on
# a section, set client-side) -- editing a linked profile here bumps
# `version`, and it's up to the client (see the Date page's load-time
# version check) to notice the mismatch and ask the SE whether to update
# that hang or detach it, rather than silently rewriting every hang that
# ever used it.

HANG_PROFILE_FIELDS = (
    'start_breakout', 'hid_reverse_order', 'tape_burn_ft',
    'apply_manual_circuiting', 'manual_circuit_pattern', 'hang_color',
    'rename_to', 'hidden_tags',
)
HANG_PROFILE_DEFAULTS = {
    'start_breakout': 1, 'hid_reverse_order': True, 'tape_burn_ft': 0,
    'apply_manual_circuiting': False, 'manual_circuit_pattern': [], 'hang_color': None,
    'rename_to': None, 'hidden_tags': [],
}


@app.route('/api/hang-profiles', methods=['GET'])
def api_list_hang_profiles():
    return jsonify({'profiles': load_hang_profiles()})


@app.route('/api/hang-profiles', methods=['POST'])
def api_create_hang_profile():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Profile name is required.'}), 400
    with STATE_LOCK:
        profiles = load_hang_profiles()
        existing = {p['id'] for p in profiles}
        profile = {'id': unique_slug(slugify(name), existing), 'name': name, 'version': 1}
        for field in HANG_PROFILE_FIELDS:
            profile[field] = data.get(field, HANG_PROFILE_DEFAULTS[field])
        profiles.append(profile)
        save_hang_profiles(profiles)
    return jsonify(profile)


@app.route('/api/hang-profiles/<profile_id>', methods=['PATCH'])
def api_update_hang_profile(profile_id):
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        profiles = load_hang_profiles()
        profile = next((p for p in profiles if p['id'] == profile_id), None)
        if not profile:
            return jsonify({'error': 'Profile not found.'}), 404
        if 'name' in data and (data.get('name') or '').strip():
            profile['name'] = data['name'].strip()
        for field in HANG_PROFILE_FIELDS:
            if field in data:
                profile[field] = data[field]
        profile['version'] = profile.get('version', 1) + 1
        save_hang_profiles(profiles)
    return jsonify(profile)


@app.route('/api/hang-profiles/<profile_id>', methods=['DELETE'])
def api_delete_hang_profile(profile_id):
    with STATE_LOCK:
        profiles = load_hang_profiles()
        remaining = [p for p in profiles if p['id'] != profile_id]
        if len(remaining) == len(profiles):
            return jsonify({'error': 'Profile not found.'}), 404
        save_hang_profiles(remaining)
    return jsonify({'ok': True})


# --- Per-date job APIs ----------------------------------------------------

@app.route('/api/shows/<show_slug>/dates/<date_slug>/state', methods=['GET'])
def api_get_state(show_slug, date_slug):
    with STATE_LOCK:
        job = load_job(show_slug, date_slug)
    if job is None:
        return jsonify({'error': 'Not found.'}), 404
    return jsonify(job)


@app.route('/api/shows/<show_slug>/dates/<date_slug>/state', methods=['POST'])
def api_post_state(show_slug, date_slug):
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        job = load_job(show_slug, date_slug)
        if job is None:
            return jsonify({'error': 'Not found.'}), 404
        _apply_incoming(job, data)
        save_job(show_slug, date_slug, job)
    return jsonify({'ok': True})


@app.route('/api/shows/<show_slug>/dates/<date_slug>/upload', methods=['POST'])
def api_upload(show_slug, date_slug):
    file = request.files.get('file')
    if not file or not file.filename:
        return jsonify({'error': 'No file provided.'}), 400
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({'error': f'Unsupported file type "{ext}" -- upload a .pdf or .txt pinning sheet.'}), 400

    try:
        if ext == '.pdf':
            from pdf_parser import extract_sections_from_pdf
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                file.save(tmp.name)
                tmp_path = tmp.name
            try:
                sections = extract_sections_from_pdf(tmp_path)
            finally:
                os.unlink(tmp_path)
        else:
            text = file.read().decode('utf-8', errors='replace')
            sections = parse_pinning_data(text)
    except Exception as exc:
        return jsonify({'error': f'Could not parse "{file.filename}": {exc}'}), 400

    with STATE_LOCK:
        existing = load_job(show_slug, date_slug)
        if existing is None:
            return jsonify({'error': 'Not found.'}), 404
        show = get_show(show_slug)
        if not show:
            return jsonify({'error': 'Show not found.'}), 404
        # Title/venue/date belong to this Date (set at creation, editable
        # from the sidebar) -- an uploaded file replaces the parsed
        # cabinet data, not the show info already attached to this URL.
        job = build_job(sections, file.filename, page_header=existing.get('page_header'), show=show)
        # Data Tags/Data Bar overrides are Date-level preferences, not
        # something tied to the specific cabinets just replaced -- carry
        # them forward explicitly, same as page_header above, since
        # build_job otherwise always starts a fresh job with none set.
        job['hidden_tags_overrides'] = existing.get('hidden_tags_overrides', {})
        job['data_bar_mode_override'] = existing.get('data_bar_mode_override')
        save_job(show_slug, date_slug, job)
    return jsonify(job)


@app.route('/api/shows/<show_slug>/dates/<date_slug>/export', methods=['POST'])
def api_export(show_slug, date_slug):
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        job = load_job(show_slug, date_slug)
        if job is None:
            return jsonify({'error': 'Not found.'}), 404
        _apply_incoming(job, data)
        save_job(show_slug, date_slug, job)

        stem = Path(job['source_file']).stem if job.get('source_file') else 'pinning_sheet'
        design_path = DESIGN_PATH if DESIGN_PATH.exists() else None
        with tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False) as tmp:
            tmp_path = tmp.name
        page_header = job.get('page_header') or {}
        page_header_values = {
            'title': page_header.get('title', ''),
            'venue': page_header.get('venue', ''),
            'date': page_header.get('date', ''),
        }
        sections_for_export = job['sections']
        if job.get('strip_pair_labels'):
            # Shallow per-section copies -- job['sections'] was already
            # written to disk by save_job above, so mutating a section dict
            # in place here would be harmless anyway, but copying keeps
            # this export-only transform from ever being able to touch the
            # saved job even if that ordering changes later.
            sections_for_export = [
                {**s, 'header': strip_pair_label(s.get('header', ''))} for s in job['sections']
            ]
        try:
            warnings = write_master_workbook(
                sections_for_export, design_path, tmp_path, job.get('cards_per_row', 2),
                page_header_values=page_header_values,
            )
            with open(tmp_path, 'rb') as f:
                xlsx_bytes = f.read()
        except Exception as exc:
            return jsonify({'error': f'Export failed: {exc}'}), 500
        finally:
            os.unlink(tmp_path)

    from io import BytesIO
    response = send_file(
        BytesIO(xlsx_bytes),
        as_attachment=True,
        download_name=f"{stem}_worksheet.xlsx",
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    response.headers['X-Export-Warnings'] = json.dumps(warnings)
    return response


@app.route('/healthz')
def healthz():
    return jsonify({'ok': True})


migrate_legacy_job()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug)
