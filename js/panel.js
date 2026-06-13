// Flight detail panel: the distance comparison, recorded-track selector,
// live status line, elevation profile, and sources.

import { feDistanceKm, gcDistanceKm } from "./projection.js";
import { tracksFor, loadTrack } from "./tracks.js";

const fmtKm = (km) => `${Math.round(km).toLocaleString("en-US")} km`;
const fmtTime = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function createPanel({ panelEl, contentEl, closeEl, map, tracksIndex, onClose, onSelectFlight }) {
  let current = null;
  let currentTrack = null;
  let liveInfo = null;

  closeEl.addEventListener("click", () => onClose?.());

  function statusBadge(f) {
    if (f.status === "historical") return `<span class="badge badge-historical">historical</span>`;
    if (f.status === "seasonal") return `<span class="badge badge-seasonal">seasonal</span>`;
    return `<span class="badge">operating</span>`;
  }

  function comparisonHtml(f) {
    const hours = f.block_time_min ? f.block_time_min / 60 : null;
    const trackFe = currentTrack ? feDistanceKm(currentTrack.lonLats, { densifyGapKm: 100 }) : null;
    const trackDurH = currentTrack
      ? (currentTrack.points[currentTrack.points.length - 1][0] - currentTrack.points[0][0]) / 3600
      : null;

    let rows = `
      <div class="row"><span class="k">Great-circle distance (globe)</span><span class="v">${fmtKm(f.gc_km)}</span></div>
      <div class="row highlight"><span class="k">Distance on this map</span><span class="v">${fmtKm(f.fe_km)}</span></div>`;
    if (hours) {
      rows += `
      <div class="row"><span class="k">Scheduled block time</span><span class="v">${fmtTime(f.block_time_min)}</span></div>
      <div class="row"><span class="k">Average speed, globe route</span><span class="v">${Math.round(f.gc_km / hours).toLocaleString("en-US")} km/h</span></div>
      <div class="row highlight"><span class="k">Speed this map would require</span><span class="v">${Math.round(f.fe_km / hours).toLocaleString("en-US")} km/h</span></div>`;
    }
    if (trackFe && trackDurH > 0.5) {
      rows += `
      <div class="row"><span class="k">Recorded track, on this map</span><span class="v">${fmtKm(trackFe)}</span></div>
      <div class="row highlight"><span class="k">Recorded track's implied speed</span><span class="v">${Math.round(trackFe / trackDurH).toLocaleString("en-US")} km/h</span></div>`;
    }
    rows += `<div class="note">Typical airliner cruise ≈ 900 km/h. "Distance on this map" measures the route on the north-polar azimuthal equidistant projection, whose scale is fixed by its own meridians (pole→equator = 10,008 km). Same flight, same clock — two maps, two distances. One of them fits the speed of a 787.</div>`;
    return `<div class="compare">${rows}</div>`;
  }

  function trackSelectorHtml(f) {
    const list = tracksFor(tracksIndex, f.id);
    if (!list.length) return "";
    const opts = list
      .map((t, i) => `<option value="${i}">${esc(t.date)}${t.complete ? "" : " (partial)"}</option>`)
      .join("");
    return `<p style="margin:8px 0 2px"><label>Recorded track: <select id="track-select">${opts}</select></label></p>
            <div id="elev-chart"></div>`;
  }

  function liveHtml() {
    if (!liveInfo) return "";
    const alt = liveInfo.alt_ft != null ? `${Math.round(liveInfo.alt_ft).toLocaleString("en-US")} ft` : "—";
    const gs = liveInfo.gs_kt != null ? `${Math.round(liveInfo.gs_kt * 1.852)} km/h` : "—";
    return `<div class="live-line">✈ airborne now${liveInfo.stale ? " (coverage gap)" : ""} — altitude ${alt}, ground speed ${gs}${liveInfo.hex ? ` · ICAO24 ${esc(liveInfo.hex)}` : ""}</div>`;
  }

  function render() {
    const f = current;
    if (!f) return;
    const callsigns = f.callsigns.length ? ` · ADS-B callsign ${f.callsigns.map(esc).join(" / ")}` : "";
    contentEl.innerHTML = `
      <h2>${esc(f.id)} ${statusBadge(f)}</h2>
      <div class="sub">${esc(f.airline)} · ${esc(f.aircraft)}${callsigns}</div>
      <div class="sub">${esc(f.route.from.city)} (${esc(f.route.from.iata)}) → ${esc(f.route.to.city)} (${esc(f.route.to.iata)})${f.pair ? ` · return: <a href="#${esc(f.pair)}" id="pair-link">${esc(f.pair)}</a>` : ""}</div>
      ${liveHtml()}
      <p class="blurb">${esc(f.blurb)}</p>
      ${comparisonHtml(f)}
      ${trackSelectorHtml(f)}
      <div class="sources"><div class="h">Sources</div>
        ${f.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`).join("")}
      </div>`;

    contentEl.querySelector("#pair-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      onSelectFlight?.(f.pair);
    });
    const sel = contentEl.querySelector("#track-select");
    if (sel) {
      sel.addEventListener("change", () => showTrack(f, +sel.value));
      if (currentTrack) drawElevation();
    }
  }

  async function showTrack(f, idx) {
    const list = tracksFor(tracksIndex, f.id);
    currentTrack = null;
    map.setTrack(null);
    if (!list.length) { render(); return; }
    try {
      currentTrack = await loadTrack(list[idx ?? 0]);
      if (current === f) {
        map.setTrack({ points: currentTrack.points });
        render();
        const sel = contentEl.querySelector("#track-select");
        if (sel) sel.value = String(idx ?? 0);
      }
    } catch (err) {
      console.warn("track load failed:", err);
      render();
    }
  }

  function drawElevation() {
    const host = contentEl.querySelector("#elev-chart");
    if (!host || !currentTrack) return;
    const pts = currentTrack.points;
    const W = 300, H = 90, m = { l: 34, r: 6, t: 6, b: 16 };
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const x = d3.scaleLinear([t0, t1], [m.l, W - m.r]);
    const maxAlt = Math.max(1000, d3.max(pts, (p) => p[3]));
    const y = d3.scaleLinear([0, maxAlt], [H - m.b, m.t]);

    const svg = d3.create("svg").attr("width", W).attr("height", H).attr("id", "elev-svg");
    const area = d3.area()
      .x((p) => x(p[0]))
      .y0(H - m.b)
      .y1((p) => y(p[3]));
    const defs = svg.append("defs");
    const grad = defs.append("linearGradient").attr("id", "altgrad").attr("x1", 0).attr("y1", 1).attr("x2", 0).attr("y2", 0);
    for (let i = 0; i <= 10; i++) {
      grad.append("stop").attr("offset", `${i * 10}%`).attr("stop-color", map.altColor((i / 10) * maxAlt));
    }
    svg.append("path").datum(pts).attr("d", area).attr("fill", "url(#altgrad)").attr("opacity", 0.85);

    // axes (minimal)
    const hours = (t1 - t0) / 3600;
    for (let h = 0; h <= hours; h += Math.max(1, Math.round(hours / 6))) {
      svg.append("text").attr("class", "axis").attr("x", x(t0 + h * 3600)).attr("y", H - 4)
        .attr("text-anchor", "middle").text(`${h}h`);
    }
    for (const a of [0, Math.round(maxAlt / 2), maxAlt]) {
      svg.append("text").attr("class", "axis").attr("x", 2).attr("y", y(a) + 3).text(`${Math.round(a / 1000)}k ft`);
    }

    const cross = svg.append("line").attr("stroke", "#fff").attr("stroke-width", 0.8).attr("opacity", 0);
    svg.on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const t = Math.max(t0, Math.min(t1, x.invert(mx)));
      cross.attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t).attr("y2", H - m.b).attr("opacity", 0.7);
      map.setProfileT(t);
    });
    svg.on("mouseleave", () => {
      cross.attr("opacity", 0);
      map.setProfileT(null);
    });

    host.replaceChildren(svg.node());
  }

  return {
    show(f) {
      current = f;
      currentTrack = null;
      liveInfo = null;
      panelEl.hidden = false;
      render();
      showTrack(f, 0);
    },
    hide() {
      current = null;
      currentTrack = null;
      panelEl.hidden = true;
      map.setTrack(null);
      map.setProfileT(null);
    },
    setLive(planes) {
      if (!current) return;
      const mine = planes.find((p) => p.flightId === current.id) || null;
      const changed = JSON.stringify(mine && [mine.alt_ft, mine.gs_kt, mine.stale]) !==
                      JSON.stringify(liveInfo && [liveInfo.alt_ft, liveInfo.gs_kt, liveInfo.stale]);
      liveInfo = mine;
      if (changed) render();
    },
    currentId: () => current?.id ?? null,
  };
}
