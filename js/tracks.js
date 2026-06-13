// Recorded-track access: the index is fetched once; individual track files
// lazy-load when a flight is selected. All files are static JSON on this
// origin, committed by the record-tracks GitHub Action (or by hand).

const cache = new Map();

export async function loadTracksIndex(url = "data/tracks/index.json") {
  try {
    const res = await fetch(url);
    if (!res.ok) return { tracks: {} };
    return await res.json();
  } catch {
    return { tracks: {} };
  }
}

/** Entries for a flight, best first (complete, then longest, then newest). */
export function tracksFor(index, flightId) {
  const list = (index.tracks && index.tracks[flightId]) || [];
  return [...list].sort(
    (a, b) =>
      (b.complete === true) - (a.complete === true) ||
      (b.duration_s || 0) - (a.duration_s || 0) ||
      String(b.date).localeCompare(String(a.date))
  );
}

/** Load one track file → {flight, date, t0, points:[[t,lat,lon,alt_ft]…], lonLats}. */
export async function loadTrack(entry) {
  if (cache.has(entry.file)) return cache.get(entry.file);
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
  const track = await res.json();
  track.lonLats = track.points.map(([, lat, lon]) => [lon, lat]);
  cache.set(entry.file, track);
  return track;
}
