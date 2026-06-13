# Flat Flights ✈️

**Real flights on the flat-earth map — see for yourself.**

### 🌐 Live site: **<https://mattohan567.github.io/flat-flights/>**

A zero-build static site that plots the famous flights from flat-earth debates — live positions and recorded ADS-B paths with altitude — on the north-pole-centered **azimuthal equidistant projection** (the classic "flat earth" map). For every flight it shows, side by side:

- the **great-circle distance** (the globe's distance),
- the **distance the same route measures on the flat map**, and
- the **average speed the flat map would require** of the aircraft, next to the speed the globe implies.

No commentary beyond the numbers. Typical airliner cruise is about 900 km/h; Sydney–Santiago on this map would need roughly **3,100 km/h**. The map's scale isn't ours — the azimuthal equidistant projection is exactly distance-true along its meridians (North Pole → equator = 10,008 km), so flat-map distances are fixed by the map's own geometry.

## The flights

The curated dataset (`data/flights.json`) covers the canonical talking points on all sides:

- **Southern long-hauls** said to "not exist": Qantas QF27/28 Sydney–Santiago, QF63/64 Sydney–Johannesburg, LATAM LA800/801 Auckland–Santiago, SAA Johannesburg–Perth and –São Paulo, the late Air NZ Auckland–Buenos Aires.
- **Emergency diversions** used as flat-earth evidence: the 2015 China Airlines Anchorage diversion ("Bali to LA"), SWISS LX40 in Iqaluit, Delta's Cold Bay landings.
- **Polar routes** that look natural on this map (the one region where it's nearly faithful): Emirates Dubai–LA/SF over the Arctic, Cathay's Polar One heirs, Singapore's longest-flight pair.
- **Antarctica**: Qantas sightseeing charters anyone can book, and QF14's 2021 live-tracked Buenos Aires–Darwin crossing of the continent.
- **Circumnavigations**: Pan Am 50's 1977 pole-to-pole loop, the Flying Tiger "Pole Cat", the 1995 Concorde round-the-world record, Pan Am 1/2.

## How it works

- **Rendering** — [D3](https://d3js.org)'s `geoAzimuthalEquidistant` projection on layered canvases, with [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth) coastlines. Great-circle routes curve correctly on the disc automatically. Track color encodes altitude.
- **Live positions** — your browser polls [airplanes.live](https://airplanes.live)'s free API directly (keyless, CORS-open, max 1 request / 1.5 s) for the operating flights' callsigns. No backend, no key.
- **Recorded tracks** — a [scheduled GitHub Action](.github/workflows/record-tracks.yml) fetches each flight's daily ADS-B trace from [adsb.lol](https://adsb.lol) (ODbL), downsamples it, and commits compact JSON under `data/tracks/`, which the site serves same-origin. The best 5 tracks per flight are kept.
- **The math** — all in [`js/projection.js`](js/projection.js), dependency-free and shared by the site and the scripts. Flat-map distance = the Euclidean length of the (densified) route after the pure AE transform `ρ = R · (90° − lat)`, never measured from screen pixels.

## Run it locally

```sh
python3 -m http.server   # then open http://localhost:8000
```

That's it — there is no build step. Edit a file, reload.

To regenerate the distance fields after editing routes: `node scripts/compute-distances.mjs`.
To record tracks manually: `node scripts/record-tracks.mjs`.

## Deploying your own

1. Fork, then enable **Settings → Pages → Deploy from a branch → `main` / root**.
2. (Optional) enable the `record-tracks` workflow under the Actions tab to start accumulating real tracks.

## Data sources & attribution

- Live aircraft positions: [airplanes.live](https://airplanes.live) (free, non-commercial; please keep the attribution link).
- Historical traces: [adsb.lol](https://adsb.lol) open data, [ODbL](https://opendatacommons.org/licenses/odbl/).
- Basemap: [Natural Earth](https://www.naturalearthdata.com/) via [world-atlas](https://github.com/topojson/world-atlas) (public domain / ISC).
- Optional raster basemap: Gleason's 1892 *New Standard Map of the World* (public domain).
- Flight facts: sources linked per flight in the detail panel (Metabunk, flatearth.ws, MCToon, news archives, Flightradar24).

## License

Code is [MIT](LICENSE). Flight dataset (`data/flights.json`) is released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/); recorded tracks derive from adsb.lol and remain ODbL.
