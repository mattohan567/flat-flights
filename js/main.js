// App entry: load data, wire the map, sidebar, panel and live poller together.

import { loadFlights } from "./flights.js";
import { loadTracksIndex } from "./tracks.js";
import { createMap } from "./map.js";
import { createPanel } from "./panel.js";
import { createUI } from "./ui.js";
import { createPoller } from "./live.js";

const LAND_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

async function start() {
  const [{ flights, byId }, tracksIndex] = await Promise.all([
    loadFlights(),
    loadTracksIndex(),
  ]);

  const map = createMap({
    baseCanvas: document.getElementById("canvas-base"),
    flightsCanvas: document.getElementById("canvas-flights"),
    eventsEl: document.getElementById("map-events"),
    onSelect: (id) => select(id),
    onHover: (id, xy) => {
      if (id && byId.has(id)) ui.showTooltip(byId.get(id), xy);
      else ui.hideTooltip();
    },
  });

  const ui = createUI({ flights, map, onSelect: (id) => select(id) });

  const panel = createPanel({
    panelEl: document.getElementById("panel"),
    contentEl: document.getElementById("panel-content"),
    closeEl: document.getElementById("panel-close"),
    map,
    tracksIndex,
    onClose: () => select(null),
    onSelectFlight: (id) => select(id),
  });

  function select(id) {
    if (id && !byId.has(id)) id = null;
    map.setSelected(id);
    ui.setSelected(id);
    if (id) {
      panel.show(byId.get(id));
      history.replaceState(null, "", `#${id}`);
    } else {
      panel.hide();
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") select(null);
  });
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id !== panel.currentId()) select(id || null);
  });

  map.setFlights(flights);
  map.setVisible(new Set(flights.map((f) => f.id)));

  // basemap (countries-110m includes both land shapes and borders)
  fetch(LAND_URL)
    .then((r) => r.json())
    .then((topo) => {
      topo.objects.land = topo.objects.land || topo.objects.countries;
      map.setBasemapData(topo);
    })
    .catch((err) => console.warn("basemap load failed:", err));

  // live polling
  const poller = createPoller({
    flights,
    onUpdate: (planes) => {
      map.setLivePlanes(planes);
      ui.setAirborne(planes);
      panel.setLive(planes);
    },
    onStatus: (s) => ui.setStatus(s),
  });
  poller.start();

  // deep link
  const initial = decodeURIComponent(location.hash.slice(1));
  if (initial && byId.has(initial)) select(initial);
}

// the UMD d3/topojson bundles load with `defer` before this module executes
start().catch((err) => {
  console.error(err);
  document.getElementById("map").insertAdjacentHTML(
    "beforeend",
    `<div style="position:absolute;inset:0;display:grid;place-items:center;color:#ffa8a8">
       Failed to start: ${String(err.message || err)}</div>`
  );
});
