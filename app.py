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
SHOWS_DIR = DATA_DIR / 'shows'
LEGACY_JOB_FILE = DATA_DIR / 'current_job.json'  # pre-shows/dates single-job file

ALLOWED_EXTENSIONS = {'.pdf', '.txt'}

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
    if not request.path.startswith('/api/') or request.path in API_PUBLIC_PATHS:
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


def save_prefs(prefs):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PREFS_FILE.write_text(json.dumps(prefs, indent=2), encoding='utf-8')


def save_global_settings(job):
    """
    Persist the settings that should carry over into the NEXT date's job
    regardless of which show/date it's created under -- circuit/hang
    colors, the breakout-cable numbering setup, and cards-per-row. Circuit
    colors live in design.xlsx's own .colors.json sidecar (same convention
    worksheet_writer.load_circuit_color_config() reads from); cards_per_row
    lives in data/prefs.json. Intentionally global rather than per-show --
    a crew's color/numbering conventions don't usually change show to show.
    """
    cfg = job.get('circuit_color_config') if job else None
    if cfg is not None:
        colors_path = DESIGN_PATH.with_suffix('.colors.json')
        colors_path.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    save_prefs({'cards_per_row': job.get('cards_per_row', 2) if job else 2})


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


def build_job(sections, source_name, page_header=None):
    """
    Fresh job -- for a brand new Date (sections=[], source_name=None,
    before any file's been uploaded yet) or for a freshly-parsed upload
    into an existing Date. Circuit/hang colors and cards-per-row are
    carried forward from whatever was last saved (see save_global_settings
    above) rather than reset to defaults, so starting a new date or
    uploading a new file mid-session doesn't lose the crew's color setup.
    """
    prefs = load_prefs()
    fields_enabled, metadata_fields = _fields_and_metadata_from_design()
    return {
        'source_file': source_name,
        'sections': sections,
        'cards_per_row': prefs.get('cards_per_row', 2),
        'circuit_color_config': load_circuit_color_config(DESIGN_PATH if DESIGN_PATH.exists() else None),
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
    }


def _apply_incoming(job, data):
    if 'sections' in data:
        job['sections'] = data['sections']
    if 'cards_per_row' in data:
        job['cards_per_row'] = data['cards_per_row']
    if 'circuit_color_config' in data:
        job['circuit_color_config'] = data['circuit_color_config']
    if 'page_header' in data:
        job['page_header'] = data['page_header']


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
        meta = {'name': name, 'slug': slug}
        show_meta_path(slug).write_text(json.dumps(meta, indent=2), encoding='utf-8')
    return jsonify(meta)


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
        job = build_job([], None, page_header={'title': show['name'], 'venue': '', 'date': date_str})
        save_job(show_slug, slug, job)
    return jsonify({'slug': slug})


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
        # Title/venue/date belong to this Date (set at creation, editable
        # from the sidebar) -- an uploaded file replaces the parsed
        # cabinet data, not the show info already attached to this URL.
        job = build_job(sections, file.filename, page_header=existing.get('page_header'))
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
        try:
            warnings = write_master_workbook(
                job['sections'], design_path, tmp_path, job.get('cards_per_row', 2),
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
