"""Convert GEM tracker xlsx files to the compact JSON bundles data/ ships.

Usage:  python scripts/convert-gem.py <dir-with-GEM-xlsx-files>

Looks for (name patterns, any release month):
  Geothermal-Power-Tracker-*.xlsx            -> data/gem-geothermal.json
  Global-Oil-and-Gas-Extraction-Tracker-*.xlsx -> data/gem-oilgas-fields.json

Re-run whenever a new GEM release is downloaded (globalenergymonitor.org/download-data).
"""

import glob
import json
import os
import sys

import openpyxl

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def rows_of(path, sheet):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb[sheet]
    it = ws.iter_rows(values_only=True)
    headers = [str(h).strip() if h is not None else "" for h in next(it)]
    for row in it:
        if all(v is None for v in row):
            continue
        yield dict(zip(headers, row))
    wb.close()


def num(v):
    if v is None or v == "" or str(v).strip() in ("--", "N/A", "n/a", "unknown", "not found"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def txt(v):
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s not in ("--", "N/A", "n/a") else None


def year(v):
    n = num(v)
    return int(n) if n else None


def convert_geothermal(path):
    out = []
    for r in rows_of(path, "Data"):
        out.append(
            {
                "country": txt(r.get("Country/Area")),
                "project": txt(r.get("Project Name")),
                "unit": txt(r.get("Unit Name")),
                "otherNames": txt(r.get("Other Name(s)")),
                "capacityMW": num(r.get("Unit Capacity (MW)")),
                "technology": txt(r.get("Technology")),
                "status": txt(r.get("Status")),
                "startYear": year(r.get("Start Year")),
                "operator": txt(r.get("Operator")),
                "owner": txt(r.get("Owner")),
                "stateProvince": txt(r.get("State/Province")),
                "latitude": num(r.get("Latitude")),
                "longitude": num(r.get("Longitude")),
                "gemUnitId": txt(r.get("GEM unit ID")),
                "wikiUrl": txt(r.get("Wiki URL")),
            }
        )
    return out


def convert_goget(path):
    out = []
    for r in rows_of(path, "Field-level main data"):
        out.append(
            {
                "unitId": txt(r.get("Unit ID")),
                "name": txt(r.get("Unit Name")),
                "otherNames": txt(r.get("Name Other")),
                "fuelType": txt(r.get("Fuel type")),
                "country": txt(r.get("Country/Area")),
                "subnational": txt(r.get("Subnational unit")),
                "productionType": txt(r.get("Production Type")),
                "status": txt(r.get("Status")),
                "statusDetail": txt(r.get("Status detail")),
                "discoveryYear": year(r.get("Discovery year")),
                "productionStartYear": year(r.get("Production start year")),
                "operator": txt(r.get("Operator")),
                "owners": txt(r.get("Owner(s)")),
                "latitude": num(r.get("Latitude")),
                "longitude": num(r.get("Longitude")),
                "onshoreOffshore": txt(r.get("Onshore/Offshore")),
                "basin": txt(r.get("Basin")),
                "blocks": txt(r.get("Block(s)")),
                "wikiUrl": txt(r.get("Wiki URL (project)")) or txt(r.get("Wiki URL (field)")),
            }
        )
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(OUT_DIR, exist_ok=True)
    release = {}

    geo = glob.glob(os.path.join(src, "Geothermal-Power-Tracker-*.xlsx"))
    if geo:
        data = convert_geothermal(geo[0])
        release["geothermal"] = os.path.basename(geo[0])
        with open(os.path.join(OUT_DIR, "gem-geothermal.json"), "w", encoding="utf-8") as f:
            json.dump({"source": os.path.basename(geo[0]), "records": data}, f, ensure_ascii=False)
        print(f"gem-geothermal.json: {len(data)} units from {os.path.basename(geo[0])}")

    og = glob.glob(os.path.join(src, "Global-Oil-and-Gas-Extraction-Tracker-*.xlsx"))
    if og:
        data = convert_goget(og[0])
        release["oilgas"] = os.path.basename(og[0])
        with open(os.path.join(OUT_DIR, "gem-oilgas-fields.json"), "w", encoding="utf-8") as f:
            json.dump({"source": os.path.basename(og[0]), "records": data}, f, ensure_ascii=False)
        print(f"gem-oilgas-fields.json: {len(data)} fields from {os.path.basename(og[0])}")

    if not release:
        print("No GEM tracker xlsx files found in", src)
        sys.exit(1)


if __name__ == "__main__":
    main()
