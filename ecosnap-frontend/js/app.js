/* app.js — boots the app, guards routes behind sign-in, and routes by hash. */

import { icon } from './icons.js';

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
  if (!user || !el) return;

  const next = (user.eco_points || 0).toLocaleString();
  const changed = el.textContent !== next;
  el.textContent = next;
  if (!changed) return;

  // Points are earned on one screen and shown on another, so the balance
  // otherwise changes with nothing to catch the eye.
  const chip = document.getElementById('points-chip');
  chip.classList.remove('bumped');
  void chip.offsetWidth; // reflow, so the animation restarts on a repeat award
  chip.classList.add('bumped');
}

function setActiveTab(name) {
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const current = tab.dataset.tab === name;
    // aria-current is what screen readers announce and what the stylesheet
    // targets, so the visual and announced states cannot drift apart.
    if (current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
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

function showWaking(attempt, total) {
  document.getElementById('view').innerHTML = `
    <div class="state">
      <div class="spinner"></div>
      <h2>Waking the backend…</h2>
      <p>Free hosting puts the API to sleep when it's idle. This usually takes
         under a minute.</p>
      <p class="small mt">Attempt ${attempt} of ${total}.</p>
    </div>`;
}

function showOffline(error) {
  document.getElementById('view').innerHTML = `
    <div class="state">
      <div class="state-icon">${icon('offline', { size: 30 })}</div>
      <h2>Can't reach the backend</h2>
      <p>${esc(error.message)}</p>
      <p class="small mt">Currently pointing at <code>${esc(config.API_BASE_URL)}</code>.</p>
      <button class="btn btn-primary mt" id="retry-boot">Try again</button>
    </div>`;
  document.getElementById('retry-boot').onclick = boot;
}

/**
 * One failed ping is not proof the API is down: a sleeping free-tier backend
 * takes the better part of a minute to wake, and that is exactly when someone
 * is watching a demo. Retry a few times before giving up, and leave a button
 * rather than a dead end when we do.
 */
async function waitForBackend() {
  const delays = [2000, 4000, 8000];

  for (let attempt = 0; ; attempt += 1) {
    try {
      await api.ping();
      return true;
    } catch (error) {
      if (attempt >= delays.length) {
        showOffline(error);
        return false;
      }
      showWaking(attempt + 2, delays.length + 1);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

let wired = false;

async function boot() {
  showSetupBanner();

  if (!(await waitForBackend())) return;

  try {
    await auth.restore();
  } catch {
    /* an unrestorable session just means signing in again */
  }

  if (!wired) {
    wired = true;
    window.addEventListener('hashchange', route);
    window.addEventListener('ecosnap:user-changed', updatePoints);
    document.getElementById('points-chip').onclick = () => { location.hash = '#/profile'; };
  }

  route();
}

boot();
