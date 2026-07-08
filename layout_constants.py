import re

# --- Shared vocabulary between the parser and the design generator --------
#
# Both txt_parse_v5.py (reads a design.xlsx template) and design_generator.py
# (writes one) have to agree on exactly the same set of box-field suffixes
# and metadata tokens, or a template built by one won't be understood by the
# other. Keeping them here, in a module neither script "owns", means neither
# one has to import internals from the other just to stay in sync.

BOX_FIELD_SUFFIX_TO_KEY = {
    'MODEL': 'model',
    'HORIZTONALDISPERSION': 'dispersion',  # typo preserved -- matches design.xlsx's own formulas
    'ANGLE': 'angle',
    'CIRCUIT': 'circuit',
    'NFC': 'nfc',
}

METADATA_TOKEN_ORDER = [
    'AIM', 'SLIDER', 'TOTALWEIGHT', 'TRIMTOP', 'ANGLETOP', 'TRIMBOTTOM',
    'ANGLEBOTTOM', 'PICKFRONT', 'WEIGHTFRONT', 'PICKREAR', 'WEIGHTREAR',
]
METADATA_TOKEN_LABELS = {
    'AIM': 'AIM', 'SLIDER': 'SLIDER', 'TOTALWEIGHT': 'Total Weight',
    'TRIMTOP': 'TRIM TOP', 'ANGLETOP': 'ANGLE TOP', 'TRIMBOTTOM': 'TRIM BOTTOM',
    'ANGLEBOTTOM': 'ANGLE BOTTOM', 'PICKFRONT': 'PICK FRONT',
    'WEIGHTFRONT': 'WEIGHT FRONT', 'PICKREAR': 'PICK POINT REAR',
    'WEIGHTREAR': 'WEIGHT REAR',
}
METADATA_TOKEN_KEYS = {
    'AIM': 'aim', 'SLIDER': 'slider_position', 'TOTALWEIGHT': 'total_weight',
    'TRIMTOP': 'trim_top', 'ANGLETOP': 'angle_top', 'TRIMBOTTOM': 'trim_bottom',
    'ANGLEBOTTOM': 'angle_bottom', 'PICKFRONT': 'pick_front',
    'WEIGHTFRONT': 'weight_front', 'PICKREAR': 'pick_rear', 'WEIGHTREAR': 'weight_rear',
}

BOX_FIELD_FORMULA_RE = re.compile(r'"_(' + '|'.join(BOX_FIELD_SUFFIX_TO_KEY) + r')"')
