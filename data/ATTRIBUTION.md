# Data attribution

This directory bundles extracts from two [Global Energy Monitor](https://globalenergymonitor.org)
(GEM) trackers, converted to compact JSON by `scripts/convert-gem.py`:

| File | Tracker | Bundled release |
|---|---|---|
| `gem-geothermal.json` | Global Geothermal Power Tracker | March 2026 (`Geothermal-Power-Tracker-March-2026-Final.xlsx`) |
| `gem-oilgas-fields.json` | Global Oil & Gas Extraction Tracker | March 2026 (`Global-Oil-and-Gas-Extraction-Tracker-March-2026.xlsx`) |

The exact source filename each bundle was converted from is also recorded in
that file's own `source` field (and, from the next regeneration onward, its
`release`, `license`, `attribution` and `url` fields too - see below).

## License

Global Energy Monitor publishes these trackers under
**CC BY 4.0** (Creative Commons Attribution 4.0 International):
https://creativecommons.org/licenses/by/4.0/

## Attribution

When publishing or sharing results derived from this data (including via the
`search_gem_projects` tool), credit **"Global Energy Monitor"** and link back
to https://globalenergymonitor.org, per the license terms. The tool's own
response already includes this attribution string on every call.

## Refreshing

Download a new release from https://globalenergymonitor.org/download-data/
and run:

```
python scripts/convert-gem.py <dir-with-the-new-xlsx-files>
```

See that script's docstring for the exact filename patterns it looks for.
Starting with the next regeneration, each bundle's JSON header carries its
own `license` / `attribution` / `url` / `release` fields alongside `source`
and `records`; this file stays the canonical, human-readable notice for the
data already bundled.
