// Hungarian national grid EOV (EPSG:23700: HD72 datum on the GRS67 ellipsoid, oblique
// Mercator 'somerc') to WGS84, for layers that give only EOV coordinates (HUGEO's thermal
// well cadastre withholds its geometry). Accurate to about a metre: the HD72 -> WGS84 step
// is a 3-parameter geocentric shift.
// easting = EOV Y (~400 000-950 000 m), northing = EOV X (~30 000-370 000 m).
const A = 6378160, F = 1 / 298.247167427; // GRS67
const ES = F * (2 - F), E = Math.sqrt(ES), HLF_E = E / 2, RONE_ES = 1 / (1 - ES);
const PHI0 = (47.14439372222222 * Math.PI) / 180, LON0 = (19.04857177777778 * Math.PI) / 180;
const K0 = 0.99993, X0 = 650000, Y0 = 200000, FORTPI = Math.PI / 4;
const cp0 = Math.cos(PHI0) ** 2;
const C = Math.sqrt(1 + ES * cp0 * cp0 * RONE_ES);
const SINP0 = Math.sin(PHI0) / C;
const PHIP0 = Math.asin(SINP0);
const COSP0 = Math.cos(PHIP0);
const SP = Math.sin(PHI0) * E;
const K = Math.log(Math.tan(FORTPI + 0.5 * PHIP0)) - C * (Math.log(Math.tan(FORTPI + 0.5 * PHI0)) - HLF_E * Math.log((1 + SP) / (1 - SP)));
const KR = (K0 * Math.sqrt(1 - ES)) / (1 - SP * SP);
const asin1 = (v) => Math.asin(Math.max(-1, Math.min(1, v)));

function eovToHd72(easting, northing) {
  const x = (easting - X0) / A, y = (northing - Y0) / A;
  const phipp = 2 * (Math.atan(Math.exp(y / KR)) - FORTPI);
  const lampp = x / KR;
  const cp = Math.cos(phipp);
  const phip = asin1(COSP0 * Math.sin(phipp) + SINP0 * cp * Math.cos(lampp));
  const lamp = asin1((cp * Math.sin(lampp)) / Math.cos(phip));
  const con = (K - Math.log(Math.tan(FORTPI + 0.5 * phip))) / C;
  let phi = phip;
  for (let i = 0; i < 12; i++) {
    const esp = E * Math.sin(phi);
    const delp = (con + Math.log(Math.tan(FORTPI + 0.5 * phi)) - HLF_E * Math.log((1 + esp) / (1 - esp))) * (1 - esp * esp) * Math.cos(phi) * RONE_ES;
    phi -= delp;
    if (Math.abs(delp) < 1e-12) break;
  }
  return { phi, lam: lamp / C + LON0 };
}

// HD72 -> WGS84: geocentric 3-parameter shift (EPSG:1242-style, ~1 m)
const DX = 52.17, DY = -71.82, DZ = -14.9;
const WA = 6378137, WF = 1 / 298.257223563, WES = WF * (2 - WF);
function shift(phi, lam) {
  const N = A / Math.sqrt(1 - ES * Math.sin(phi) ** 2);
  const X = N * Math.cos(phi) * Math.cos(lam) + DX;
  const Y = N * Math.cos(phi) * Math.sin(lam) + DY;
  const Z = N * (1 - ES) * Math.sin(phi) + DZ;
  const p = Math.hypot(X, Y);
  let lat = Math.atan2(Z, p * (1 - WES));
  for (let i = 0; i < 8; i++) {
    const Nw = WA / Math.sqrt(1 - WES * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - Nw;
    lat = Math.atan2(Z, p * (1 - (WES * Nw) / (Nw + h)));
  }
  return { latitude: (lat * 180) / Math.PI, longitude: (Math.atan2(Y, X) * 180) / Math.PI };
}

/** EOV easting (Y) and northing (X) in metres -> { latitude, longitude } in WGS84, or nulls. */
export function eovToWgs84(easting, northing) {
  const e = Number(easting), n = Number(northing);
  if (!Number.isFinite(e) || !Number.isFinite(n) || e < 380000 || e > 960000 || n < 20000 || n > 380000) return { latitude: null, longitude: null };
  const { phi, lam } = eovToHd72(e, n);
  const r = shift(phi, lam);
  return { latitude: Math.round(r.latitude * 1e6) / 1e6, longitude: Math.round(r.longitude * 1e6) / 1e6 };
}
