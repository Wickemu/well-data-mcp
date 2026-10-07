// Provider registry. Every source names its protocol in `kind` (default "arcgis").
// A provider implements:
//   search(source, filters, { limit, offset, near })  -> { rows, moreAvailable, unsupported }
//   count(source, filters, { near })                   -> { count, approximate?, unsupported }
//   findById(source, id)                               -> rows
//   distinct(source, fieldKey, text, limit?)           -> values   (optional; list_operators)
//   raw(source, { where, outFields, limit, offset })   -> { rows, moreAvailable }   (optional; raw_query)
//   canRaw(source)                                     -> whether raw() works for this source
// rows are { attrs, geometry: { x: lon, y: lat } | null }; near is { latitude, longitude, radiusKm }.
// A provider may return extra rows around a radius search (bbox only); the caller trims to the circle.

import { arcgisProvider } from "./arcgis.js";
import { wfsProvider } from "./wfs.js";
import { rrcEwaProvider } from "./rrc-ewa.js";

const PROVIDERS = {
  arcgis: arcgisProvider,
  wfs: wfsProvider,
  "rrc-ewa": rrcEwaProvider,
};

export function providerFor(source) {
  const p = PROVIDERS[source.kind ?? "arcgis"];
  if (!p) throw new Error(`No provider for kind '${source.kind}' (source ${source.key})`);
  return p;
}
