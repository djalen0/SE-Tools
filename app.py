"""
Pinning Sheet Editor -- webapp version.

Single shared job model: there is one editing session at a time (STATE['job']),
matching how this tool is actually used on a show -- one person builds/edits
the pinning sheet while everyone else either waits their turn or opens the
same page with ?view=1 for a read-only copy. There's no per-user login and no
concurrent-edit merging, by design (see DEPLOY.md) -- if two people save at
the same time, the second save simply wins, same as it would editing a single
shared Google Sheet tab with no one watching for conflicts.

All the actual pinning-sheet logic (parsing, layout scanning, coloring,
Hi-D/breakout numbering, Excel writing) is untouched from the desktop tool --
this file is just the HTTP surface around it: upload a file in, edit state,
export a file out.
"""
import json
import os
import tempfile
import threading
from pathlib import Path

from flask import Flask, jsonify, request, render_template, send_file

from pinning_parser import parse_pinning_data
from template_layout import scan_template_layout
from worksheet_writer import write_master_workbook, load_circuit_color_config

BASE_DIR = Path(__file__).resolve().parent
DESIGN_PATH = BASE_DIR / 'design.xlsx'
DATA_DIR = BASE_DIR / 'data'
PREFS_FILE = DATA_DIR / 'prefs.json'
JOB_STATE_FILE = DATA_DIR / 'current_job.json'

ALLOWED_EXTENSIONS = {'.pdf', '.txt'}

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB is generous for a text/PDF pinning sheet

# One shared job for the whole app, guarded by a lock -- reads and writes
# both go through this, so an upload landing mid-save (or two people saving
# within the same few milliseconds) can't interleave and corrupt the JSON.
STATE = {'job': None}
STATE_LOCK = threading.Lock()


def load_prefs():
    if not PREFS_FILE.exists():
        return {}
    try:
        return json.loads(PREFS_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_prefs(prefs):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PREFS_FILE.write_text(json.dumps(prefs, indent=2), encoding='utf-8')


def save_global_settings(job):
    """
    Persist the settings that should carry over into the NEXT job regardless
    of which file gets uploaded next -- circuit/hang colors, the
    breakout-cable numbering setup, and cards-per-row. Mirrors the desktop
    editor's _save_global_settings(): runs on every save (not just export),
    so a session that's never exported still keeps its settings for next
    time. Circuit colors live in design.xlsx's own .colors.json sidecar
    (same convention worksheet_writer.load_circuit_color_config() reads
    from); cards_per_row lives in data/prefs.json.
    """
    cfg = job.get('circuit_color_config') if job else None
    if cfg is not None:
        colors_path = DESIGN_PATH.with_suffix('.colors.json')
        colors_path.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    save_prefs({'cards_per_row': job.get('cards_per_row', 2) if job else 2})


def save_job_state():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if STATE['job'] is None:
        if JOB_STATE_FILE.exists():
            JOB_STATE_FILE.unlink()
        return
    JOB_STATE_FILE.write_text(json.dumps(STATE['job'], indent=2), encoding='utf-8')
    save_global_settings(STATE['job'])


def load_persisted_job():
    """
    Resume whatever job was in progress if the server process restarts
    (e.g. a host redeploy) -- the shared job lives only in memory otherwise,
    so without this a restart mid-show would silently drop the current
    sheet.
    """
    if not JOB_STATE_FILE.exists():
        return None
    try:
        return json.loads(JOB_STATE_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


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


def build_job(sections, source_name):
    """
    Fresh job from newly-parsed sections. Circuit/hang colors and
    cards-per-row are carried forward from whatever was last saved (see
    save_global_settings above) rather than reset to defaults, so uploading
    a new (differently-named) file mid-session doesn't lose the crew's color
    setup -- same behavior the desktop editor already had.
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
        # Show title/venue/date: the editor types these in once, viewers see
        # them as plain text (see the sidebar's show-info fields) -- and
        # they're the same fields design.xlsx's PAGE_TITLE/PAGE_VENUE/
        # PAGE_DATE placeholders expect (see export() below), so filling
        # them in here also carries them through to the exported workbook.
        'page_header': {'title': '', 'venue': '', 'date': ''},
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


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/state', methods=['GET'])
def get_state():
    with STATE_LOCK:
        return jsonify(STATE['job'])


@app.route('/api/state', methods=['POST'])
def post_state():
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        if STATE['job'] is None:
            return jsonify({'error': 'No job loaded yet -- upload a pinning sheet first.'}), 400
        _apply_incoming(STATE['job'], data)
        save_job_state()
        return jsonify({'ok': True})


@app.route('/api/upload', methods=['POST'])
def upload():
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
        STATE['job'] = build_job(sections, file.filename)
        save_job_state()
        return jsonify(STATE['job'])


@app.route('/api/export', methods=['POST'])
def export():
    data = request.get_json(force=True, silent=True) or {}
    with STATE_LOCK:
        if STATE['job'] is None:
            return jsonify({'error': 'No job loaded yet -- upload a pinning sheet first.'}), 400
        _apply_incoming(STATE['job'], data)
        save_job_state()
        job = STATE['job']

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


# Restore whatever job was mid-edit if the process restarts (host redeploy,
# crash recovery, etc.) -- see load_persisted_job() docstring.
STATE['job'] = load_persisted_job()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug)
