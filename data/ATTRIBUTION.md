# Data attribution

This directory bundles two third-party datasets, both under **CC BY 4.0** (Creative
Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/).
Each bundle's own header also records its `source`, `release`, `license` and
`attribution`; this file is the canonical, human-readable notice.

## Global Energy Monitor trackers

Extracts from two [Global Energy Monitor](https://globalenergymonitor.org) (GEM)
trackers, converted to compact JSON by `scripts/convert-gem.py`:

| File | Tracker | Bundled release |
|---|---|---|
| `gem-geothermal.json` | Global Geothermal Power Tracker | March 2026 (`Geothermal-Power-Tracker-March-2026-Final.xlsx`) |
| `gem-oilgas-fields.json` | Global Oil & Gas Extraction Tracker | March 2026 (`Global-Oil-and-Gas-Extraction-Tracker-March-2026.xlsx`) |

**Attribution:** when publishing or sharing results derived from this data
(including via the `search_gem_projects` tool), credit **"Global Energy Monitor"**
and link to https://globalenergymonitor.org. The tool's response includes this
attribution on every call.

**Refreshing:** download a new release from https://globalenergymonitor.org/download-data/,
`pip install -r scripts/requirements.txt` (just `openpyxl`), then run
`python scripts/convert-gem.py <dir-with-the-new-xlsx-files>`. See that script's
docstring for the filename patterns it looks for.

## IHFC Global Heat Flow Database

| File | Dataset | Bundled release |
|---|---|---|
| `ihfc-heatflow.json.gz` | IHFC Global Heat Flow Database (GHFDB) | Release 2024, v.2026.03 (`IHFC_2024_GHFDB_v.2026.03.txt`) |

A gzipped extract - one row per heat-flow measurement, with the site's heat flow,
location, depth, purpose, temperature gradient, thermal conductivity, year, quality
code and publication reference - converted by `scripts/convert-ihfc.py`. Exact zeros
in heat flow and gradient (placeholders for "not reported") become null; nothing
else is altered.

**Citation** (included in every `search_heat_flow` response):
Global Heat Flow Data Assessment Group et al. (2024): The Global Heat Flow Database:
Release 2024. V. 2026.03. GFZ Data Services. https://doi.org/10.5880/fidgeo.2024.014

**Refreshing:** download the newest release zip from GFZ Data Services
(https://doi.org/10.5880/fidgeo.2024.014 or a later release DOI) and run
`python scripts/convert-ihfc.py <release.zip>` (standard library only).
