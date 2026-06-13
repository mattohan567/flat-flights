// Sidebar list, category filter chips, live-status pill, legend, tooltip,
// and the Gleason basemap toggle.

import { CATEGORY_LABELS } from "./flights.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function createUI({ flights, map, onSelect }) {
  const listEl = document.getElementById("flight-list");
  const filtersEl = document.getElementById("filters");
  const statusEl = document.getElementById("live-status");
  const tooltipEl = document.getElementById("tooltip");
  const legendEl = document.getElementById("legend");

  const activeCats = new Set(Object.keys(CATEGORY_LABELS));
  const airborneIds = new Set();
  let selectedId = null;

  // ---------- filter chips ----------
  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const chip = document.createElement("button");
    chip.className = "filter-chip";
    chip.textContent = label;
    chip.style.setProperty("--cat-color", map.flightColor({ category: cat }));
    chip.addEventListener("click", () => {
      if (activeCats.has(cat)) activeCats.delete(cat);
      else activeCats.add(cat);
      chip.classList.toggle("off", !activeCats.has(cat));
      applyFilter();
    });
    filtersEl.appendChild(chip);
  }

  function visibleIdSet() {
    return new Set(flights.filter((f) => activeCats.has(f.category)).map((f) => f.id));
  }

  function applyFilter() {
    map.setVisible(visibleIdSet());
    renderList();
  }

  // ---------- flight list ----------
  function renderList() {
    listEl.replaceChildren();
    for (const f of flights) {
      if (!activeCats.has(f.category)) continue;
      const li = document.createElement("li");
      li.dataset.id = f.id;
      li.style.setProperty("--cat-color", map.flightColor(f));
      li.classList.toggle("selected", f.id === selectedId);
      const badges = [];
      if (airborneIds.has(f.id)) badges.push(`<span class="badge badge-airborne">airborne</span>`);
      if (f.status === "historical") badges.push(`<span class="badge badge-historical">past</span>`);
      if (f.status === "seasonal") badges.push(`<span class="badge badge-seasonal">seasonal</span>`);
      li.innerHTML = `
        <span class="fl-badges">${badges.join("")}</span>
        <span class="fl-id">${esc(f.id)}</span>
        <div class="fl-route">${esc(f.route.from.iata)} → ${esc(f.route.to.iata)} · ${esc(f.airline)}</div>`;
      li.addEventListener("click", () => onSelect?.(f.id));
      listEl.appendChild(li);
    }
  }

  // ---------- legend ----------
  legendEl.innerHTML = `altitude (ft)`;
  const ramp = document.createElement("canvas");
  ramp.width = 140;
  ramp.height = 10;
  const rctx = ramp.getContext("2d");
  for (let i = 0; i < ramp.width; i++) {
    rctx.fillStyle = map.altColor((i / ramp.width) * 43000);
    rctx.fillRect(i, 0, 1, ramp.height);
  }
  legendEl.appendChild(ramp);
  const scaleRow = document.createElement("div");
  scaleRow.style.display = "flex";
  scaleRow.style.justifyContent = "space-between";
  scaleRow.innerHTML = `<span>0</span><span>43k</span>`;
  legendEl.appendChild(scaleRow);

  // ---------- Gleason basemap toggle (shown only if the image exists) ----------
  const toggleWrap = document.getElementById("basemap-toggle-wrap");
  const toggle = document.getElementById("basemap-toggle");
  const img = new Image();
  img.onload = () => {
    toggleWrap.hidden = false;
    const startOn = new URLSearchParams(location.search).has("gleason");
    toggle.checked = startOn;
    map.setGleason(img, startOn);
  };
  img.src = "data/basemap/gleason-1892.jpg";
  toggle.addEventListener("change", () => map.setGleason(undefined, toggle.checked));

  return {
    setSelected(id) {
      selectedId = id;
      renderList();
    },
    setAirborne(planes) {
      airborneIds.clear();
      for (const p of planes) if (!p.stale) airborneIds.add(p.flightId);
      renderList();
    },
    setStatus(s) {
      statusEl.classList.remove("status-live", "status-idle", "status-error");
      if (s.state === "live") {
        statusEl.classList.add("status-live");
        statusEl.textContent = `live: ${s.airborne} airborne / ${s.total} watched`;
      } else if (s.state === "paused") {
        statusEl.classList.add("status-idle");
        statusEl.textContent = "live: paused (tab hidden)";
      } else if (s.state === "error") {
        statusEl.classList.add("status-error");
        statusEl.textContent = `live: retrying in ${Math.round(s.retryMs / 1000)}s`;
      } else {
        statusEl.classList.add("status-idle");
        statusEl.textContent = "live: off";
      }
    },
    showTooltip(flight, [x, y]) {
      tooltipEl.hidden = false;
      tooltipEl.textContent = `${flight.id} · ${flight.route.from.iata} → ${flight.route.to.iata}`;
      tooltipEl.style.left = `${x + 14}px`;
      tooltipEl.style.top = `${y + 8}px`;
    },
    hideTooltip() {
      tooltipEl.hidden = true;
    },
  };
}
