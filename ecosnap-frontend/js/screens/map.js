/* screens/map.js — report section 1.3 step 5. */

import { config, hasMapbox } from '../config.js';
import * as api from '../api.js';
import { render, $, toast, esc, CATEGORY_LABELS, CATEGORY_ICONS, relativeTime } from '../ui.js';

let map = null;
let markers = [];

export async function show() {
  render(`
    <div class="page-head">
      <h1>Hazard map</h1>
      <p>Every verified report across Lagos.</p>
    </div>
    <div class="map-shell">
      <div id="map"></div>
      <div class="map-legend">
        <div class="legend-row"><span class="dot burning"></span> Burning trash</div>
        <div class="legend-row"><span class="dot blocked_drain"></span> Blocked drain</div>
      </div>
    </div>
    <p class="small muted center mt" id="map-count">Loading reports…</p>`);

  let reports = [];
  try {
    reports = await api.getReports();
  } catch (error) {
    $('#map-count').textContent = '';
    toast(error.message, 'bad');
  }

  const countEl = $('#map-count');
  if (countEl) {
    countEl.textContent = reports.length
      ? `${reports.length} verified report${reports.length === 1 ? '' : 's'}`
      : 'No verified reports yet — be the first.';
  }

  if (!hasMapbox()) return showFallback(reports);
  renderMap(reports);
}

/** Mapbox needs a token; without one we still show the data as a list. */
function showFallback(reports) {
  $('#map').innerHTML = `
    <div class="map-fallback">
      <div>
        <div class="state-icon">🗺️</div>
        <h2>Map needs a Mapbox token</h2>
        <p class="small muted mt">
          Add <code>MAPBOX_TOKEN</code> to <code>config.local.js</code> to plot pins.
          The ${reports.length} verified report${reports.length === 1 ? '' : 's'} below came
          from the backend either way.
        </p>
      </div>
    </div>`;

  if (!reports.length) return;

  const list = reports
    .slice(0, 30)
    .map((r) => `
      <div class="rank">
        <span class="rank-pos">${CATEGORY_ICONS[r.category] || '📍'}</span>
        <span class="rank-name">${esc(CATEGORY_LABELS[r.category] || r.category)}
          <div class="small muted">${r.lat.toFixed(4)}, ${r.lng.toFixed(4)} · ${esc(relativeTime(r.created_at))}</div>
        </span>
      </div>`)
    .join('');

  $('#map').insertAdjacentHTML('afterend', `<div class="card mt">${list}</div>`);
}

function renderMap(reports) {
  window.mapboxgl.accessToken = config.MAPBOX_TOKEN;

  const centre = reports.length
    ? { lat: reports[0].lat, lng: reports[0].lng }
    : config.DEFAULT_CENTER;

  map = new window.mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [centre.lng, centre.lat],
    zoom: reports.length ? 12 : 11,
  });

  map.addControl(new window.mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new window.mapboxgl.GeolocateControl({ trackUserLocation: false }), 'top-right');

  map.on('load', () => plot(reports));

  // Re-query using the backend's bounding-box filter as the user pans.
  let timer;
  map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(refreshForViewport, 400);
  });
}

async function refreshForViewport() {
  if (!map) return;
  const b = map.getBounds();

  try {
    const reports = await api.getReports({
      minLat: b.getSouth(), maxLat: b.getNorth(),
      minLng: b.getWest(), maxLng: b.getEast(),
    });
    plot(reports);
    const countEl = $('#map-count');
    if (countEl) {
      countEl.textContent = `${reports.length} verified report${reports.length === 1 ? '' : 's'} in view`;
    }
  } catch {
    /* a failed refresh shouldn't wipe the pins already on screen */
  }
}

function plot(reports) {
  markers.forEach((m) => m.remove());
  markers = [];

  for (const report of reports) {
    const el = document.createElement('div');
    el.className = `marker ${report.category}`;
    el.textContent = CATEGORY_ICONS[report.category] || '';

    const popup = new window.mapboxgl.Popup({ offset: 16 }).setHTML(`
      <div style="color:#111">
        <b>${esc(CATEGORY_LABELS[report.category] || report.category)}</b><br />
        <small>${esc(relativeTime(report.created_at))}</small>
      </div>`);

    markers.push(
      new window.mapboxgl.Marker(el)
        .setLngLat([report.lng, report.lat])
        .setPopup(popup)
        .addTo(map)
    );
  }
}

/** Mapbox keeps WebGL contexts alive; drop it when leaving the screen. */
export function teardown() {
  if (map) {
    map.remove();
    map = null;
    markers = [];
  }
}
