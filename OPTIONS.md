# User options reference

Every user-facing option in PA Pinner, grouped by where it lives in the
Global → Show → Date → Hang cascade. This is a hand-maintained index, but
the five groups most prone to drifting apart (Colors, Circuit Numbering,
Box/Pick Groups, Data Bar, Trim Units) are actually driven by one shared
schema file, [`static/config-fields.js`](static/config-fields.js) — that
file, not this doc, is the source of truth for what fields exist in those
groups. Add a field there and it appears on both the Show page's default
editor and the Date page's override editor automatically. Everything else
below is a single-surface option with nothing to keep in sync, so it's
listed directly.

## Schema-driven groups (`static/config-fields.js`)

Both surfaces below read `FLAT_FIELD_GROUPS` from the shared file and
render through `renderFlatFieldList`. Show sets the show-wide default;
Date starts seeded from that default and can diverge from it (with a
"Reset to show default" button), same object shape either way.

| Group | Show page | Date page | Backend field |
|---|---|---|---|
| Colors | Configure Pinning Sheets → Colors | Colors panel | `circuit_color_config` (`enabled`, `show_row_fill`, `ink_friendly_patterns`, `hang_colors`, `circuit_colors`, `cycle_length`) |
| Circuit Numbering | Configure Pinning Sheets → Circuit Numbering | Circuit Numbering panel | `circuit_color_config` (`breakout_cable_name`, `numbering_mode`, `hid_bundle_size`, `hid_reverse_order_default`, `circuit_set_enabled`, `circuit_set_colors`) |
| Box Groups | Configure Pinning Sheets → Box Groups | Box Groups panel | `circuit_color_config` (`pick_group_enabled`, `pick_group_size`) |

Data Bar mode and Trim Units share their *value lists*
(`DATA_BAR_MODE_OPTIONS`, `TRIM_UNIT_FORMAT_OPTIONS`,
`TRIM_INCHES_PRECISION_OPTIONS`) from the same file, but keep two different
renderer shapes since a Date's version adds a leading "Default (currently
X)" choice that the Show version doesn't need:

| Group | Show page (sets default) | Date page (overrides default) | Backend field |
|---|---|---|---|
| Data Bar placement | Configure Pinning Sheets → Data Bar | Data Bar panel | `show.data_bar_mode` / `job.data_bar_mode_override` |
| Trim display format | Configure Pinning Sheets → Trim Units | Trim Units panel | `show.trim_unit_format` / `job.trim_unit_format_override` |
| Trim inches precision | Configure Pinning Sheets → Trim Units | Trim Units panel | `show.trim_inches_precision` / `job.trim_inches_precision_override` |

Data Tags is likewise a Show-default/Date-override pair (Configure Pinning
Sheets → Data Tags; Date page's Data Tags panel with a 3-way
Default/Show/Hide toggle per tag), but the field list itself — which
metadata tags exist — already comes from one shared source
(`GET /api/design-fields`, reading `design.xlsx`), so there's no separate
schema needed to keep it in sync.

## Show-level defaults (not schema-driven — single field, nothing to drift)

- **Tape Burn default (ft)** — Configure Pinning Sheets → Tape Burn. `show.tape_burn_default_ft`.

## Platform Profiles (cross-show presets)

Configure Pinning Sheets → Platform Profiles. Saves/restores every Show
default above in one snapshot: `circuit_color_config`, `hidden_tags`,
`data_bar_mode`, `tape_burn_default_ft`, `trim_unit_format`,
`trim_inches_precision`, plus the global next-new-date carry-forward prefs
(`strip_pair_labels`, `view_mode`, `cards_per_row`). `data/platform_profiles.json`.

## Hang Profiles (cross-show, per-hang presets)

Applied/saved from a hang's "Define" popover (⚙️ icon on each card) on the
Date page. Fields: `start_breakout`, `hid_reverse_order`, `tape_burn_ft`,
`apply_manual_circuiting`, `manual_circuit_pattern`, `hang_color`,
`rename_to`, `hidden_tags`, and the full pick-group setup —
`pick_group_size`, `pick_manual_breaks`, `pick_manual_merges`,
`pick_group_names` — see `HANG_PROFILE_FIELDS` in `app.py`. The last
three are keyed by cab.position, same as `manual_circuit_pattern`'s own
per-box indexing, so they carry over correctly when applied to a hang
with the same box layout the profile was saved from (the common case).
Version-tracked; a linked hang shows a mismatch banner if the profile
changes elsewhere.

## Date-level options (not part of the Show-default cascade)

- **Show title / Venue / Date / Address** — page header fields, free text. `job.page_header`.
- **Venue search** — magnifying-glass button next to Venue; queries `/api/venue-search`, auto-fills Venue + Address.
- **Upload sheet** — `.pdf`/`.txt`, 20MB max, reconciles against existing hangs.
- **Cards per row** (1–6) and **Strip "(Pair)" from hang titles** — Page Design panel; also carried into `data/prefs.json` for the next new Date anywhere.
- **Hangs list** — rename / reorder (▲▼) each hang.

## Per-hang options (Hang Define popover)

Apply/save a Hang Profile, **Start on Breakout #**, clear mid-hang trunk
splits, **Descending leg order** (per-hang override of the show/date
default), **Tape Burn (ft)** (per-hang override), **Boxes per pick / cart
height** (per-hang override of `circuit_color_config.pick_group_size`,
empty = use the show/date default — see `resolvePickGroupSize` in
`app.js`), **Apply Manual Circuiting** + pattern, **Hang Color**, hang
name, **Notes**, per-tag Data Tags override.

## Per-box / in-card controls

CKT text input, trunk-stripe click menu (assign to cable / start new
cable / undo split), inline Tape Burn editor. Pick-group controls (see
below) are the one exception to "per-box controls sit in the table" —
they live entirely on the hang stripe instead, nothing under the Cab #
column.

## Pick-group controls (hang stripe only)

Every pick gets one label on the stripe, spanning its own boxes' full
height (`makePickGroupNameLabel` in `app.js`) — the custom name if one's
set (`section.pick_group_names`, keyed by that pick's first box position,
optional, e.g. "SL Cart"), else just its own letter (A, B, C, ...) so a
box's pick is identifiable even unnamed. Costs no extra row height in the
table either way. Clicking that label resolves WHICH box within the pick
was actually clicked (by vertical position) and opens a menu for it:
the pick's own first box offers rename plus merge-with-previous (works on
both manual splits and natural ones — a box-type change or hitting the
size cap — see `pick_manual_breaks`/`pick_manual_merges` on a section);
any other box in the pick offers "start a new pick here". Dragging the
divider grip (also on the stripe) moves an existing split to any other
box in one gesture (`movePickBreak` in `app.js`). Prints onto the sheet
the same way it looks on screen.

## Display / device-local (not persisted server-side)

- **Dark mode** — `localStorage['pa-pinner-theme-dark']`, all three pages.
- **Sidebar collapse** (Date page, desktop) — `localStorage['pa-pinner-sidebar-collapsed']`.
- **Local "hide tag on this device"** (view-only visitors only) — `localStorage['pa-pinner-local-hidden-tags']`, additive on top of the shared hierarchy.
- Hang tab selection ("All" vs. one hang), mobile hamburger menu, card info accordion — ephemeral, reset on reload.

## Export / Print

- **Export PDF (grid)…** and **Export PDF (mobile)…** — browser print-to-PDF, no user-configurable options beyond the two buttons; layout is derived from Cards per row / hang content.

## Auth / sharing

- **Password gate** — gates editing only (POST/PUT/DELETE `/api/*`); viewing always works anonymously.
- **`?view=1` URL param** — forces read-only regardless of auth state (read-only share link).

## Global (next-new-date carry-forward)

`data/prefs.json`: `cards_per_row`, `strip_pair_labels`, `view_mode` — seeded onto every brand-new Date created anywhere, updated every time any Date's Page Design panel is saved.
