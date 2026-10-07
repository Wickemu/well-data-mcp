// US federal offshore (Outer Continental Shelf) wells from BOEM/BSEE's ArcGIS layers.
// The layers store the operator as a 5-digit BOEM company number, so names come from
// BOEM's company file (CompanyRawData.zip, ~340 KB, refreshed daily), loaded once per
// process: operator searches match names and results show them.

import { fetchBuffer } from "../http.js";
import { unzipEntry } from "../zip.js";
import { parseCsv, csvObjects } from "../csv.js";
import { usDateToIso, msToIso, num, geomFirst } from "./normalize.js";
import { sqlQuote } from "../providers/arcgis.js";

const COMPANY_ZIP = "https://www.data.boem.gov/Company/Files/CompanyRawData.zip";
let companies = null; // Map number -> name
let loading = null;

async function loadCompanies() {
  if (companies) return companies;
  loading ??= (async () => {
    try {
      const zip = await fetchBuffer(COMPANY_ZIP, { timeoutMs: 60_000 });
      const text = unzipEntry(zip, "mv_companies_all.txt").toString("latin1");
      companies = new Map(csvObjects(parseCsv(text)).map((r) => [r.MMS_COMPANY_NUM, r.BUS_ASC_NAME?.trim()]));
      return companies;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** OPERATOR IN (...) for every BOEM company whose name contains the search words. */
async function operatorWhere(text) {
  const map = await loadCompanies();
  const words = String(text).trim().toUpperCase().split(/\s+/);
  const numbers = [...map].filter(([, name]) => name && words.every((w) => name.toUpperCase().includes(w))).map(([n]) => n);
  if (/^\d{5}$/.test(String(text).trim())) numbers.push(String(text).trim());
  return numbers.length ? `OPERATOR IN (${numbers.slice(0, 300).map(sqlQuote).join(",")})` : "1=0";
}

const companyName = (n) => (companies?.get(n) ?? null);

function ocsSource({ key, region, label, url, extent, apiStates, probe }) {
  return {
    key,
    country: "US",
    state: region,
    label,
    probe,
    agency: "BOEM / BSEE (federal offshore)",
    url,
    pageMax: 2000,
    timeoutMs: 90_000, // gis.boem.gov can take ~40 s on the Alaska layer
    idKind: "us-api",
    apiStates,
    extent,
    prepare: loadCompanies,
    operatorWhere,
    displayOperator: (n) => (companyName(n) ? `${companyName(n)} (${n})` : n),
    caveat:
      "Federal waters only (state waters are in the state sources). waterDepthFt is water depth, not well depth. The operator filter matches BOEM company names.",
    searchFields: {
      api: "API_NUMBER",
      well_name: "WELL_NAME",
      operator: "OPERATOR",
      status: "STATUS_DESCRIPTION",
      well_type: "TYPE_CODE_DESC",
    },
    normalize: (a, g) => ({
      api: a.API_NUMBER,
      wellName: a.WELL_NAME,
      operator: companyName(a.OPERATOR) ?? a.OPERATOR,
      operatorNumber: a.OPERATOR,
      status: a.STATUS_DESCRIPTION,
      wellType: a.TYPE_CODE_DESC,
      ...geomFirst(a, g), // X/Y attributes are NAD27 in the Gulf
      spudDate: typeof a.SPUD_DATE === "number" ? msToIso(a.SPUD_DATE) : usDateToIso(a.SPUD_DATE),
      completionDate: msToIso(a.COMPLETION),
      waterDepthFt: num(a.DEPTH),
    }),
  };
}

const BOEM = "https://gis.boem.gov/arcgis/rest/services/BOEM_BSEE";

export const BOEM_SOURCES = [
  ocsSource({
    key: "OCS-GOM",
    region: "OCS-GOM",
    label: "US Gulf federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/GOA_Layers/FeatureServer/1`,
    extent: [-98.0, 23.0, -81.0, 31.0],
    // Gulf OCS API numbers carry the adjacent state's prefix (17 LA, 42 TX...) or 60.
    apiStates: ["LA", "TX", "MS", "AL", "FL"],
    probe: { operator: "Shell Offshore" },
  }),
  ocsSource({
    key: "OCS-PAC",
    region: "OCS-PAC",
    label: "US Pacific federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/POC_Layers/FeatureServer/1`,
    extent: [-126.0, 31.5, -116.5, 49.0],
    apiStates: ["CA", "OR", "WA"],
    probe: { well_type: "Development" },
  }),
  ocsSource({
    key: "OCS-AK",
    region: "OCS-AK",
    label: "US Alaska federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/AK_Layers/FeatureServer/1`,
    extent: [[-180.0, 50.0, -129.0, 73.5], [165.0, 50.0, 180.0, 66.0]],
    apiStates: ["AK"],
    probe: { well_type: "Exploratory" },
  }),
  ocsSource({
    key: "OCS-ATL",
    region: "OCS-ATL",
    label: "US Atlantic federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/ATL_Layers/FeatureServer/1`,
    extent: [-82.0, 24.0, -65.0, 45.0],
    probe: { well_type: "Exploratory" },
  }),
];
