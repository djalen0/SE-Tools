import re
import sys
from pathlib import Path


def win_long_path(path):
    """
    Windows normally caps file paths at 260 characters (MAX_PATH). Prefixing
    an absolute path with \\\\?\\ tells Windows to skip that limit entirely.
    No-op on non-Windows platforms.
    """
    if sys.platform != 'win32':
        return str(path)
    resolved = str(Path(path).resolve())
    if resolved.startswith('\\\\?\\'):
        return resolved
    return '\\\\?\\' + resolved


def show_diagnostics_dialog(title, message, is_error=False):
    """
    Show a window that stays open until the user closes it, with the full
    run diagnostics (or a full error trace) inside a scrollable text box.

    This replaces console print()/input() entirely. Console output is
    unreliable here because double-clicking a .py file on Windows can run it
    under pythonw.exe (no console at all) or spawn a console that closes the
    instant the script exits/crashes — so a crash before reaching an
    input() prompt just looks like "a window opens and closes." A Tk window
    doesn't depend on a console being attached, and mainloop() blocks until
    the user actually closes it, so there's always something to read.
    """
    try:
        import tkinter as tk
        from tkinter import scrolledtext
    except ImportError:
        # No Tk available at all (rare, minimal Python install). Fall back
        # to console output plus a pause, better than nothing.
        print(message)
        try:
            input("\nPress Enter to close...")
        except EOFError:
            pass
        return

    root = tk.Tk()
    root.title(title)
    root.geometry("900x650")

    header_color = '#B00020' if is_error else '#1A1A1A'
    header = tk.Label(root, text=title, font=('Segoe UI', 13, 'bold'), fg=header_color, anchor='w')
    header.pack(fill='x', padx=12, pady=(12, 4))

    text_area = scrolledtext.ScrolledText(root, wrap=tk.WORD, font=('Consolas', 10))
    text_area.insert(tk.END, message)
    text_area.configure(state='disabled')
    text_area.pack(fill='both', expand=True, padx=12, pady=(0, 8))

    button_row = tk.Frame(root)
    button_row.pack(pady=(0, 12))
    tk.Button(button_row, text="Close", width=16, command=root.destroy).pack()

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(lambda: root.attributes('-topmost', False))
    root.mainloop()


def prompt_cards_per_row(section_count, default=2):
    """
    "Layout designer" prompt: design.xlsx defines a single section card, and
    this asks the user how many of those cards to place side by side in
    each row before the sections get tiled into the master spreadsheet.
    Blocks (via mainloop) until the user picks a number or closes the
    window, in which case `default` is used. Falls back to `default`
    silently if Tk isn't available at all.
    """
    try:
        import tkinter as tk
    except ImportError:
        return default

    result = {'value': default}

    root = tk.Tk()
    root.title("Pinning Sheet Parser - Layout")
    root.geometry("440x260")

    tk.Label(root, text="Layout Designer", font=('Segoe UI', 13, 'bold')).pack(pady=(16, 4))
    tk.Label(
        root,
        text=f"Found {section_count} section(s) in this file.\n"
             "How many cards should sit side by side in each row?",
        font=('Segoe UI', 10),
        justify='center',
    ).pack(pady=(0, 12))

    entry_var = tk.StringVar(value=str(default))

    def submit():
        try:
            n = int(entry_var.get())
            if n < 1:
                raise ValueError
            result['value'] = n
        except ValueError:
            result['value'] = default
        root.destroy()

    def choose(n):
        entry_var.set(str(n))
        submit()

    button_row = tk.Frame(root)
    button_row.pack(pady=(0, 12))
    for n in (1, 2, 3, 4):
        tk.Button(button_row, text=f"{n} per row", width=10, command=lambda n=n: choose(n)).pack(side='left', padx=4)

    custom_row = tk.Frame(root)
    custom_row.pack(pady=(0, 12))
    tk.Label(custom_row, text="Custom:").pack(side='left', padx=(0, 6))
    tk.Entry(custom_row, textvariable=entry_var, width=6, justify='center').pack(side='left')

    tk.Button(root, text="OK", width=14, command=submit).pack(pady=(0, 16))

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(lambda: root.attributes('-topmost', False))
    root.mainloop()

    return result['value']


def prompt_design_preset(options, default_index=0):
    """
    Let the user pick which design preset (a design.xlsx-shaped template) to
    plot this run's data into, when more than one is available. `options` is
    a list of (label, path) tuples; `default_index` is pre-selected (e.g.
    whichever preset was used last time). Returns the chosen path, or
    `options[default_index][1]` if the window is closed without picking, or
    if Tk isn't available at all.
    """
    try:
        import tkinter as tk
    except ImportError:
        return options[default_index][1]

    result = {'value': options[default_index][1]}

    root = tk.Tk()
    root.title("Pinning Sheet Parser - Design Preset")
    root.geometry("460x380")

    tk.Label(root, text="Choose a design preset", font=('Segoe UI', 13, 'bold')).pack(pady=(16, 4))
    tk.Label(
        root,
        text="Which layout template should this run's data be plotted into?",
        font=('Segoe UI', 10),
        justify='center',
    ).pack(pady=(0, 12))

    list_frame = tk.Frame(root)
    list_frame.pack(fill='both', expand=True, padx=16)
    scrollbar = tk.Scrollbar(list_frame)
    scrollbar.pack(side='right', fill='y')
    listbox = tk.Listbox(
        list_frame, yscrollcommand=scrollbar.set, font=('Segoe UI', 10),
        selectmode='browse', exportselection=False,
    )
    for label, _ in options:
        listbox.insert(tk.END, label)
    listbox.selection_set(default_index)
    listbox.see(default_index)
    listbox.pack(side='left', fill='both', expand=True)
    scrollbar.config(command=listbox.yview)

    def submit():
        sel = listbox.curselection()
        if sel:
            result['value'] = options[sel[0]][1]
        root.destroy()

    listbox.bind('<Double-Button-1>', lambda e: submit())
    tk.Button(root, text="Use this preset", width=20, command=submit).pack(pady=16)

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(lambda: root.attributes('-topmost', False))
    root.mainloop()

    return result['value']


def _page_header_memory_path():
    return Path(__file__).resolve().parent / 'page_header_memory.json'


def load_page_header_memory():
    """
    Previously-typed title/Venue/Date/etc. values, remembered between runs
    so a repeat run only needs whatever actually changed touched, not
    everything retyped -- including the title itself, which now persists as
    "whatever it was last set to" rather than resetting to the current input
    file's name every run.
    """
    path = _page_header_memory_path()
    if not path.exists():
        return {}
    try:
        import json
        with open(win_long_path(path), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_page_header_memory(memory):
    import json
    try:
        with open(win_long_path(_page_header_memory_path()), 'w', encoding='utf-8') as f:
            json.dump(memory, f, indent=2)
    except OSError:
        pass  # Not being able to remember values isn't worth failing the run over.


def _color_palettes_path():
    return Path(__file__).resolve().parent / 'color_palettes.json'


def load_color_palettes():
    """
    Named 8-color palettes the user has explicitly saved for reuse (from
    either the Circuit # cycle or the Circuit SET cycle -- both are just an
    8-entry list of ARGB hex strings, so one palette library serves both),
    keyed by name. Returns {} if nothing's been saved yet.
    """
    path = _color_palettes_path()
    if not path.exists():
        return {}
    try:
        import json
        with open(win_long_path(path), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_color_palettes(palettes):
    import json
    try:
        with open(win_long_path(_color_palettes_path()), 'w', encoding='utf-8') as f:
            json.dump(palettes, f, indent=2)
    except OSError:
        pass  # Not being able to save a palette isn't worth failing the run over.


def prompt_page_header_dialog(fields, filename_default, remembered):
    """
    Ask for this run's page title (defaulting to whatever title was typed in
    last time, or the input file's name on the very first run) plus whatever
    Venue/Date/custom fields the chosen preset defines. `fields` is a list of
    {'key', 'label'} dicts in the order they appear on the sheet;
    `remembered` is {key: last_typed_value} (now including 'title'), used to
    prefill every field. Returns {'title': ..., <key>: ..., ...}, or None if
    the window is closed without submitting (Cancel or the X button) --
    distinct from an empty title, which just falls back to the filename.

    Falls back to the remembered/filename values with no prompt at all if Tk
    isn't available.
    """
    try:
        import tkinter as tk
    except ImportError:
        values = {'title': remembered.get('title') or filename_default}
        for f in fields:
            values[f['key']] = remembered.get(f['key'], '')
        return values

    result = {'value': None}

    root = tk.Tk()
    root.title("Pinning Sheet Parser - Page Title")
    root.geometry(f"480x{220 + 34 * len(fields)}")

    tk.Label(root, text="Page Title", font=('Segoe UI', 13, 'bold')).pack(pady=(16, 4))
    tk.Label(
        root, text="Shown once, big and centered, at the top of the sheet.",
        font=('Segoe UI', 10), justify='center',
    ).pack(pady=(0, 12))

    form = tk.Frame(root)
    form.pack(padx=20, fill='x')

    title_row = tk.Frame(form)
    title_row.pack(fill='x', pady=4)
    tk.Label(title_row, text="Title", width=14, anchor='w').pack(side='left')
    title_var = tk.StringVar(value=remembered.get('title') or filename_default)
    tk.Entry(title_row, textvariable=title_var).pack(side='left', fill='x', expand=True)

    field_vars = {}
    for f in fields:
        row = tk.Frame(form)
        row.pack(fill='x', pady=4)
        tk.Label(row, text=f['label'], width=14, anchor='w').pack(side='left')
        var = tk.StringVar(value=remembered.get(f['key'], ''))
        field_vars[f['key']] = var
        tk.Entry(row, textvariable=var).pack(side='left', fill='x', expand=True)

    def submit():
        values = {'title': title_var.get().strip() or filename_default}
        for key, var in field_vars.items():
            values[key] = var.get().strip()
        result['value'] = values
        root.destroy()

    def on_cancel():
        result['value'] = None
        root.destroy()

    button_row = tk.Frame(root)
    button_row.pack(pady=16)
    tk.Button(button_row, text="Cancel", width=14, command=on_cancel).pack(side='left', padx=6)
    tk.Button(button_row, text="OK", width=14, command=submit).pack(side='left', padx=6)

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(lambda: root.attributes('-topmost', False))
    root.mainloop()

    return result['value']


# Column-width fields exposed in the Layout tab: (spec key, display label).
# Fixed list regardless of which box fields are actually selected -- an
# unused width just goes unused, which is simpler than growing/shrinking the
# form as checkboxes change.
LAYOUT_WIDTH_FIELDS = [
    ('label', 'Cab label column'),
    ('model', 'Model column'),
    ('dispersion', 'Dispersion column'),
    ('angle', 'Angle column'),
    ('circuit', 'Circuit column'),
    ('nfc', 'NFC column'),
    ('gap', 'Gap column'),
    ('metadata', 'Metadata column'),
]

# Fill-color fields exposed in the Colors tab: (spec key, display label).
COLOR_FIELDS = [
    ('title_fill_color', 'Title fill'),
    ('header_fill_color', 'Header row fill'),
    ('metadata_fill_color', 'Metadata label fill'),
]

# Horizontal-alignment fields exposed in the Alignment tab: (spec key,
# display label). Vertical alignment is always centered and isn't offered as
# a choice here.
ALIGN_FIELDS = [
    ('title_align', 'Title'),
    ('header_align', 'Header row'),
    ('box_align', 'Box data'),
    ('metadata_label_align', 'Metadata label'),
    ('metadata_value_align', 'Metadata value'),
]
ALIGN_OPTIONS = ['left', 'center', 'right']

# Fallback palette used only if a spec is somehow missing circuit_colors
# entirely (shouldn't normally happen -- design_generator.py's
# _merge_onto_defaults always fills this in). Kept here too since gui_utils
# can't import design_generator's DEFAULT_SPEC without a circular import.
_DEFAULT_CIRCUIT_COLORS = [
    'FF8B4513', 'FFFF0000', 'FFFFA500', 'FFFFFF00',
    'FF008000', 'FF0000FF', 'FF800080', 'FF808080',
]

# Fallback palette for the circuit-SET stripe, same reasoning as above.
_DEFAULT_CIRCUIT_SET_COLORS = [
    'FF5C2E0A', 'FFB22222', 'FFCC5500', 'FFCCAA00',
    'FF2E5C1E', 'FF1E3C6E', 'FF5C1E5C', 'FF4A4A4A',
]


def prompt_spec_dialog(profiles, active_profile, default_box_fields, default_metadata_fields):
    """
    Interactive input for the design generator: a profile bar (switch
    between saved named templates, save the current form as a new one, or
    delete one) above three tabs -- Fields (which columns to include and
    their labels), Layout (column widths, metadata row spacing), and Colors
    (fill colors for the title/header/metadata cells).

    `profiles` is a dict of {name: spec}; `active_profile` is which one to
    show initially. `default_box_fields` / `default_metadata_fields` are the
    canonical (key, label) lists -- the full menu of fields on offer.

    Falls back to `(profiles, active_profile)` unchanged if Tk isn't
    available at all; returns None specifically if the user hits Cancel (so
    the caller can tell "use what's there" apart from "the user backed
    out"). On success, returns (profiles, active_profile) where `profiles`
    reflects any saves/renames/deletes made during the session and
    `active_profile` is the one to actually generate from.
    """
    try:
        import tkinter as tk
        from tkinter import ttk, colorchooser, simpledialog, messagebox
    except ImportError:
        return (profiles, active_profile)

    # Work on a local copy so hitting Cancel never mutates the caller's data.
    profiles = {name: dict(spec) for name, spec in profiles.items()}
    state = {'current': active_profile}
    result = {'outcome': None}
    widgets = {}

    root = tk.Tk()
    root.title("Design Template Generator")
    root.geometry("880x700")

    profile_bar = tk.Frame(root)
    profile_bar.pack(fill='x', padx=16, pady=(14, 4))
    tk.Label(profile_bar, text="Profile:", font=('Segoe UI', 10, 'bold')).pack(side='left')
    profile_var = tk.StringVar(value=state['current'])
    profile_combo = ttk.Combobox(
        profile_bar, textvariable=profile_var, values=list(profiles.keys()),
        state='readonly', width=24,
    )
    profile_combo.pack(side='left', padx=(6, 12))

    status_var = tk.StringVar(value="")

    notebook = ttk.Notebook(root)
    notebook.pack(fill='both', expand=True, padx=16, pady=(4, 4))
    fields_tab = tk.Frame(notebook)
    layout_tab = tk.Frame(notebook)
    colors_tab = tk.Frame(notebook)
    align_tab = tk.Frame(notebook)
    circuit_tab = tk.Frame(notebook)
    page_header_tab = tk.Frame(notebook)
    notebook.add(fields_tab, text="Fields")
    notebook.add(layout_tab, text="Layout")
    notebook.add(colors_tab, text="Colors")
    notebook.add(align_tab, text="Alignment")
    notebook.add(circuit_tab, text="Circuits")
    notebook.add(page_header_tab, text="Page Header")

    def _clear_and_scroll(tab):
        """
        Wipe `tab`'s previous contents and return a fresh inner Frame to
        build widgets into. The inner frame sits inside a Canvas + Scrollbar,
        so a tab whose content grows taller than the window (Circuits, with
        two 8-color palettes plus a variable-length hang-override list, is
        the one that actually hit this) scrolls internally instead of
        pushing the window's Save/Cancel buttons off-screen.
        """
        for child in tab.winfo_children():
            child.destroy()

        canvas = tk.Canvas(tab, borderwidth=0, highlightthickness=0)
        vscroll = tk.Scrollbar(tab, orient='vertical', command=canvas.yview)
        inner = tk.Frame(canvas)
        inner_id = canvas.create_window((0, 0), window=inner, anchor='nw')

        def _sync_scrollregion(event=None):
            canvas.configure(scrollregion=canvas.bbox('all'))

        def _sync_inner_width(event):
            # Keep the inner frame exactly as wide as the visible canvas, so
            # fill='x' widgets inside it (LabelFrames, entry rows, ...) still
            # stretch to the tab's full width instead of the frame's own
            # requested (shrink-to-fit) width.
            canvas.itemconfig(inner_id, width=event.width)

        inner.bind('<Configure>', _sync_scrollregion)
        canvas.bind('<Configure>', _sync_inner_width)
        canvas.configure(yscrollcommand=vscroll.set)

        canvas.pack(side='left', fill='both', expand=True)
        vscroll.pack(side='right', fill='y')

        # Mouse wheel only scrolls this canvas while the pointer is actually
        # over it -- a single always-on global binding would make whichever
        # tab was built most recently hijack every other tab's scroll wheel.
        def _wheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), 'units')
        canvas.bind('<Enter>', lambda e: canvas.bind_all('<MouseWheel>', _wheel))
        canvas.bind('<Leave>', lambda e: canvas.unbind_all('<MouseWheel>'))

        return inner

    def build_fields_tab(spec):
        scroll_body = _clear_and_scroll(fields_tab)

        box_field_map = {f['key']: f['label'] for f in spec['box_fields']}
        meta_field_map = {f['key']: f['label'] for f in spec['metadata_fields']}

        body = tk.Frame(scroll_body)
        body.pack(fill='both', expand=True)

        left = tk.LabelFrame(body, text="Box fields (per cabinet row)", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        left.pack(side='left', fill='both', expand=True, padx=(0, 8), pady=8)

        box_vars = {}
        box_label_vars = {}
        for f in default_box_fields:
            key = f['key']
            row = tk.Frame(left)
            row.pack(fill='x', pady=2)
            var = tk.BooleanVar(value=key in box_field_map)
            box_vars[key] = var
            tk.Checkbutton(row, variable=var, width=2).pack(side='left')
            label_var = tk.StringVar(value=box_field_map.get(key, f['label']))
            box_label_vars[key] = label_var
            tk.Entry(row, textvariable=label_var, width=26).pack(side='left', padx=(4, 0))

        count_row = tk.Frame(left)
        count_row.pack(fill='x', pady=(16, 2))
        tk.Label(count_row, text="Boxes per card:").pack(side='left')
        count_var = tk.StringVar(value=str(spec.get('box_count', 24)))
        tk.Entry(count_row, textvariable=count_var, width=6).pack(side='left', padx=(6, 0))

        right = tk.LabelFrame(body, text="Metadata fields", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        right.pack(side='left', fill='both', expand=True, pady=8)

        meta_vars = {}
        meta_label_vars = {}
        for f in default_metadata_fields:
            key = f['key']
            row = tk.Frame(right)
            row.pack(fill='x', pady=2)
            var = tk.BooleanVar(value=key in meta_field_map)
            meta_vars[key] = var
            tk.Checkbutton(row, variable=var, width=2).pack(side='left')
            label_var = tk.StringVar(value=meta_field_map.get(key, f['label']))
            meta_label_vars[key] = label_var
            tk.Entry(row, textvariable=label_var, width=26).pack(side='left', padx=(4, 0))

        widgets['box_vars'] = box_vars
        widgets['box_label_vars'] = box_label_vars
        widgets['count_var'] = count_var
        widgets['meta_vars'] = meta_vars
        widgets['meta_label_vars'] = meta_label_vars

    def build_layout_tab(spec):
        scroll_body = _clear_and_scroll(layout_tab)

        widths = spec.get('column_widths', {})

        widths_frame = tk.LabelFrame(scroll_body, text="Column widths", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        widths_frame.pack(fill='x', padx=8, pady=8)

        width_vars = {}
        for key, label in LAYOUT_WIDTH_FIELDS:
            row = tk.Frame(widths_frame)
            row.pack(fill='x', pady=2)
            tk.Label(row, text=label, width=20, anchor='w').pack(side='left')
            var = tk.StringVar(value=str(widths.get(key, 10)))
            width_vars[key] = var
            tk.Entry(row, textvariable=var, width=8).pack(side='left', padx=(6, 0))

        spacing_frame = tk.LabelFrame(scroll_body, text="Metadata spacing", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        spacing_frame.pack(fill='x', padx=8, pady=(0, 8))
        row = tk.Frame(spacing_frame)
        row.pack(fill='x', pady=2)
        tk.Label(row, text="Rows per metadata entry (label + value + blank):", anchor='w').pack(side='left')
        spacing_var = tk.StringVar(value=str(spec.get('row_spacing', 3)))
        tk.Entry(row, textvariable=spacing_var, width=6).pack(side='left', padx=(6, 0))

        widgets['width_vars'] = width_vars
        widgets['spacing_var'] = spacing_var

    def build_colors_tab(spec):
        scroll_body = _clear_and_scroll(colors_tab)

        color_vars = {}

        def argb_to_display(argb):
            return ('#' + argb[-6:]) if argb else None

        def pick_color(key, swatch):
            current = argb_to_display(color_vars[key].get())
            picked = colorchooser.askcolor(color=current, parent=root)[1]
            if picked:
                color_vars[key].set('FF' + picked[1:].upper())
                swatch.configure(bg=picked)

        def clear_color(key, swatch):
            color_vars[key].set('')
            swatch.configure(bg=default_bg)

        frame = tk.LabelFrame(scroll_body, text="Fill colors", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        frame.pack(fill='x', padx=8, pady=8)
        default_bg = frame.cget('bg')

        for key, label in COLOR_FIELDS:
            row = tk.Frame(frame)
            row.pack(fill='x', pady=4)
            tk.Label(row, text=label, width=20, anchor='w').pack(side='left')
            value = spec.get(key) or ''
            color_vars[key] = tk.StringVar(value=value)
            swatch = tk.Label(row, width=4, relief='groove', bg=(argb_to_display(value) or default_bg))
            swatch.pack(side='left', padx=(6, 6))
            tk.Button(row, text="Choose...", command=lambda k=key, s=swatch: pick_color(k, s)).pack(side='left', padx=(0, 4))
            tk.Button(row, text="Clear", command=lambda k=key, s=swatch: clear_color(k, s)).pack(side='left')

        widgets['color_vars'] = color_vars

    def build_align_tab(spec):
        scroll_body = _clear_and_scroll(align_tab)

        align_vars = {}

        frame = tk.LabelFrame(scroll_body, text="Horizontal text alignment", font=('Segoe UI', 10, 'bold'), padx=8, pady=8)
        frame.pack(fill='x', padx=8, pady=8)
        tk.Label(
            frame,
            text="Vertical alignment is always centered.",
            font=('Segoe UI', 9), fg='#555555',
        ).pack(anchor='w', pady=(0, 8))

        for key, label in ALIGN_FIELDS:
            row = tk.Frame(frame)
            row.pack(fill='x', pady=4)
            tk.Label(row, text=label, width=20, anchor='w').pack(side='left')
            # Fall back to 'left' if a profile saved before this feature
            # existed doesn't have the key yet.
            var = tk.StringVar(value=spec.get(key) or 'left')
            align_vars[key] = var
            combo = ttk.Combobox(row, textvariable=var, values=ALIGN_OPTIONS, state='readonly', width=10)
            combo.pack(side='left', padx=(6, 0))

        widgets['align_vars'] = align_vars

    def build_circuit_tab(spec):
        scroll_body = _clear_and_scroll(circuit_tab)

        def argb_to_display(argb):
            return ('#' + argb[-6:]) if argb else None

        enabled_var = tk.BooleanVar(value=spec.get('circuit_coloring_enabled', True))
        tk.Checkbutton(
            scroll_body, text="Color-code box rows by Circuit #", variable=enabled_var,
            font=('Segoe UI', 10, 'bold'),
        ).pack(anchor='w', padx=8, pady=(8, 4))

        palette_frame = tk.LabelFrame(
            scroll_body, text="Circuit # color cycle (applied in this order, repeating)",
            font=('Segoe UI', 10, 'bold'), padx=8, pady=8,
        )
        palette_frame.pack(fill='x', padx=8, pady=(0, 8))
        default_bg = palette_frame.cget('bg')

        cycle_row = tk.Frame(palette_frame)
        cycle_row.pack(fill='x', pady=(0, 8))
        tk.Label(cycle_row, text="Repeats after:").pack(side='left')
        cycle_length_var = tk.StringVar(value=str(spec.get('circuit_color_cycle_length', 4)))
        tk.Entry(cycle_row, textvariable=cycle_length_var, width=4).pack(side='left', padx=(6, 6))
        tk.Label(cycle_row, text="colors (some PA styles cycle through fewer than all 8 below)").pack(side='left')
        widgets['cycle_length_var'] = cycle_length_var

        # Shared plumbing for both 8-color palettes below (Circuit # and
        # Circuit SET): applying a list of 8 colors onto a set of StringVars
        # + swatches, and a little popup to pick from previously-saved named
        # palettes -- so building up a full 8-color cycle from scratch isn't
        # something the user has to do every single time.
        def _apply_palette_values(vars_list, swatches_list, values, fallback):
            for i in range(8):
                val = values[i] if i < len(values) else fallback[i]
                vars_list[i].set(val)
                swatches_list[i].configure(bg=argb_to_display(val) or default_bg)

        def _choose_saved_palette():
            palettes = load_color_palettes()
            if not palettes:
                messagebox.showinfo(
                    "No saved palettes",
                    "You haven't saved any color palettes yet -- use \"Save as palette...\" first.",
                    parent=root,
                )
                return None
            picker = tk.Toplevel(root)
            picker.title("Load Palette")
            picker.geometry("300x320")
            tk.Label(picker, text="Choose a saved palette:", font=('Segoe UI', 10, 'bold')).pack(pady=(12, 6))
            listbox = tk.Listbox(picker, font=('Segoe UI', 10))
            for name in sorted(palettes.keys()):
                listbox.insert(tk.END, name)
            listbox.pack(fill='both', expand=True, padx=12, pady=(0, 8))
            picked = {'name': None}

            def submit():
                sel = listbox.curselection()
                if sel:
                    picked['name'] = listbox.get(sel[0])
                picker.destroy()

            listbox.bind('<Double-Button-1>', lambda e: submit())
            pick_buttons = tk.Frame(picker)
            pick_buttons.pack(pady=(0, 12))
            tk.Button(pick_buttons, text="Cancel", command=picker.destroy).pack(side='left', padx=6)
            tk.Button(pick_buttons, text="Load", command=submit).pack(side='left', padx=6)
            picker.transient(root)
            picker.grab_set()
            root.wait_window(picker)
            return palettes.get(picked['name']) if picked['name'] else None

        def _save_palette(vars_list):
            name = simpledialog.askstring("Save Palette", "Palette name:", parent=root)
            if not name or not name.strip():
                return
            name = name.strip()
            palettes = load_color_palettes()
            palettes[name] = [v.get() for v in vars_list]
            save_color_palettes(palettes)
            status_var.set(f"Saved palette '{name}'.")

        def _load_palette_into(vars_list, swatches_list, fallback):
            loaded = _choose_saved_palette()
            if loaded:
                _apply_palette_values(vars_list, swatches_list, loaded, fallback)

        circuit_colors = list(spec.get('circuit_colors') or _DEFAULT_CIRCUIT_COLORS)
        circuit_color_vars = []
        circuit_color_swatches = []
        for i in range(8):
            row = tk.Frame(palette_frame)
            row.pack(fill='x', pady=3)
            tk.Label(row, text=f"Color {i + 1}", width=10, anchor='w').pack(side='left')
            value = circuit_colors[i] if i < len(circuit_colors) else _DEFAULT_CIRCUIT_COLORS[i]
            var = tk.StringVar(value=value)
            circuit_color_vars.append(var)
            swatch = tk.Label(row, width=4, relief='groove', bg=(argb_to_display(value) or default_bg))
            swatch.pack(side='left', padx=(6, 6))
            circuit_color_swatches.append(swatch)

            def pick(v=var, s=swatch):
                current = argb_to_display(v.get())
                picked = colorchooser.askcolor(color=current, parent=root)[1]
                if picked:
                    v.set('FF' + picked[1:].upper())
                    s.configure(bg=picked)

            tk.Button(row, text="Choose...", command=pick).pack(side='left')

        circuit_palette_buttons = tk.Frame(palette_frame)
        circuit_palette_buttons.pack(fill='x', pady=(6, 0))
        tk.Button(
            circuit_palette_buttons, text="Save as palette...",
            command=lambda: _save_palette(circuit_color_vars),
        ).pack(side='left', padx=(0, 6))
        tk.Button(
            circuit_palette_buttons, text="Load palette...",
            command=lambda: _load_palette_into(circuit_color_vars, circuit_color_swatches, _DEFAULT_CIRCUIT_COLORS),
        ).pack(side='left', padx=(0, 6))
        tk.Button(
            circuit_palette_buttons, text="Copy to Circuit SET colors ↓",
            command=lambda: _apply_palette_values(
                circuit_set_color_vars, circuit_set_color_swatches,
                [v.get() for v in circuit_color_vars], _DEFAULT_CIRCUIT_SET_COLORS,
            ),
        ).pack(side='left')

        widgets['circuit_enabled_var'] = enabled_var
        widgets['circuit_color_vars'] = circuit_color_vars

        # Circuit SET stripe: a second, independent gutter stripe -- every
        # group of `cycle_length` distinct circuits (Set 1, Set 2, ...) gets
        # its own color from this palette, wrapping back to the start after
        # 8 sets. Reuses the "Repeats after" count above rather than adding
        # a second number to configure.
        set_enabled_var = tk.BooleanVar(value=spec.get('circuit_set_coloring_enabled', True))
        tk.Checkbutton(
            scroll_body, text="Also stripe each set of circuits with its own color", variable=set_enabled_var,
            font=('Segoe UI', 10, 'bold'),
        ).pack(anchor='w', padx=8, pady=(4, 4))

        set_palette_frame = tk.LabelFrame(
            scroll_body, text="Circuit SET color cycle (one color per group of \"Repeats after\" circuits, in its own stripe beside the card)",
            font=('Segoe UI', 10, 'bold'), padx=8, pady=8,
        )
        set_palette_frame.pack(fill='x', padx=8, pady=(0, 8))

        circuit_set_colors = list(spec.get('circuit_set_colors') or _DEFAULT_CIRCUIT_SET_COLORS)
        circuit_set_color_vars = []
        circuit_set_color_swatches = []
        for i in range(8):
            row = tk.Frame(set_palette_frame)
            row.pack(fill='x', pady=3)
            tk.Label(row, text=f"Set {i + 1}", width=10, anchor='w').pack(side='left')
            value = circuit_set_colors[i] if i < len(circuit_set_colors) else _DEFAULT_CIRCUIT_SET_COLORS[i]
            var = tk.StringVar(value=value)
            circuit_set_color_vars.append(var)
            swatch = tk.Label(row, width=4, relief='groove', bg=(argb_to_display(value) or default_bg))
            swatch.pack(side='left', padx=(6, 6))
            circuit_set_color_swatches.append(swatch)

            def pick(v=var, s=swatch):
                current = argb_to_display(v.get())
                picked = colorchooser.askcolor(color=current, parent=root)[1]
                if picked:
                    v.set('FF' + picked[1:].upper())
                    s.configure(bg=picked)

            tk.Button(row, text="Choose...", command=pick).pack(side='left')

        set_palette_buttons = tk.Frame(set_palette_frame)
        set_palette_buttons.pack(fill='x', pady=(6, 0))
        tk.Button(
            set_palette_buttons, text="Save as palette...",
            command=lambda: _save_palette(circuit_set_color_vars),
        ).pack(side='left', padx=(0, 6))
        tk.Button(
            set_palette_buttons, text="Load palette...",
            command=lambda: _load_palette_into(circuit_set_color_vars, circuit_set_color_swatches, _DEFAULT_CIRCUIT_SET_COLORS),
        ).pack(side='left', padx=(0, 6))
        tk.Button(
            set_palette_buttons, text="↑ Copy to Circuit # colors",
            command=lambda: _apply_palette_values(
                circuit_color_vars, circuit_color_swatches,
                [v.get() for v in circuit_set_color_vars], _DEFAULT_CIRCUIT_COLORS,
            ),
        ).pack(side='left')

        widgets['circuit_set_enabled_var'] = set_enabled_var
        widgets['circuit_set_color_vars'] = circuit_set_color_vars

        # Hang overrides: a variable-length list, since which named hangs
        # exist (Main, Side, 270, Center Delay, ...) differs job to job.
        # Rows are entirely rebuilt on add/remove; edits in between just
        # live-update each row's own StringVars.
        hang_frame = tk.LabelFrame(
            scroll_body, text="Hang identity stripes (a colored bar next to matching sections; doesn't affect the cycle above)",
            font=('Segoe UI', 10, 'bold'), padx=8, pady=8,
        )
        hang_frame.pack(fill='both', expand=True, padx=8, pady=(0, 8))

        rows_container = tk.Frame(hang_frame)
        rows_container.pack(fill='both', expand=True)

        hang_state = {'rows': [dict(entry) for entry in (spec.get('hang_colors') or [])]}

        def render_hang_rows():
            for child in rows_container.winfo_children():
                child.destroy()
            row_vars = []
            for i, entry in enumerate(hang_state['rows']):
                row = tk.Frame(rows_container)
                row.pack(fill='x', pady=2)
                tk.Label(row, text="Section name contains:").pack(side='left')
                match_var = tk.StringVar(value=entry.get('match', ''))
                tk.Entry(row, textvariable=match_var, width=16).pack(side='left', padx=(6, 6))

                value = entry.get('fill') or ''
                color_var = tk.StringVar(value=value)
                swatch = tk.Label(row, width=4, relief='groove', bg=(argb_to_display(value) or default_bg))
                swatch.pack(side='left', padx=(0, 6))

                def pick(v=color_var, s=swatch):
                    current = argb_to_display(v.get())
                    picked = colorchooser.askcolor(color=current, parent=root)[1]
                    if picked:
                        v.set('FF' + picked[1:].upper())
                        s.configure(bg=picked)

                def clear(v=color_var, s=swatch):
                    v.set('')
                    s.configure(bg=default_bg)

                tk.Button(row, text="Choose...", command=pick).pack(side='left', padx=(0, 4))
                tk.Button(row, text="Clear (no stripe)", command=clear).pack(side='left', padx=(0, 4))

                def remove(idx=i):
                    sync_rows()
                    hang_state['rows'].pop(idx)
                    render_hang_rows()

                tk.Button(row, text="Remove", command=remove).pack(side='left', padx=(6, 0))

                row_vars.append({'match_var': match_var, 'color_var': color_var})

            widgets['hang_row_vars'] = row_vars

        def sync_rows():
            # Pull current widget values back into hang_state['rows'] before
            # a structural rebuild (add/remove), so in-progress edits on
            # other rows aren't lost when the row list is redrawn.
            for i, rv in enumerate(widgets.get('hang_row_vars', [])):
                if i < len(hang_state['rows']):
                    hang_state['rows'][i] = {
                        'match': rv['match_var'].get(),
                        'fill': rv['color_var'].get() or None,
                    }

        def add_row():
            sync_rows()
            hang_state['rows'].append({'match': '', 'fill': None})
            render_hang_rows()

        render_hang_rows()
        tk.Button(hang_frame, text="+ Add override", command=add_row).pack(anchor='w', pady=(6, 0))

    def build_page_header_tab(spec):
        scroll_body = _clear_and_scroll(page_header_tab)

        tk.Label(
            scroll_body,
            text="The document title is always shown, big and centered, at "
                 "the top of the sheet -- you'll be asked for its text (or "
                 "it'll default to the input file's name) each time you run "
                 "the parser. The fields below appear as a smaller stacked "
                 "list beside it; add or remove whatever your job needs "
                 "(Venue, Date, Engineer, ...).",
            font=('Segoe UI', 9), fg='#555555', wraplength=560, justify='left',
        ).pack(anchor='w', padx=8, pady=(8, 8))

        frame = tk.LabelFrame(
            scroll_body, text="Fields beside the title",
            font=('Segoe UI', 10, 'bold'), padx=8, pady=8,
        )
        frame.pack(fill='both', expand=True, padx=8, pady=(0, 8))

        rows_container = tk.Frame(frame)
        rows_container.pack(fill='both', expand=True)

        field_state = {'rows': [dict(entry) for entry in (spec.get('page_header_fields') or [])]}

        def render_page_header_rows():
            for child in rows_container.winfo_children():
                child.destroy()
            row_vars = []
            for i, entry in enumerate(field_state['rows']):
                row = tk.Frame(rows_container)
                row.pack(fill='x', pady=2)
                tk.Label(row, text="Label:").pack(side='left')
                label_var = tk.StringVar(value=entry.get('label', ''))
                tk.Entry(row, textvariable=label_var, width=20).pack(side='left', padx=(4, 12))

                def remove(idx=i):
                    sync_page_header_rows()
                    field_state['rows'].pop(idx)
                    render_page_header_rows()

                tk.Button(row, text="Remove", command=remove).pack(side='left', padx=(6, 0))

                row_vars.append({'label_var': label_var})

            widgets['page_header_row_vars'] = row_vars

        def sync_page_header_rows():
            # Pull current widget values back into field_state['rows'] before
            # a structural rebuild (add/remove), same reasoning as the hang
            # override rows above.
            for i, rv in enumerate(widgets.get('page_header_row_vars', [])):
                if i < len(field_state['rows']):
                    field_state['rows'][i]['label'] = rv['label_var'].get()

        def add_page_header_row():
            sync_page_header_rows()
            field_state['rows'].append({'label': ''})
            render_page_header_rows()

        render_page_header_rows()
        tk.Button(frame, text="+ Add field", command=add_page_header_row).pack(anchor='w', pady=(6, 0))

    def load_profile_into_form(name):
        spec = profiles[name]
        build_fields_tab(spec)
        build_layout_tab(spec)
        build_colors_tab(spec)
        build_align_tab(spec)
        build_circuit_tab(spec)
        build_page_header_tab(spec)
        status_var.set("")

    def collect_form_into_spec():
        """Read every widget's current value back into a fresh spec dict, or
        return None (with a status message set) if something's invalid."""
        try:
            count = int(widgets['count_var'].get())
            if count < 1:
                raise ValueError
        except ValueError:
            status_var.set("Boxes per card must be a whole number of at least 1.")
            return None

        chosen_box_fields = [
            {'key': f['key'], 'label': widgets['box_label_vars'][f['key']].get().strip() or f['label']}
            for f in default_box_fields
            if widgets['box_vars'][f['key']].get()
        ]
        if not chosen_box_fields:
            status_var.set("Pick at least one box field.")
            return None

        chosen_meta_fields = [
            {'key': f['key'], 'label': widgets['meta_label_vars'][f['key']].get().strip() or f['label']}
            for f in default_metadata_fields
            if widgets['meta_vars'][f['key']].get()
        ]

        try:
            spacing = int(widgets['spacing_var'].get())
            if spacing < 2:
                raise ValueError
        except ValueError:
            status_var.set("Metadata spacing must be a whole number of at least 2.")
            return None

        widths = {}
        for key, label in LAYOUT_WIDTH_FIELDS:
            try:
                widths[key] = float(widgets['width_vars'][key].get())
            except ValueError:
                status_var.set(f"Column width for '{label}' must be a number.")
                return None

        colors = {}
        for key, _ in COLOR_FIELDS:
            v = widgets['color_vars'][key].get().strip()
            colors[key] = v or None

        aligns = {}
        for key, _ in ALIGN_FIELDS:
            aligns[key] = widgets['align_vars'][key].get()

        circuit_colors = []
        for i, v in enumerate(widgets['circuit_color_vars']):
            val = v.get().strip()
            circuit_colors.append(val or _DEFAULT_CIRCUIT_COLORS[i])

        try:
            cycle_length = int(widgets['cycle_length_var'].get())
            if not (1 <= cycle_length <= len(circuit_colors)):
                raise ValueError
        except ValueError:
            status_var.set(f"'Repeats after' must be a whole number between 1 and {len(circuit_colors)}.")
            return None

        circuit_set_colors = []
        for i, v in enumerate(widgets['circuit_set_color_vars']):
            val = v.get().strip()
            circuit_set_colors.append(val or _DEFAULT_CIRCUIT_SET_COLORS[i])

        hang_colors = []
        for rv in widgets.get('hang_row_vars', []):
            match = rv['match_var'].get().strip()
            if not match:
                continue
            fill = rv['color_var'].get().strip() or None
            hang_colors.append({'match': match.lower(), 'fill': fill})

        # Keys are derived from the label text rather than typed in directly
        # -- the user only ever sees/edits the label ("Venue", "Show Date",
        # ...); a safe, unique PAGE_<KEY> token is invented from it here.
        page_header_fields = []
        seen_page_keys = set()
        for i, rv in enumerate(widgets.get('page_header_row_vars', [])):
            label = rv['label_var'].get().strip()
            if not label:
                continue
            base_key = re.sub(r'[^a-z0-9]+', '_', label.lower()).strip('_') or f'field{i + 1}'
            if base_key == 'title':
                base_key = 'title_field'
            key = base_key
            n = 2
            while key in seen_page_keys:
                key = f'{base_key}{n}'
                n += 1
            seen_page_keys.add(key)
            page_header_fields.append({'key': key, 'label': label})

        new_spec = dict(profiles[state['current']])
        new_spec['box_count'] = count
        new_spec['box_fields'] = chosen_box_fields
        new_spec['metadata_fields'] = chosen_meta_fields
        new_spec['row_spacing'] = spacing
        new_spec['column_widths'] = {**new_spec.get('column_widths', {}), **widths}
        new_spec.update(colors)
        new_spec.update(aligns)
        new_spec['circuit_coloring_enabled'] = widgets['circuit_enabled_var'].get()
        new_spec['circuit_colors'] = circuit_colors
        new_spec['circuit_color_cycle_length'] = cycle_length
        new_spec['circuit_set_coloring_enabled'] = widgets['circuit_set_enabled_var'].get()
        new_spec['circuit_set_colors'] = circuit_set_colors
        new_spec['hang_colors'] = hang_colors
        new_spec['page_header_fields'] = page_header_fields
        return new_spec

    def on_profile_selected(event=None):
        chosen = profile_var.get()
        if chosen == state['current']:
            return
        # Save the outgoing profile's current form state before switching,
        # so flipping between profiles to compare them doesn't lose edits.
        spec = collect_form_into_spec()
        if spec is not None:
            profiles[state['current']] = spec
        state['current'] = chosen
        load_profile_into_form(chosen)

    profile_combo.bind('<<ComboboxSelected>>', on_profile_selected)

    def on_save_as():
        name = simpledialog.askstring("Save As", "New profile name:", parent=root)
        if not name or not name.strip():
            return
        name = name.strip()
        spec = collect_form_into_spec()
        if spec is None:
            return
        profiles[name] = spec
        state['current'] = name
        profile_combo.configure(values=list(profiles.keys()))
        profile_var.set(name)
        status_var.set(f"Saved as new profile '{name}'.")

    def on_delete():
        if len(profiles) <= 1:
            status_var.set("Can't delete the only profile.")
            return
        current = state['current']
        if not messagebox.askyesno("Delete profile", f"Delete profile '{current}'?", parent=root):
            return
        del profiles[current]
        state['current'] = next(iter(profiles))
        profile_combo.configure(values=list(profiles.keys()))
        profile_var.set(state['current'])
        load_profile_into_form(state['current'])
        status_var.set(f"Deleted '{current}'.")

    tk.Button(profile_bar, text="Save As...", command=on_save_as).pack(side='left', padx=(0, 6))
    tk.Button(profile_bar, text="Delete", command=on_delete).pack(side='left')

    tk.Label(root, textvariable=status_var, fg='#B00020', font=('Segoe UI', 9)).pack(pady=(0, 4))

    def on_generate():
        spec = collect_form_into_spec()
        if spec is None:
            return
        profiles[state['current']] = spec
        result['outcome'] = (profiles, state['current'])
        root.destroy()

    def on_cancel():
        result['outcome'] = None
        root.destroy()

    def _build_preview_sections(spec):
        """
        A couple of made-up sections just for the preview -- enough boxes to
        show the circuit-color cycle and the circuit-SET stripe running
        through a few full groups, one section named to match the profile's
        own first hang-color override (if any) so that stripe shows up too,
        and every configured metadata field filled with a placeholder value
        so its column isn't just blank.
        """
        box_count = max(1, min(int(spec.get('box_count', 24) or 24), 16))
        hang_names = [e.get('match', '') for e in (spec.get('hang_colors') or []) if e.get('match')]
        names = ['Preview Section A']
        names.append(f'Preview Section B ({hang_names[0]})' if hang_names else 'Preview Section B')

        meta_placeholders = {f['key']: f"Sample {f['label']}" for f in (spec.get('metadata_fields') or [])}

        sections = []
        for idx, name in enumerate(names, start=1):
            cabinets = [
                {
                    'position': i + 1, 'model': 'SAMPLE-1', 'dispersion': '90',
                    'splay': '2.5', 'ckt': str(i + 1), 'nfc': f'{i + 1}m',
                }
                for i in range(box_count)
            ]
            sections.append({
                'section_number': idx, 'header': name, 'cabinets': cabinets,
                'metadata': dict(meta_placeholders), 'safety_alerts': [],
            })
        return sections

    def on_preview():
        spec = collect_form_into_spec()
        if spec is None:
            return

        # Deferred imports -- design_generator.py imports this module at its
        # own top level, so importing it back from here at module scope
        # would be circular. By the time this button is actually clicked,
        # both modules are already fully loaded, so a function-local import
        # resolves cleanly.
        import design_generator as _design_generator
        import worksheet_writer as _worksheet_writer
        import os as _os

        problems = []
        if not _design_generator.validate_spec(spec, problems):
            messagebox.showerror("Can't preview", "\n".join(problems) or "Spec has a problem.", parent=root)
            return

        preview_dir = Path(__file__).resolve().parent / '_preview'
        _os.makedirs(win_long_path(preview_dir), exist_ok=True)
        design_path = preview_dir / 'preview_design.xlsx'
        _design_generator.generate_design(spec, design_path)

        import json as _json
        colors_path = design_path.with_suffix('.colors.json')
        with open(win_long_path(colors_path), 'w', encoding='utf-8') as f:
            _json.dump({
                'enabled': spec.get('circuit_coloring_enabled', True),
                'circuit_colors': spec.get('circuit_colors', []),
                'cycle_length': spec.get('circuit_color_cycle_length', 4),
                'hang_colors': spec.get('hang_colors', []),
                'circuit_set_enabled': spec.get('circuit_set_coloring_enabled', True),
                'circuit_set_colors': spec.get('circuit_set_colors', []),
            }, f, indent=2)

        page_header_values = None
        if spec.get('page_header_fields') is not None:
            page_header_values = {'title': 'Preview'}
            for f in spec.get('page_header_fields') or []:
                page_header_values[f['key']] = f"Sample {f['label']}"

        output_path = preview_dir / 'preview_output.xlsx'
        sample_sections = _build_preview_sections(spec)
        _worksheet_writer.write_master_workbook(
            sample_sections, design_path, win_long_path(output_path), cards_per_row=2,
            page_header_values=page_header_values,
        )

        try:
            _os.startfile(win_long_path(output_path))
        except (AttributeError, OSError):
            status_var.set(f"Preview written to {output_path} (couldn't auto-open it -- open it manually).")
        else:
            status_var.set("Preview opened -- close it and click Preview again after making more changes.")

    button_row = tk.Frame(root)
    button_row.pack(pady=14)
    tk.Button(button_row, text="Cancel", width=14, command=on_cancel).pack(side='left', padx=6)
    tk.Button(button_row, text="Preview Output...", width=18, command=on_preview).pack(side='left', padx=6)
    tk.Button(button_row, text="Save & Generate design.xlsx", width=26, command=on_generate).pack(side='left', padx=6)

    load_profile_into_form(state['current'])

    root.lift()
    root.attributes('-topmost', True)
    root.after_idle(lambda: root.attributes('-topmost', False))
    root.mainloop()

    return result['outcome']
