"""Convert an IHFC Global Heat Flow Database release into the compact bundle data/ ships.

Usage:  python scripts/convert-ihfc.py <GHFDB release .zip or its .txt>

Download the release from GFZ Data Services (CC BY 4.0), e.g. Release 2024, v.2026.03:
  https://doi.org/10.5880/fidgeo.2024.014
  https://datapub.gfz.de/download/10.5880.FIDGEO.2024.014-VEueRf/GHFBD-R2024_v.2026-03.zip

Writes data/ihfc-heatflow.json.gz: { source, release, license, attribution, citation, url,
fields, rows } with one row per heat-flow measurement (the database's "child" records;
the site-level "parent" heat flow is repeated on each). Standard library only.
"""

import gzip
import json
import os
import re
import sys
import zipfile

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ihfc-heatflow.json.gz")

LICENSE = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)"
ATTRIBUTION = "Global Heat Flow Data Assessment Group et al. - IHFC Global Heat Flow Database"
URL = "https://doi.org/10.5880/fidgeo.2024.014"

# Bundle columns, in row order.
FIELDS = [
    "id", "siteId", "name", "latitude", "longitude", "elevation", "environment",
    "heatFlow", "heatFlowUncertainty", "measuredHeatFlow", "depthMD", "depthTVD",
    "method", "purpose", "gradient", "conductivity", "year", "quality", "reference",
]


def read_release(path):
    """Text of the release's tab-separated .txt (latin-1), from the zip or the .txt itself."""
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.lower().endswith(".txt"))
            return name, z.read(name).decode("latin-1")
    with open(path, "rb") as f:
        return os.path.basename(path), f.read().decode("latin-1")


def num(v):
    v = (v or "").strip()
    if not v:
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return int(n) if n.is_integer() else round(n, 4)


def nonzero(v):
    """Heat flow / gradient: an exact 0 marks 'not reported' in the release (negative values are real)."""
    n = num(v)
    return None if n == 0 else n


def positive(v):
    """Depths: only positive values are meaningful."""
    n = num(v)
    return n if n is not None and n > 0 else None


def label(v):
    """'[onshore (continental)]' / '"[Groundwater];[Mining]"' -> 'onshore (continental)' / 'groundwater; mining'."""
    parts = re.findall(r"\[([^\]]+)\]", v or "")
    return "; ".join(p.strip().lower() for p in parts) or None


def text(v):
    v = (v or "").strip()
    return None if v in ("", "?", "-") else v


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source, raw = read_release(sys.argv[1])
    lines = raw.split("\n")  # not splitlines(): some fields contain stray line-separator characters
    citation = next((l[len("# Citation:"):].strip() for l in lines if l.startswith("# Citation:")), None)
    header_at = next(i for i, l in enumerate(lines) if l.startswith("q\tq_uncertainty\t"))
    header = lines[header_at].rstrip("\r").split("\t")
    col = {name: i for i, name in enumerate(header)}

    rows, skipped = [], 0
    for line in lines[header_at + 1:]:
        if not line.strip():
            continue
        r = line.rstrip("\r").split("\t")
        if len(r) != len(header):
            skipped += 1
            continue
        g = lambda name: r[col[name]]
        lat, lon = num(g("lat_NS")), num(g("long_EW"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            skipped += 1
            continue
        gradient = nonzero(g("T_grad_mean_cor"))
        if gradient is None:
            gradient = nonzero(g("T_grad_mean"))
        rows.append([
            g("ID"), g("ID_parent"), text(g("name")), round(lat, 5), round(lon, 5), num(g("elevation")),
            label(g("environment")), nonzero(g("q")), num(g("q_uncertainty")), nonzero(g("qc")),
            positive(g("total_depth_MD")), positive(g("total_depth_TVD")), label(g("explo_method")),
            label(g("explo_purpose")), gradient, num(g("tc_mean")), num(g("Year")),
            text(g("Quality_Code_Child")), text(g("publication_reference")),
        ])

    release = re.search(r"v\.?\s?(\d{4}\.\d{2})", source)
    bundle = {
        "source": source,
        "release": f"Release 2024, v.{release.group(1)}" if release else None,
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "citation": citation,
        "url": URL,
        "fields": FIELDS,
        "rows": rows,
    }
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(payload)
    print(f"{len(rows)} measurements -> {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB gzipped, "
          f"{len(payload) / 1e6:.1f} MB raw); skipped {skipped} malformed or unlocated rows")


if __name__ == "__main__":
    main()
