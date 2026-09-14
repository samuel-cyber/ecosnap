/* screens/map.js — report section 1.3 step 5. */

import { config, hasMapbox } from '../config.js';
import * as api from '../api.js';
import { icon } from '../icons.js';
import { render, $, toast, esc, CATEGORY_LABELS, categoryIcon, relativeTime } from '../ui.js';

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
        <span class="legend-row"><span class="dot burning"></span> Burning trash</span>
        <span class="legend-row"><span class="dot blocked_drain"></span> Blocked drain</span>
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
  // Without a token the shell is not holding a map, so it must stop behaving
  // like one -- its fixed height and overflow were clipping the list below.
  document.querySelector('.map-shell').classList.add('is-list');

  $('#map').innerHTML = `
    <div class="map-fallback">
      <div>
        <div class="state-icon">${icon('map', { size: 30 })}</div>
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
        <span class="rank-pos">${categoryIcon(r.category)}</span>
        <span class="rank-name">${esc(CATEGORY_LABELS[r.category] || r.category)
        }<div class="small muted">${
          // A place name where the backend knows one. Coordinates are a
          // fallback, not a label -- "6.5095, 3.3711" tells a reader nothing.
          r.neighborhood && r.neighborhood !== 'Unknown'
            ? esc(r.neighborhood)
            : `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`
        } · ${esc(relativeTime(r.created_at))}</div>
        </span>
      </div>`)
    .join('');

  // After the shell, not after #map -- inside the shell it would be clipped.
  document.querySelector('.map-shell')
    .insertAdjacentHTML('afterend', `<div class="card mt">${list}</div>`);
}

function renderMap(reports) {
  window.mapboxgl.accessToken = config.MAPBOX_TOKEN;

  const centre = reports.length
    ? { lat: reports[0].lat, lng: reports[0].lng }
    : config.DEFAULT_CENTER;

  map = new window.mapboxgl.Map({
    container: 'map',
    // Light, to match the rest of the app -- a dark basemap under a light UI
    // read as a different product, and washes out in the sun this is used in.
    // light-v11 keeps roads and Lagos place names but stays quiet enough that
    // the only saturated colour on screen is a hazard.
    style: 'mapbox://styles/mapbox/light-v11',
    center: [centre.lng, centre.lat],
    zoom: reports.length ? 12 : 11,
  });

  map.addControl(new window.mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new window.mapboxgl.GeolocateControl({ trackUserLocation: false }), 'top-right');

  map.on('load', () => {
    // The container is sized by the stylesheet, which may not have settled
    // when Mapbox first measured it -- and the screen can be swapped in at
    // any width. Measure again now that it is certainly real.
    map.resize();
    $('#map').classList.add('is-ready');
    plot(reports, { stagger: true });
    frameTo(reports);
  });

  // Re-query using the backend's bounding-box filter as the user pans.
  let timer;
  map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(refreshForViewport, 400);
  });
}

/**
 * Opens on all of the data rather than on whichever report happened to be
 * first in the response. duration 0 deliberately: the user did not ask for a
 * camera move, so it should already be framed when the tiles fade up.
 */
function frameTo(reports) {
  if (!map || reports.length < 2) return;

  const bounds = new window.mapboxgl.LngLatBounds();
  reports.forEach((report) => bounds.extend([report.lng, report.lat]));
  map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
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

/**
 * `stagger` is only true for the first paint. Panning refetches and replots,
 * and replaying the entrance on every pan would turn a map you are reading
 * into one that keeps flinching.
 */
function plot(reports, { stagger = false } = {}) {
  markers.forEach((m) => m.remove());
  markers = [];

  reports.forEach((report, index) => {
    // Mapbox writes its own transform onto the element it is handed, to
    // position it. The pin that animates therefore has to be a child of that
    // element rather than the element itself, or the two fight over transform
    // and the marker lands in the wrong place.
    const anchor = document.createElement('div');
    const pin = document.createElement('div');
    pin.className = `marker ${report.category}`;
    pin.innerHTML = categoryIcon(report.category, 16);

    if (stagger) {
      // Capped: past a dozen the sequence stops reading as arrival and starts
      // reading as lag.
      pin.style.setProperty('--pin-delay', `${Math.min(index, 12) * 45}ms`);
    } else {
      pin.style.animation = 'none';
    }
    anchor.appendChild(pin);

    const place = report.neighborhood && report.neighborhood !== 'Unknown'
      ? `${esc(report.neighborhood)} · `
      : '';

    const popup = new window.mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(`
      <b class="popup-title">${esc(CATEGORY_LABELS[report.category] || report.category)}</b>
      <span class="popup-meta">${place}${esc(relativeTime(report.created_at))}</span>`);

    markers.push(
      new window.mapboxgl.Marker(anchor)
        .setLngLat([report.lng, report.lat])
        .setPopup(popup)
        .addTo(map)
    );
  });
}

/** Mapbox keeps WebGL contexts alive; drop it when leaving the screen. */
export function teardown() {
  if (map) {
    map.remove();
    map = null;
    markers = [];
  }
}
