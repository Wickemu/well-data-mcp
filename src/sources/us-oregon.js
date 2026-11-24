// Oregon's permit lists. DOGAMI's Mineral Land Regulation and Reclamation program has no
// well map service; it publishes every oil & gas and geothermal permit as two small
// spreadsheets (old binary .xls, same 16 columns) linked from its report pages. The file
// name carries its date, so the link is read from the page on each refresh.
// Verified 2026-11-12 against OG_Permits_20260126.xls (741 rows) and Geo_Permits_20260126.xls (456 rows).

import { fetchText, fetchBuffer } from "../http.js";
import { readXlsSheet, xlsObjects, excelDate } from "../xls.js";
import { joinName, num } from "./normalize.js";

const SITE = "https://www.oregon.gov";
const OREGON = [-124.7, 41.9, -116.4, 46.3];
const inOregon = (lat, lon) => lon > OREGON[0] && lat > OREGON[1] && lon < OREGON[2] && lat < OREGON[3];

// Oregon's public land survey: Willamette baseline and meridian, six-mile townships.
const BASELINE = 45.5197;
const MERIDIAN = -122.7417;
const TOWNSHIP_KM = 6 * 1.609344;
const steps = (text, plus, minus) => {
  const m = new RegExp(`^(\\d+)\\s*([${plus}${minus}])$`, "i").exec(String(text ?? "").trim());
  return m ? (m[2].toUpperCase() === plus ? 1 : -1) * (Number(m[1]) - 0.5) : null;
};

/** How many townships / ranges a position lies from the middle of the township and range a row names (null if it names none). */
function townshipsOff(lat, lon, row) {
  const [t, r] = [steps(row.Township, "N", "S"), steps(row.Range, "E", "W")];
  if (t == null || r == null) return null;
  const midLat = BASELINE + (t * TOWNSHIP_KM) / 111.2;
  const kmPerDegLon = 111.32 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(Math.abs(lat - midLat) / (TOWNSHIP_KM / 111.2), Math.abs(lon - (MERIDIAN + (r * TOWNSHIP_KM) / kmPerDegLon)) / (TOWNSHIP_KM / kmPerDegLon));
}

/** 42.5712 read as 42 deg 57 min 12 sec (or, when the "seconds" exceed 60, as degrees and decimal minutes). */
function unpackDms(v) {
  const a = Math.abs(v);
  const deg = Math.floor(a);
  const minutes = (a - deg) * 100;
  const whole = Math.floor(minutes + 1e-9);
  const seconds = (minutes - whole) * 100;
  if (whole >= 60) return null;
  return Math.sign(v) * (seconds < 60 ? deg + whole / 60 + seconds / 3600 : deg + minutes / 60);
}

/**
 * A row's position, or null. A handful of rows hold state-plane feet instead of degrees
 * (dropped), and a few 2010 rows give degrees-minutes-seconds packed into a
 * decimal, 30 km out: a position more than two townships from the township and range the
 * row names is re-read that way and kept when that puts it where the row says it is.
 */
function position(row) {
  let [lat, lon] = [row.Latitude, row.Longitude];
  if (typeof lat !== "number" || typeof lon !== "number" || !inOregon(lat, lon)) return null;
  let note = null;
  const off = townshipsOff(lat, lon, row);
  if (off != null && off > 2) {
    const [la, lo] = [unpackDms(lat), unpackDms(lon)];
    if (la != null && lo != null && townshipsOff(la, lo, row) <= 1.5) {
      [lat, lon] = [la, lo].map((v) => Math.round(v * 1e6) / 1e6);
      note = "The list gives this position as degrees-minutes-seconds packed into a decimal; converted to decimal degrees.";
    }
  }
  return { x: lon, y: lat, note };
}

/**
 * Permit rows -> snapshot records, one per permit. A renewal repeats the permit with a
 * later application date: the latest row is kept, with the first application date.
 * WellName and SiteName are filled unevenly (either may hold the well's name; with both,
 * the site is the field or project), so `Name` joins them for searching.
 */
export function permitRecords(rows, file) {
  const byPermit = new Map();
  for (const r of rows) {
    if (!r.PermitID) continue;
    const applied = excelDate(r.ApplicationDate);
    const prev = byPermit.get(r.PermitID);
    const first = [prev?.FirstApplicationDate, applied].filter(Boolean).sort()[0] ?? null;
    const keep = !prev || (applied ?? "") >= (prev.ApplicationDate ?? "") ? { ...r, ApplicationDate: applied } : prev;
    byPermit.set(r.PermitID, { ...keep, FirstApplicationDate: first });
  }
  return [...byPermit.values()].map((r) => {
    const at = position(r);
    return {
      attrs: { ...r, Name: joinName(r.SiteName, r.WellName), SourceFile: file, ...(at?.note ? { PositionNote: at.note } : {}) },
      geometry: at ? { x: at.x, y: at.y } : null,
    };
  });
}

async function loadPermits(page, filePattern) {
  const html = await fetchText(`${SITE}${page}`, { timeoutMs: 60_000 });
  const href = filePattern.exec(html)?.[0];
  if (!href) throw new Error(`DOGAMI's page ${page} no longer links its permit spreadsheet`);
  const rows = xlsObjects(readXlsSheet(await fetchBuffer(new URL(href, SITE).href, { timeoutMs: 60_000 })));
  if (!rows.length || !("PermitID" in rows[0])) throw new Error("DOGAMI's permit spreadsheet has a new layout");
  return permitRecords(rows, href.split("/").pop());
}

const legal = (a) => (a.Township && a.Range ? joinName(`T${a.Township}`, `R${a.Range}`, a.Section ? `S${a.Section}` : null, a.QrtSection) : null);

function permitSource({ key, label, page, filePattern, probe, caveat }) {
  return {
    key,
    country: "US",
    state: "OR",
    kind: "snapshot",
    via: "Spreadsheet download",
    label,
    probe,
    agency: "Oregon DOGAMI, Mineral Land Regulation and Reclamation program (permit list)",
    url: `${SITE}${page}`,
    load: () => loadPermits(page, filePattern),
    ttlMs: 7 * 24 * 3600_000, // DOGAMI reissues the list a few times a year
    pageMax: 1000,
    idKind: "us-api",
    extent: OREGON,
    caveat,
    searchFields: { api: "PermitID", well_name: "Name", operator: "Permittee", county: "County", field: "SiteName", status: "Status", well_type: "WellType" },
    normalize: (a, g) => ({
      api: a.PermitID,
      wellName: a.WellName || a.SiteName,
      operator: a.Permittee,
      status: a.Status,
      wellType: a.WellType,
      permitType: a.PermitType,
      field: a.WellName && a.SiteName ? a.SiteName : null,
      county: a.County,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      ...(a.PositionNote ? { positionNote: a.PositionNote } : {}),
      spudDate: null, // the list has application dates only
      applicationDate: a.FirstApplicationDate,
      ...(a.ApplicationDate && a.ApplicationDate !== a.FirstApplicationDate ? { renewalDate: a.ApplicationDate } : {}),
      depthFt: num(a.Depth, { zeroIsNull: true }),
      legalLocation: legal(a),
      sourceFile: a.SourceFile,
    }),
  };
}

const SHARED_CAVEAT =
  "A permit list, not a well file: application dates but no spud or completion dates, one depth column (feet), and status as DOGAMI records it ('Unknown' for most older permits). The permit number is the API number; a '-01' suffix is a redrill. Positions are missing for some rows; legalLocation gives township, range and section for all of them.";

export const OREGON_SOURCES = [
  permitSource({
    key: "OR-OG",
    label: "Oregon oil & gas well permits (Mist gas field and storage, exploration statewide)",
    page: "/dogami/mlrr/Pages/oilgas-report.aspx",
    filePattern: /\/dogami\/mlrr\/spreadsheets\/OG_Permits_\d{8}\.xls/i,
    probe: { well_name: "Gustafson" },
    caveat: `Every oil & gas permit DOGAMI has issued, 1949 to date (about 720). ${SHARED_CAVEAT} Mist wells are named by location code plus a nickname ('JH 22-27-64 Gustafson'); search the nickname.`,
  }),
  permitSource({
    key: "OR-GEO-PERMITS",
    label: "Oregon geothermal well and prospect-well permits, 1979 to date (Newberry, Neal Hot Springs, Glass Buttes...)",
    page: "/dogami/mlrr/Pages/geothermal-report.aspx",
    filePattern: /\/dogami\/mlrr\/spreadsheets\/Geo_Permits_\d{8}\.xls/i,
    probe: { well_name: "NHS-14" },
    caveat: `Every geothermal permit DOGAMI has issued (about 300), including the wells drilled since OR-GEO's 2013 compilation. Prospect-well permits carry 'P' numbers rather than API numbers. ${SHARED_CAVEAT} The field filter searches the site or project name ('Neal Hot Springs', 'Newberry').`,
  }),
];
