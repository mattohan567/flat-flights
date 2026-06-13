// Live-position poller against airplanes.live.
//
// The API is free and keyless with a 1 request/second limit; every visitor
// polls from their own browser/IP. One setTimeout-chained loop spaces calls
// at POLL_GAP_MS, cycles the operating callsigns, and prioritizes aircraft
// recently seen airborne. Please keep the attribution link in the footer.

const API = "https://api.airplanes.live/v2/callsign/";
const POLL_GAP_MS = 1500;        // conservative margin under 1 req/s
const IDLE_SKIP = 4;             // idle callsigns polled every Nth pass
const ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
const MISSES_BEFORE_IDLE = 3;
const TRAIL_MAX = 100;

export function createPoller({ flights, onUpdate, onStatus }) {
  // one entry per pollable callsign
  const entries = [];
  for (const f of flights) {
    if (f.status !== "operating" && f.status !== "seasonal") continue;
    for (const cs of f.callsigns) {
      entries.push({
        callsign: cs,
        flightId: f.id,
        phase: "idle",
        misses: 0,
        skip: 0,
        lastSeen: 0,
        ac: null,
        trail: [],
      });
    }
  }

  let cursor = 0;
  let timer = null;
  let stopped = true;
  let errorCount = 0;

  function nextEntry() {
    // any active entry is always due; idle ones take their turn every IDLE_SKIP passes
    for (let i = 0; i < entries.length; i++) {
      const e = entries[(cursor + i) % entries.length];
      if (e.phase === "active") {
        cursor = (cursor + i + 1) % entries.length;
        return e;
      }
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[(cursor + i) % entries.length];
      if (e.skip <= 0) {
        e.skip = IDLE_SKIP;
        cursor = (cursor + i + 1) % entries.length;
        return e;
      }
      e.skip--;
    }
    return entries[cursor++ % entries.length];
  }

  async function poll(entry) {
    const res = await fetch(API + encodeURIComponent(entry.callsign));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ac = (data.ac || []).find(
      (a) => (a.flight || "").trim() === entry.callsign && a.lat != null && a.lon != null
    );
    const now = Date.now();
    if (ac) {
      entry.misses = 0;
      entry.phase = "active";
      entry.lastSeen = now;
      const altFt = ac.alt_baro === "ground" ? 0 : (ac.alt_baro ?? ac.alt_geom ?? null);
      entry.ac = {
        flightId: entry.flightId,
        callsign: entry.callsign,
        hex: ac.hex,
        lon: ac.lon,
        lat: ac.lat,
        alt_ft: altFt,
        gs_kt: ac.gs ?? null,
        track: ac.track ?? null,
        fixTime: now,
        stale: false,
      };
      const last = entry.trail[entry.trail.length - 1];
      if (!last || last[0] !== ac.lon || last[1] !== ac.lat) {
        entry.trail.push([ac.lon, ac.lat]);
        if (entry.trail.length > TRAIL_MAX) entry.trail.shift();
      }
    } else if (entry.phase === "active") {
      // coverage gaps over remote ocean are normal: keep the last fix on the
      // map (flagged) for a while before demoting to idle
      entry.misses++;
      if (entry.ac) entry.ac.stale = true;
      if (entry.misses >= MISSES_BEFORE_IDLE && now - entry.lastSeen > ACTIVE_TIMEOUT_MS) {
        entry.phase = "idle";
        entry.ac = null;
        entry.trail = [];
      }
    }
  }

  function planes() {
    return entries
      .filter((e) => e.ac)
      .map((e) => ({ ...e.ac, trail: e.trail }));
  }

  async function tick() {
    if (stopped || document.hidden) return;
    const entry = nextEntry();
    if (entry) {
      try {
        await poll(entry);
        errorCount = 0;
        const airborne = entries.filter((e) => e.phase === "active").length;
        onStatus?.({ state: "live", airborne, total: entries.length });
        onUpdate?.(planes());
      } catch (err) {
        errorCount++;
        const backoff = Math.min(5000 * 2 ** errorCount, 5 * 60 * 1000);
        onStatus?.({ state: "error", message: String(err.message || err), retryMs: backoff });
        timer = setTimeout(tick, backoff);
        return;
      }
    }
    timer = setTimeout(tick, POLL_GAP_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(timer);
      onStatus?.({ state: "paused" });
    } else if (!stopped) {
      tick();
    }
  });

  return {
    start() {
      if (!entries.length) {
        onStatus?.({ state: "off" });
        return;
      }
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    planes,
  };
}
