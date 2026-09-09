/* app.js — boots the app, guards routes behind sign-in, and routes by hash. */

import { config, hasSupabase, hasMapbox, hasModel } from './config.js';
import * as api from './api.js';
import * as auth from './auth.js';
import { toast, esc } from './ui.js';

import * as authScreen from './screens/auth.js';
import * as capture from './screens/capture.js';
import * as mapScreen from './screens/map.js';
import * as leaderboard from './screens/leaderboard.js';
import * as profile from './screens/profile.js';
import * as redeem from './screens/redeem.js';

const ROUTES = {
  capture: capture.show,
  map: mapScreen.show,
  leaderboard: leaderboard.show,
  profile: profile.show,
  redeem: redeem.show,
};

/** Names what still needs configuring, so nobody debugs a missing key blind. */
function showSetupBanner() {
  const missing = [];
  if (!hasSupabase()) missing.push('Supabase (auth + photo upload)');
  if (!hasModel()) missing.push('Teachable Machine model (AI classification)');
  if (!hasMapbox()) missing.push('Mapbox token (map pins)');

  const banner = document.getElementById('setup-banner');
  if (missing.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.innerHTML =
    `<b>Setup incomplete:</b> ${esc(missing.join(' · '))}. ` +
    `Everything else works against the backend at ${esc(config.API_BASE_URL)}.`;
}

function setChrome(signedIn) {
  document.getElementById('topbar').hidden = !signedIn;
  document.getElementById('tabbar').hidden = !signedIn;
}

function updatePoints() {
  const user = auth.getUser();
  const el = document.getElementById('points-value');
  if (user && el) el.textContent = (user.eco_points || 0).toLocaleString();
}

function setActiveTab(name) {
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
}

let lastRoute = null;

async function route() {
  if (!auth.isSignedIn()) {
    setChrome(false);
    authScreen.show(onSignedIn);
    return;
  }

  setChrome(true);
  updatePoints();

  const name = (location.hash || '#/map').replace('#/', '').split('?')[0] || 'map';
  const screen = ROUTES[name] || ROUTES.map;

  // Mapbox holds a WebGL context; release it when navigating away.
  if (lastRoute === 'map' && name !== 'map') mapScreen.teardown();
  lastRoute = name;

  setActiveTab(ROUTES[name] ? name : 'map');

  try {
    await screen();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function onSignedIn() {
  updatePoints();
  location.hash = '#/capture';
  route();
}

async function boot() {
  showSetupBanner();

  // Fail fast and loudly if the backend isn't reachable — section 1.4 of the
  // report exists precisely because this is the usual first thing to break.
  try {
    await api.ping();
  } catch (error) {
    document.getElementById('view').innerHTML = `
      <div class="state">
        <div class="state-icon">🔌</div>
        <h2>Can't reach the backend</h2>
        <p>${esc(error.message)}</p>
        <p class="small mt">Currently pointing at <code>${esc(config.API_BASE_URL)}</code>.</p>
      </div>`;
    return;
  }

  try {
    await auth.restore();
  } catch {
    /* an unrestorable session just means signing in again */
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('ecosnap:user-changed', updatePoints);
  document.getElementById('points-chip').onclick = () => { location.hash = '#/profile'; };

  route();
}

boot();
