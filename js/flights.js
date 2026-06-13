// Load and validate the curated flight dataset.

import { routeGcKm, routeFeKm } from "./projection.js";

export const CATEGORY_LABELS = {
  southern: "Southern long-hauls",
  transpolar: "Polar routes",
  antarctic: "Antarctica",
  diversion: "Diversions",
  historic: "Historic",
};

export async function loadFlights(url = "data/flights.json") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`flights.json: HTTP ${res.status}`);
  const data = await res.json();
  const flights = data.flights;

  // Keep the published numbers honest: recompute from the routes and warn on
  // drift, so a typo in flights.json can't silently misstate a distance.
  for (const f of flights) {
    const gc = routeGcKm(f);
    const fe = routeFeKm(f);
    for (const [name, stored, computed] of [["gc_km", f.gc_km, gc], ["fe_km", f.fe_km, fe]]) {
      if (Math.abs(stored - computed) / computed > 0.01) {
        console.warn(
          `${f.id}: ${name} in flights.json is ${stored} but computes to ${Math.round(computed)} — ` +
          `run scripts/compute-distances.mjs`
        );
      }
    }
    f.callsigns = f.icao_callsign
      ? (Array.isArray(f.icao_callsign) ? f.icao_callsign : [f.icao_callsign])
      : [];
  }

  const byId = new Map(flights.map((f) => [f.id, f]));
  return { flights, byId, updated: data.updated };
}
