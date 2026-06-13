// Canvas rendering of the north-pole-centered azimuthal equidistant map.
// Two canvas layers (base map / flights) plus an events div that owns d3-zoom.
// Uses the global `d3` and `topojson` UMD bundles loaded in index.html.

import { routePoints, routeLegPoints, destinationPoint } from "./projection.js";

const CAT_COLORS = {
  southern: "#ff6b6b",
  transpolar: "#4dabf7",
  antarctic: "#66d9e8",
  diversion: "#ffd43b",
  historic: "#b197fc",
};

const MAX_ALT_FT = 43000;
const DEAD_RECKON_CAP_S = 300;

// Gleason 1892 raster alignment: the scan is itself a north-polar AE drawing.
// Fractions of image width/height for the pole pixel, fraction of image width
// for the radius of the lat = -90 rim, and rotation offset in degrees
// (positive rotates the image clockwise). Tuned by eye against the graticule.
const GLEASON = { cx: 0.4988, cy: 0.5084, rimFrac: 0.4854, rotDeg: 90 };

export function createMap({ baseCanvas, flightsCanvas, eventsEl, onSelect, onHover }) {
  const baseCtx = baseCanvas.getContext("2d");
  const flightsCtx = flightsCanvas.getContext("2d");

  let width = 0, height = 0, dpr = 1;
  let projection = null;
  let geoPathBase = null, geoPathFlights = null;
  let transform = d3.zoomIdentity;

  let land = null, borders = null;
  const graticule = d3.geoGraticule10();

  let flights = [];
  let visibleIds = null;          // Set of flight ids passing the category filter
  let selectedId = null;
  let hoverId = null;
  let track = null;               // {points:[[t,lat,lon,alt]...], screen:[[x,y,alt]...]}
  let profileT = null;            // hovered elapsed-seconds in the elevation chart
  let livePlanes = [];            // [{flightId, callsign, lon, lat, alt_ft, gs_kt, track, fixTime, trail}]
  let gleasonImg = null, gleasonOn = false;

  let quadtree = null;
  let renderQueued = false;
  let baseDirty = true;

  // ---------- sizing / projection ----------

  function resize() {
    const rect = eventsEl.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = window.devicePixelRatio || 1;
    for (const c of [baseCanvas, flightsCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    const margin = 14;
    const scale = (Math.min(width, height) / 2 - margin) / Math.PI;
    projection = d3.geoAzimuthalEquidistant()
      .rotate([0, -90])
      .clipAngle(180 - 1e-3)
      .scale(scale)
      .translate([width / 2, height / 2])
      .precision(0.3);
    geoPathBase = d3.geoPath(projection, baseCtx);
    geoPathFlights = d3.geoPath(projection, flightsCtx);
    if (track) track.screen = null;
    rebuildQuadtree();
    baseDirty = true;
    requestRender();
  }

  // ---------- zoom / pointer ----------

  const zoom = d3.zoom()
    .scaleExtent([1, 40])
    .on("zoom", (e) => {
      transform = e.transform;
      baseDirty = true;
      requestRender();
    });

  d3.select(eventsEl)
    .call(zoom)
    .on("mousemove.hover", onMouseMove)
    .on("mouseleave.hover", () => setHover(null, null))
    .on("click.select", onClick);

  function screenToProj([mx, my]) {
    return [(mx - transform.x) / transform.k, (my - transform.y) / transform.k];
  }

  function findAt(event) {
    if (!quadtree) return null;
    const [mx, my] = d3.pointer(event, eventsEl);
    const [px, py] = screenToProj([mx, my]);
    return quadtree.find(px, py, 12 / transform.k) || null;
  }

  function onMouseMove(event) {
    const hit = findAt(event);
    setHover(hit ? hit.flightId : null, hit ? d3.pointer(event, eventsEl) : null);
  }

  function onClick(event) {
    const hit = findAt(event);
    if (hit) onSelect?.(hit.flightId);
  }

  function setHover(id, screenXY) {
    if (id !== hoverId) {
      hoverId = id;
      eventsEl.style.cursor = id ? "pointer" : "";
      requestRender();
    }
    onHover?.(id, screenXY);
  }

  // ---------- quadtree (projection space, untransformed screen px) ----------

  function rebuildQuadtree() {
    if (!projection) return;
    const entries = [];
    const add = (lonlat, flightId, kind) => {
      const p = projection(lonlat);
      if (p) entries.push({ x: p[0], y: p[1], flightId, kind });
    };
    for (const f of flights) {
      if (visibleIds && !visibleIds.has(f.id)) continue;
      for (const pt of f._samplePoints) add(pt, f.id, "route");
      add([f.route.from.lon, f.route.from.lat], f.id, "airport");
      add([f.route.to.lon, f.route.to.lat], f.id, "airport");
    }
    for (const p of livePlanes) add([p.lon, p.lat], p.flightId, "plane");
    quadtree = d3.quadtree(entries, (d) => d.x, (d) => d.y);
  }

  // ---------- base layer ----------

  function drawBase() {
    const ctx = baseCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    const k = transform.k;
    const [cx, cy] = projection.translate();
    const rimR = projection.scale() * Math.PI;

    // ocean disc
    ctx.beginPath();
    ctx.arc(cx, cy, rimR, 0, 2 * Math.PI);
    ctx.fillStyle = "#0e2a3f";
    ctx.fill();

    if (gleasonOn && gleasonImg) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rimR, 0, 2 * Math.PI);
      ctx.clip();
      const imgRim = gleasonImg.width * GLEASON.rimFrac;
      const s = rimR / imgRim;
      ctx.translate(cx, cy);
      ctx.rotate((GLEASON.rotDeg * Math.PI) / 180);
      ctx.scale(s, s);
      ctx.drawImage(gleasonImg, -gleasonImg.width * GLEASON.cx, -gleasonImg.height * GLEASON.cy);
      ctx.restore();
    } else if (land) {
      ctx.beginPath();
      geoPathBase(land);
      ctx.fillStyle = "#27445a";
      ctx.fill();
      if (borders) {
        ctx.beginPath();
        geoPathBase(borders);
        ctx.strokeStyle = "rgba(233, 241, 247, 0.12)";
        ctx.lineWidth = 0.6 / k;
        ctx.stroke();
      }
    }

    // graticule
    ctx.beginPath();
    geoPathBase(graticule);
    ctx.strokeStyle = "rgba(138, 163, 181, 0.18)";
    ctx.lineWidth = 0.5 / k;
    ctx.stroke();

    // the rim — Antarctica as the outer boundary
    ctx.beginPath();
    ctx.arc(cx, cy, rimR, 0, 2 * Math.PI);
    ctx.strokeStyle = "#9be8f2";
    ctx.lineWidth = 4 / k;
    ctx.shadowColor = "rgba(155, 232, 242, 0.5)";
    ctx.shadowBlur = 12 / k;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(155, 232, 242, 0.75)";
    ctx.font = `${12 / k}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText('Antarctica — the map’s outer rim (the “ice wall”)', cx, cy - rimR - 8 / k);

    // latitude ring labels down the 0° meridian
    ctx.fillStyle = "rgba(138, 163, 181, 0.5)";
    ctx.font = `${9 / k}px sans-serif`;
    for (const lat of [60, 30, 0, -30, -60]) {
      const p = projection([0, lat]);
      if (p) ctx.fillText(`${lat}°`, p[0] + 10 / k, p[1] - 2 / k);
    }
  }

  // ---------- flights layer ----------

  function colorFor(f) {
    return CAT_COLORS[f.category] || "#e9f1f7";
  }

  function altColor(altFt) {
    return d3.interpolateViridis(Math.max(0, Math.min(1, altFt / MAX_ALT_FT)));
  }

  function drawRoutes(ctx, k) {
    for (const f of flights) {
      if (visibleIds && !visibleIds.has(f.id)) continue;
      const isSel = f.id === selectedId;
      const isHover = f.id === hoverId;
      ctx.beginPath();
      geoPathFlights({ type: "LineString", coordinates: routeLegPoints(f) });
      ctx.strokeStyle = colorFor(f);
      ctx.globalAlpha = isSel ? 1 : isHover ? 0.9 : 0.45;
      ctx.lineWidth = (isSel ? 2.4 : isHover ? 1.8 : 1.1) / k;
      if (f.status === "historical") ctx.setLineDash([6 / k, 4 / k]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      if (isSel) {
        for (const end of [f.route.from, f.route.to]) {
          const p = projection([end.lon, end.lat]);
          if (!p) continue;
          ctx.beginPath();
          ctx.arc(p[0], p[1], 3.5 / k, 0, 2 * Math.PI);
          ctx.fillStyle = "#e9f1f7";
          ctx.fill();
          ctx.fillStyle = "rgba(233, 241, 247, 0.9)";
          ctx.font = `bold ${11 / k}px sans-serif`;
          ctx.textAlign = "left";
          ctx.fillText(end.iata, p[0] + 6 / k, p[1] - 5 / k);
        }
      }
    }
  }

  function ensureTrackScreen() {
    if (!track || track.screen) return;
    track.screen = track.points.map(([t, lat, lon, alt]) => {
      const p = projection([lon, lat]);
      return p ? [p[0], p[1], alt, t] : null;
    });
  }

  function drawTrack(ctx, k) {
    if (!track) return;
    ensureTrackScreen();
    const pts = track.screen;
    // batch consecutive segments by quantized altitude bucket: one stroke per run
    let i = 1;
    while (i < pts.length) {
      if (!pts[i - 1] || !pts[i]) { i++; continue; }
      const bucket = Math.min(31, Math.floor((pts[i][2] / MAX_ALT_FT) * 32));
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
      while (i < pts.length && pts[i] &&
             Math.min(31, Math.floor((pts[i][2] / MAX_ALT_FT) * 32)) === bucket) {
        ctx.lineTo(pts[i][0], pts[i][1]);
        i++;
      }
      ctx.strokeStyle = altColor((bucket + 0.5) / 32 * MAX_ALT_FT);
      ctx.lineWidth = 2.2 / k;
      ctx.stroke();
    }
    // marker synced with the elevation-profile hover
    if (profileT != null) {
      let best = null, bestDt = Infinity;
      for (const p of pts) {
        if (!p) continue;
        const dt = Math.abs(p[3] - profileT);
        if (dt < bestDt) { bestDt = dt; best = p; }
      }
      if (best) {
        ctx.beginPath();
        ctx.arc(best[0], best[1], 5 / k, 0, 2 * Math.PI);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      }
    }
  }

  function reckonedPosition(p, nowMs) {
    const ageS = Math.min(Math.max(0, (nowMs - p.fixTime) / 1000), DEAD_RECKON_CAP_S);
    if (!p.gs_kt || p.track == null || ageS < 1) return [p.lon, p.lat];
    const distKm = (p.gs_kt * 1.852 / 3600) * ageS;
    return destinationPoint([p.lon, p.lat], p.track, distKm);
  }

  function drawPlanes(ctx, k, nowMs) {
    for (const p of livePlanes) {
      // trail
      if (p.trail && p.trail.length > 1) {
        ctx.beginPath();
        let started = false;
        for (const ll of p.trail) {
          const s = projection(ll);
          if (!s) continue;
          if (!started) { ctx.moveTo(s[0], s[1]); started = true; }
          else ctx.lineTo(s[0], s[1]);
        }
        ctx.strokeStyle = "rgba(105, 219, 124, 0.45)";
        ctx.lineWidth = 1.4 / k;
        ctx.stroke();
      }
      const pos = reckonedPosition(p, nowMs);
      const s0 = projection(pos);
      if (!s0) continue;
      // screen heading: project a point 5 km ahead along the reported bearing
      let angle = 0;
      if (p.track != null) {
        const s1 = projection(destinationPoint(pos, p.track, 5));
        if (s1) angle = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
      }
      const r = 7 / k;
      ctx.save();
      ctx.translate(s0[0], s0[1]);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.7, r * 0.6);
      ctx.lineTo(-r * 0.35, 0);
      ctx.lineTo(-r * 0.7, -r * 0.6);
      ctx.closePath();
      ctx.fillStyle = p.stale ? "#8aa3b5" : "#69db7c";
      ctx.fill();
      ctx.strokeStyle = "#0b1d2a";
      ctx.lineWidth = 1 / k;
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = p.stale ? "rgba(138,163,181,0.9)" : "rgba(105, 219, 124, 0.95)";
      ctx.font = `bold ${10 / k}px sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(p.flightId + (p.stale ? " (coverage gap)" : ""), s0[0] + 9 / k, s0[1] + 3 / k);
    }
  }

  function drawFlights(nowMs) {
    const ctx = flightsCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    const k = transform.k;
    drawRoutes(ctx, k);
    drawTrack(ctx, k);
    drawPlanes(ctx, k, nowMs);
  }

  // ---------- render loop ----------

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!projection) return;
      if (baseDirty) { drawBase(); baseDirty = false; }
      drawFlights(performance.now() + performance.timeOrigin);
      // keep animating while planes are in the air (dead reckoning + trails)
      if (livePlanes.length) {
        setTimeout(requestRender, 1000 / 30);
      }
    });
  }

  // ---------- public API ----------

  const api = {
    resize,
    requestRender,
    setBasemapData(landTopo) {
      land = topojson.feature(landTopo, landTopo.objects.land);
      borders = landTopo.objects.countries
        ? topojson.mesh(landTopo, landTopo.objects.countries, (a, b) => a !== b)
        : null;
      baseDirty = true;
      requestRender();
    },
    setFlights(list) {
      flights = list;
      for (const f of flights) {
        // sparse samples for hit testing only; drawing uses adaptive resampling
        f._samplePoints = routePoints(f, 150);
      }
      rebuildQuadtree();
      requestRender();
    },
    setVisible(idSet) {
      visibleIds = idSet;
      rebuildQuadtree();
      requestRender();
    },
    setSelected(id) {
      selectedId = id;
      requestRender();
    },
    setTrack(trackData) {
      track = trackData ? { points: trackData.points, screen: null } : null;
      requestRender();
    },
    setProfileT(t) {
      profileT = t;
      requestRender();
    },
    setLivePlanes(planes) {
      livePlanes = planes;
      rebuildQuadtree();
      requestRender();
    },
    setGleason(img, on) {
      if (img !== undefined) gleasonImg = img;
      gleasonOn = on;
      baseDirty = true;
      requestRender();
    },
    flightColor(f) {
      return colorFor(f);
    },
    altColor,
  };

  window.addEventListener("resize", resize);
  resize();
  return api;
}
