// Recompute gc_km / fe_km for every flight in data/flights.json using the
// exact same math the site uses (js/projection.js), and write them back.
// Run after editing routes or waypoints:  node scripts/compute-distances.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeGcKm, routeFeKm } from "../js/projection.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "data", "flights.json");
const data = JSON.parse(readFileSync(file, "utf8"));

for (const f of data.flights) {
  f.gc_km = Math.round(routeGcKm(f));
  f.fe_km = Math.round(routeFeKm(f));
  const hours = f.block_time_min ? f.block_time_min / 60 : null;
  console.log(
    f.id.padEnd(8),
    `gc ${String(f.gc_km).padStart(6)} km`,
    `fe ${String(f.fe_km).padStart(6)} km`,
    `ratio ${(f.fe_km / f.gc_km).toFixed(2)}`,
    hours ? `implied ${(f.fe_km / hours).toFixed(0)} km/h` : ""
  );
}

writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
console.log("\nwrote", file);
