// Small WGS84 helpers shared by the providers, the GEM lookup and source routing.

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Bounding box [minLon, minLat, maxLon, maxLat] around a point and radius (meters). */
export function radiusToBbox(latitude, longitude, radiusMeters) {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  return [longitude - dLon, latitude - dLat, longitude + dLon, latitude + dLat];
}

function boxesIntersect(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Does a source's coverage extent intersect a search box? `extent` is one
 * [minLon, minLat, maxLon, maxLat] box or a list of them (France + overseas
 * departments, say). A source with no extent is assumed to cover everything.
 */
export function extentIntersects(extent, box) {
  if (!extent) return true;
  const boxes = Array.isArray(extent[0]) ? extent : [extent];
  return boxes.some((e) => boxesIntersect(e, box));
}

/** Keep only rows within radiusKm of a point; rows need numeric latitude/longitude. */
export function withinRadius(rows, { latitude, longitude, radiusKm }) {
  return rows.filter(
    (r) =>
      Number.isFinite(r.latitude) &&
      Number.isFinite(r.longitude) &&
      haversineKm(latitude, longitude, r.latitude, r.longitude) <= radiusKm
  );
}

/**
 * UTM easting/northing (metres) -> { latitude, longitude } on the GRS80/WGS84 ellipsoid
 * (NAD83 and WGS84 agree to within a metre or so). Standard series inversion (Snyder 1987).
 */
export function utmToLatLon(easting, northing, zone, southern = false) {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const y = southern ? northing - 10000000 : northing;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin1 ** 2);
  const t1 = tan1 ** 2;
  const c1 = ep2 * cos1 ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * sin1 ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) / cos1;
  return { latitude: (lat * 180) / Math.PI, longitude: (zone * 6 - 183) + (lon * 180) / Math.PI };
}
