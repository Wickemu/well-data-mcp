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
