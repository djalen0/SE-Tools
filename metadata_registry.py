"""
Extra metadata-field vocabulary beyond the fixed set design.xlsx's own
template tokens define (layout_constants.py's METADATA_TOKEN_* -- Aim,
Slider, Trim, Angle, Pick, Wt). Those are tied to physical columns in the
xlsx export template, so a field with no template column (because it
comes from a different manufacturer's export format entirely, e.g. Meyer
Sound MAPP 3D's Distance to Base / Array Dimensions) has nowhere to live
in that system. This is the second, template-independent list such
fields register into instead -- app.py's build_job() unions it with the
xlsx-driven list, keeping only whichever keys actually have data in the
job's just-parsed sections (see _metadata_fields_for_job), so a Canvas
show never sees Meyer-only toggles sitting empty and vice versa.

Add a new manufacturer's extra fields here (key, label) and populate
section['metadata'][key] for them in that manufacturer's parser -- no
other wiring needed, this list is the only place a new key has to be
registered to become visible/toggleable.
"""

EXTRA_METADATA_FIELDS = [
    ('distance_to_base_ft', 'Distance to Base (ft)'),
    ('array_depth_ft', 'Array Depth (ft)'),
    ('array_width_ft', 'Array Width (ft)'),
    ('array_height_ft', 'Array Height (ft)'),
    ('grid_tilt_deg', 'Grid Tilt (°)'),
    ('total_splay_deg', 'Total Splay (°)'),
]
