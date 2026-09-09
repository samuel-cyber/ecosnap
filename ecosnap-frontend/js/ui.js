/* ui.js — small shared helpers used by every screen. */

import { icon } from './icons.js';

/** Escapes anything from the API or a user before it reaches innerHTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const view = () => document.getElementById('view');

export function render(html) {
  view().innerHTML = html;
  view().scrollTop = 0;
}

export function loading(message = 'Loading…') {
  render(`<div class="state"><div class="spinner"></div><p>${esc(message)}</p></div>`);
}

export function errorState(message, retryLabel) {
  render(`
    <div class="state">
      <div class="state-icon">${icon('alert', { size: 30 })}</div>
      <h2>Something went wrong</h2>
      <p>${esc(message)}</p>
      ${retryLabel ? `<button class="btn btn-primary" id="retry">${esc(retryLabel)}</button>` : ''}
    </div>`);
}

let toastTimer;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4800);
}

/** Runs an async action with a button showing a spinner while it works. */
export async function withBusy(button, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner spinner-sm"></span> Working…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

export function relativeTime(value) {
  const seconds = (Date.now() - new Date(value)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString();
}

export const CATEGORY_LABELS = {
  burning: 'Burning trash',
  blocked_drain: 'Blocked drain',
};

/**
 * Category mark at an explicit size, wrapped so it carries the category's own
 * colour. The hue is the encoding -- a reader should be able to tell burning
 * from water down a list without reading the label.
 */
export const categoryIcon = (category, size = 20) => {
  const name = category === 'burning' ? 'flame' : category === 'blocked_drain' ? 'drain' : 'pin';
  return `<span class="cat cat-${category || 'unknown'}">${icon(name, { size })}</span>`;
};

/**
 * Reads the device's location. Resolves to null rather than rejecting, so a
 * denied permission degrades to a clear message instead of a dead end.
 *
 * maximumAge is 0 deliberately. A cached fix would mean someone reporting
 * several drains along one street submits them all at the same coordinates --
 * which the backend's duplicate check then flags, costing the user points for
 * genuinely distinct reports.
 */
export function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}
