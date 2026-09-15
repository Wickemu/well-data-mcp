# well-data-mcp

MCP server for oil & gas / geothermal well data, pulled live from state regulator
ArcGIS REST services. No API keys, no scraping — these are the same endpoints the
states' own map viewers use.

## Coverage (verified 2026-08-28)

| Key | Source | Agency | Notes |
|---|---|---|---|
| `CA-OG` | California oil & gas wells | CalGEM (WellSTAR) | Full headers: operator, status, type, field, county, spud |
| `CA-GEO` | California geothermal wells | CalGEM (WellSTAR) | Separate layer, incl. completion/abandon dates |
| `UT` | Utah oil & gas wells | Utah DOGM via SITLA GIS | Rich: incl. cumulative oil/gas/water production. **O&G only** — Utah geothermal is DWRi-regulated with no registry; use `search_geothermal_datasets` for Cape Station |
| `NM` | New Mexico oil & gas wells | NM OCD (EMNRD) | Rich: depths, spud/plug/last-production dates |
| `CO` | Colorado wells | ECMC via CO DNR GIS | Current but thin: API, name, operator, status, basin, lat/lon |
| `ND` | North Dakota oil & gas wells | ND DMR O&G Division | Updated hourly; incl. TD, NDIC file no |
| `TX` | Texas well locations | Texas RRC public GIS | **Location + API only** — RRC's GIS has no operator/status; that detail lives in their non-GIS systems |
| `NV-GEO` | Nevada geothermal wells | NBMG (UNR) / NGDS | Academic mirror; thermal class, permit no; lags recent drilling |
| `NZ-PET` | New Zealand petroleum wells | NZP&M | UWI, operator, TD, dates, prospect/field; server 500s on empty results (handled) and on outSR (handled) |
| `GP-BSS` | Guadeloupe / France boreholes | BRGM (BSS via WFS) | All borehole types; no operator/status; each record links its InfoTerre detail sheet |

## Tools

- **`list_sources`** — what's queryable, per-source filters and caveats
- **`search_wells`** — by operator / well name / county / field / status / type, any state or all; `count_only` to size first
- **`get_well`** — full raw record by API number in any format (dashes, prefixes handled); searches all states if state unknown
- **`wells_near`** — radius search around lat/lon (wells on a pad or project site)
- **`list_operators`** — discover the exact operator strings a state uses before searching
- **`raw_query`** — raw SQL-92 `where` against any source layer (dates, depths, cum production…)
- **`search_geothermal_datasets`** — DOE geothermal project datasets via the keyless OSTI Data Explorer API (indexes the GDR): well logs, stimulation, flow tests, microseismic. This is the Fervo Cape Station channel (search `cape egs` or `fervo`) and Utah FORGE.
- **`search_gem_projects`** — bundled Global Energy Monitor data (local, offline): 835 geothermal power units worldwide + 7,673 upstream O&G fields. Covers Kenya (Olkaria: 24 units), NZ, Guadeloupe (Bouillante), Guatemala, Namibia (Orange Basin: Graff, Mopane, Venus...), and Fervo's whole pipeline (Cape Station phases, Corsac, Project Red). Filter by country/name/operator/status or lat/lon radius. Refresh: download a new release from globalenergymonitor.org/download-data, then `python scripts/convert-gem.py <dir>`. CC BY 4.0 — cite GEM.

## Run / register

```
npm install
npm run smoke          # live test, one query per source
claude mcp add --scope user well-data -- node <abs-path>/src/index.js
```

## Adding a state

One entry in `src/states.js`: layer URL + field map + normalizer. Find the layer by
probing the state's ArcGIS server (`…/rest/services?f=json`), then a layer's schema
via `…/MapServer/<id>?f=json`. Most state O&G regulators run ArcGIS; the query
grammar is identical everywhere.

## Geothermal + international coverage truth (researched 2026-08-28)

- **Utah geothermal (Fervo Cape Station)**: regulated by the Utah **Division of Water
  Rights** (Geothermal Resource Conservation Act), NOT DOGM — and DWRi publishes no
  machine-readable registry (their "historic data" is Google Drive folders of scans).
  DOGM's database has zero geothermal well types. Cape Station well-level data flows
  through **BLM** (federal GDPs, no public API) and Fervo's DOE-funded publications on
  the **GDR** — which `search_geothermal_datasets` covers (e.g. Frisco 2-P stimulation
  microseismic, Frisco pad flow tests).
- **NZ geothermal**: regulated regionally (RMA), not by NZP&M. GNS Science's GGW
  database holds it but requires a signed data agreement.
- **No public well registry** (verified nothing machine-readable exists): Guatemala
  (MEM), Belize (Geology & Petroleum Dept), Kenya (KenGen/GDC private), Namibia
  (NAMCOR). `list_sources` reports these so searches fail honestly. Project-level
  coverage exists in Global Energy Monitor's trackers (form-gated download).

Known follow-ups:
- **Colorado**: ECMC retires its legacy map Sept 4, 2026 and is moving to a new
  ESRI stack; the `gisdnr.state.co.us` ECMC_Public services are the DNR-hosted ones
  — re-verify after the cutover.
- **Wyoming / Oklahoma / Kansas**: not yet mapped; same pattern should apply.
- **FracFocus**: bulk CSV + API for completion chemistry, could join on API-14.
- **GEM trackers**: bundled (March-Aug 2026 releases) in `data/`; re-run
  `scripts/convert-gem.py` on future downloads. Belize has zero GEM O&G coverage
  (Spanish Lookout too small) — still no machine-readable source for Belize.
