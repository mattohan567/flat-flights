// Track recorder, run by .github/workflows/record-tracks.yml (or locally).
//
// For every operating/seasonal flight in data/flights.json:
//   1. resolve its ICAO callsign to the airframe hex codes currently flying it
//      (airplanes.live, keyless, 1 req/s) and remember hexes for 72 h
//   2. fetch today's tar1090 trace for each hex from adsb.lol (keyless, ODbL)
//   3. cut out the airborne segment that matches the callsign, downsample it,
//      and merge it into data/tracks/{id}/{utc-date}.json (idempotent — the
//      three daily runs converge on one complete file per departure)
//   4. prune to the best 5 tracks per flight and regenerate the index
//
// Zero npm dependencies: Node ≥ 20 built-in fetch + node:zlib.
// Every per-flight step is caught and logged; the script always exits 0 so
// one bad trace never blocks the rest.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, rmdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gcDistanceKm } from "../js/projection.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKS_DIR = join(ROOT, "data", "tracks");
const HEXES_FILE = join(TRACKS_DIR, "hexes-seen.json");
const INDEX_FILE = join(TRACKS_DIR, "index.json");

const POLL_GAP_MS = 1500;
const HEX_TTL_MS = 72 * 3600 * 1000;
const MAX_POINTS = 1500;
const KEEP_TRACKS = 5;
const COMPLETE_RADIUS_KM = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, retries = 2) {
  const res = await fetch(url, { headers: { "User-Agent": "flat-flights-recorder (github)" } });
  if (res.status === 404) return null;
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    await sleep(15000);
    return fetchJson(url, retries - 1);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // tar1090 deployments sometimes serve pre-gzipped JSON without a
  // Content-Encoding header — sniff the gzip magic bytes
  const body = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(body.toString("utf8"));
}

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

// ---------- step 1: callsign → hex ----------

async function resolveHexes(flights, hexesSeen) {
  const now = Date.now();
  for (const f of flights) {
    for (const cs of f.callsigns) {
      try {
        const data = await fetchJson(`https://api.airplanes.live/v2/callsign/${encodeURIComponent(cs)}`);
        for (const ac of data?.ac || []) {
          if ((ac.flight || "").trim() !== cs || !ac.hex) continue;
          const list = (hexesSeen[cs] ||= []);
          const existing = list.find((e) => e.hex === ac.hex);
          if (existing) existing.last_seen = now;
          else list.push({ hex: ac.hex, last_seen: now });
          console.log(`  ${cs}: airborne as ${ac.hex}`);
        }
      } catch (err) {
        console.warn(`  ${cs}: lookup failed — ${err.message}`);
      }
      await sleep(POLL_GAP_MS);
    }
  }
  // expire stale hexes
  for (const cs of Object.keys(hexesSeen)) {
    hexesSeen[cs] = hexesSeen[cs].filter((e) => now - e.last_seen < HEX_TTL_MS);
    if (!hexesSeen[cs].length) delete hexesSeen[cs];
  }
}

// ---------- step 2+3: trace → segment → file ----------

function airborneSegments(trace) {
  // trace entries: [sec_offset, lat, lon, alt_baro|"ground", gs, track, flags,
  //                 vrate, aircraft?|null, source, alt_geom, ...]
  const segs = [];
  let cur = null;
  let prevT = null;
  for (const e of trace.trace || []) {
    const [t, lat, lon, alt] = e;
    const grounded = alt === "ground";
    const gap = prevT != null && t - prevT > 30 * 60;
    if (grounded || gap) {
      if (cur?.length > 1) segs.push(cur);
      cur = grounded ? null : [];
    }
    if (!grounded && lat != null && lon != null) (cur ||= []).push(e);
    prevT = t;
  }
  if (cur?.length > 1) segs.push(cur);
  return segs;
}

function segmentCallsign(seg) {
  for (const e of seg) {
    const flight = e[8]?.flight;
    if (flight) return flight.trim();
  }
  return null;
}

function downsample(points) {
  let dtMin = 60;
  let out = points;
  do {
    out = [];
    let lastT = -Infinity, lastAlt = null, lastTrk = null;
    for (let i = 0; i < points.length; i++) {
      const [t, , , alt, , trk] = points[i];
      const keep =
        i === 0 ||
        i === points.length - 1 ||
        t - lastT >= dtMin ||
        (lastAlt != null && alt != null && Math.abs(alt - lastAlt) >= 500) ||
        (lastTrk != null && trk != null && Math.abs(((trk - lastTrk + 540) % 360) - 180) >= 5);
      if (keep) {
        out.push(points[i]);
        lastT = t; lastAlt = alt; lastTrk = trk;
      }
    }
    dtMin *= 2;
  } while (out.length > MAX_POINTS);
  return out;
}

function toCompact(seg, day0) {
  // [abs_s, lat, lon, alt_ft] with lat/lon at 4 dp, alt int ("ground" → 0)
  return seg.map((e) => [
    Math.round(day0 + e[0]),
    +e[1].toFixed(4),
    +e[2].toFixed(4),
    e[3] === "ground" || e[3] == null ? 0 : Math.round(e[3]),
  ]);
}

function isComplete(points, flight) {
  const first = points[0], last = points[points.length - 1];
  const near = (p, apt) => gcDistanceKm([p[2], p[1]], [apt.lon, apt.lat]) < COMPLETE_RADIUS_KM;
  return near(first, flight.route.from) && near(last, flight.route.to);
}

function mergeWrite(flight, callsign, hex, absPoints) {
  const date = new Date(absPoints[0][0] * 1000).toISOString().slice(0, 10);
  const dir = join(TRACKS_DIR, flight.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.json`);

  let merged = absPoints;
  const existing = loadJson(file, null);
  if (existing) {
    const seen = new Set();
    merged = [...existing.points.map((p) => [p[0] + existing.t0, p[1], p[2], p[3]]), ...absPoints]
      .filter((p) => (seen.has(p[0]) ? false : seen.add(p[0])))
      .sort((a, b) => a[0] - b[0]);
  }
  merged = downsample(merged.map((p) => [p[0], p[1], p[2], p[3], null, null]))
    .map((p) => p.slice(0, 4));

  const t0 = merged[0][0];
  const out = {
    v: 1,
    flight: flight.id,
    callsign,
    icao24: hex,
    date,
    t0,
    source: "adsb.lol",
    points: merged.map((p) => [p[0] - t0, p[1], p[2], p[3]]),
  };
  writeFileSync(file, JSON.stringify(out) + "\n");
  console.log(`  ${flight.id}: wrote ${date}.json (${out.points.length} pts${isComplete(merged, flight) ? ", complete" : ""})`);
}

// ---------- step 4: prune + index ----------

function rebuildIndex(flightsById) {
  const index = { v: 1, updated: new Date().toISOString(), tracks: {} };
  for (const id of readdirSync(TRACKS_DIR)) {
    const dir = join(TRACKS_DIR, id);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    const flight = flightsById.get(id);
    const entries = [];
    for (const fname of files) {
      const t = loadJson(join(dir, fname), null);
      if (!t?.points?.length) continue;
      const abs = t.points.map((p) => [p[0] + t.t0, p[1], p[2], p[3]]);
      entries.push({
        date: t.date,
        file: `data/tracks/${id}/${fname}`,
        icao24: t.icao24,
        points: t.points.length,
        duration_s: t.points[t.points.length - 1][0] - t.points[0][0],
        complete: flight ? isComplete(abs, flight) : false,
      });
    }
    entries.sort(
      (a, b) =>
        (b.complete === true) - (a.complete === true) ||
        b.duration_s - a.duration_s ||
        b.date.localeCompare(a.date)
    );
    for (const drop of entries.slice(KEEP_TRACKS)) {
      unlinkSync(join(ROOT, drop.file));
      console.log(`  pruned ${drop.file}`);
    }
    const kept = entries.slice(0, KEEP_TRACKS).sort((a, b) => b.date.localeCompare(a.date));
    if (kept.length) index.tracks[id] = kept;
    else if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
  }
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");
}

// ---------- main ----------

const flightsData = loadJson(join(ROOT, "data", "flights.json"), { flights: [] });
const flights = flightsData.flights
  .filter((f) => f.status === "operating" || f.status === "seasonal")
  .map((f) => ({
    ...f,
    callsigns: f.icao_callsign ? (Array.isArray(f.icao_callsign) ? f.icao_callsign : [f.icao_callsign]) : [],
  }))
  .filter((f) => f.callsigns.length);
const flightsById = new Map(flightsData.flights.map((f) => [f.id, f]));
const byCallsign = new Map(flights.flatMap((f) => f.callsigns.map((cs) => [cs, f])));
const hexesSeen = loadJson(HEXES_FILE, {});

console.log(`resolving ${flights.length} flights' callsigns…`);
await resolveHexes(flights, hexesSeen);
writeFileSync(HEXES_FILE, JSON.stringify(hexesSeen, null, 2) + "\n");

console.log("fetching traces…");
const summary = [];
for (const [cs, seen] of Object.entries(hexesSeen)) {
  const flight = byCallsign.get(cs);
  if (!flight) continue;
  for (const { hex } of seen) {
    try {
      const trace = await fetchJson(
        `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`
      );
      await sleep(POLL_GAP_MS);
      if (!trace) { summary.push([cs, hex, "no trace today"]); continue; }
      const day0 = trace.timestamp;
      const segs = airborneSegments(trace);
      const match =
        segs.find((s) => segmentCallsign(s) === cs) ||
        // fall back to the segment containing the moment we saw it live
        segs.find((s) => {
          const t = (seen.find((e) => e.hex === hex)?.last_seen ?? 0) / 1000 - day0;
          return s[0][0] <= t && t <= s[s.length - 1][0];
        });
      if (!match) { summary.push([cs, hex, `no matching segment (${segs.length} segs)`]); continue; }
      mergeWrite(flight, cs, hex, toCompact(downsample(match), day0));
      summary.push([cs, hex, "ok"]);
    } catch (err) {
      summary.push([cs, hex, `error: ${err.message}`]);
    }
  }
}

console.log("rebuilding index…");
rebuildIndex(flightsById);

console.log("\nsummary:");
for (const [cs, hex, msg] of summary) console.log(`  ${cs} ${hex}: ${msg}`);
console.log("done");
process.exit(0);
