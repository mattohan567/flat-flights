// Pure spherical + azimuthal-equidistant math. No DOM, no D3 — importable from
// both the browser and the Node track-recorder/maintenance scripts.
//
// All point arguments are [lon, lat] in degrees (GeoJSON order).
//
// Distance figures shown in the UI come from these functions, never from the
// screen projection, so they are independent of canvas size and zoom.

export const R_EARTH = 6371.0088; // km, IUGG mean radius

const D2R = Math.PI / 180;

function toVec([lon, lat]) {
  const l = lon * D2R, p = lat * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

function toLonLat([x, y, z]) {
  return [Math.atan2(y, x) / D2R, Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}

/** Great-circle (haversine-equivalent, vector form) distance in km. */
export function gcDistanceKm(a, b) {
  const [x1, y1, z1] = toVec(a), [x2, y2, z2] = toVec(b);
  const cx = y1 * z2 - z1 * y2, cy = z1 * x2 - x1 * z2, cz = x1 * y2 - y1 * x2;
  const cross = Math.hypot(cx, cy, cz);
  const dot = x1 * x2 + y1 * y2 + z1 * z2;
  return Math.atan2(cross, dot) * R_EARTH;
}

/** Spherical linear interpolation between a and b; t in [0,1]. */
export function slerp(a, b, t) {
  const va = toVec(a), vb = toVec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return a.slice();
  const s = Math.sin(omega);
  const ka = Math.sin((1 - t) * omega) / s, kb = Math.sin(t * omega) / s;
  return toLonLat([
    ka * va[0] + kb * vb[0],
    ka * va[1] + kb * vb[1],
    ka * va[2] + kb * vb[2],
  ]);
}

/** Points along the great circle a→b every ~stepKm, endpoints included. */
export function densifyGreatCircle(a, b, stepKm = 25) {
  const d = gcDistanceKm(a, b);
  const n = Math.max(1, Math.ceil(d / stepKm));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(slerp(a, b, i / n));
  return out;
}

/**
 * North-pole-centered azimuthal equidistant projection, in kilometres.
 *
 * The projection is distance-true along meridians: a point at latitude lat
 * sits at exactly R_EARTH * (90° − lat in radians) km from the pole. That is
 * the only scale consistent with the map's own meridian distances, and it is
 * what makes "distance on this map" a well-defined number.
 */
export function aeKm([lon, lat]) {
  const rho = R_EARTH * (Math.PI / 2 - Math.max(lat, -89.999) * D2R);
  const lam = lon * D2R;
  return [rho * Math.sin(lam), -rho * Math.cos(lam)];
}

/**
 * Length of a path measured on the flat-earth plane: sum of straight-line
 * segment lengths between aeKm-projected points.
 *
 * densifyGapKm: when consecutive input points are farther apart than this
 * (great-circle km), the gap is filled along the great circle first. Recorded
 * ADS-B tracks have long receiver-coverage gaps over remote ocean; measuring
 * a sparse chord on the AE plane would under-count the flat-map length there.
 */
export function feDistanceKm(points, { densifyGapKm = Infinity } = {}) {
  let sum = 0;
  let prevLL = points[0];
  let prev = aeKm(prevLL);
  for (let i = 1; i < points.length; i++) {
    let segment = [points[i]];
    if (gcDistanceKm(prevLL, points[i]) > densifyGapKm) {
      segment = densifyGreatCircle(prevLL, points[i], densifyGapKm / 4).slice(1);
    }
    for (const ll of segment) {
      const p = aeKm(ll);
      sum += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      prev = p;
      prevLL = ll;
    }
  }
  return sum;
}

/** Ordered [lon,lat] leg endpoints for a flight: from, waypoints…, to. */
export function routeLegPoints(flight) {
  const pts = [[flight.route.from.lon, flight.route.from.lat]];
  for (const wp of flight.waypoints || []) pts.push(wp);
  pts.push([flight.route.to.lon, flight.route.to.lat]);
  return pts;
}

/** Densified [lon,lat] polyline for the whole route (all legs). */
export function routePoints(flight, stepKm = 25) {
  const legs = routeLegPoints(flight);
  const out = [legs[0]];
  for (let i = 1; i < legs.length; i++) {
    out.push(...densifyGreatCircle(legs[i - 1], legs[i], stepKm).slice(1));
  }
  return out;
}

/** Great-circle length of the route in km (sum over legs). */
export function routeGcKm(flight) {
  const legs = routeLegPoints(flight);
  let sum = 0;
  for (let i = 1; i < legs.length; i++) sum += gcDistanceKm(legs[i - 1], legs[i]);
  return sum;
}

/** Flat-earth-map length of the route in km. */
export function routeFeKm(flight) {
  return feDistanceKm(routePoints(flight));
}

/** Position bearingDeg° / distKm from a point, along the great circle. */
export function destinationPoint([lon, lat], bearingDeg, distKm) {
  const delta = distKm / R_EARTH;
  const theta = bearingDeg * D2R;
  const p1 = lat * D2R, l1 = lon * D2R;
  const sinP2 = Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(theta);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const l2 = l1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(p1),
    Math.cos(delta) - Math.sin(p1) * sinP2
  );
  return [((l2 / D2R + 540) % 360) - 180, p2 / D2R];
}
