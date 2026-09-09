/* screens/auth.js — report section 1.3 step 1. */

import { hasSupabase } from '../config.js';
import * as auth from '../auth.js';
import { render, $, toast, withBusy, esc } from '../ui.js';

const NEIGHBORHOODS = ['Yaba', 'Surulere', 'Ikeja'];

export function show(onSignedIn) {
  render(`
    <div class="auth-wrap">
      <div class="auth">
        <div class="auth-hero">
          <div class="globe">🌍</div>
          <h1>EcoSnap</h1>
          <p>Snap burning trash or a blocked drain. Earn EcoPoints. Put your neighborhood on the map.</p>
        </div>

        <div class="card">
          <div id="auth-error"></div>

          <div class="field">
            <label for="display_name">Your name</label>
            <input id="display_name" placeholder="e.g. Tolu" autocomplete="name" />
          </div>

          <div class="field">
            <label for="neighborhood">Your neighborhood</label>
            <select id="neighborhood">
              ${NEIGHBORHOODS.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
              <option value="">Somewhere else</option>
            </select>
            <p class="hint">Your points count toward this neighborhood on the leaderboard.</p>
          </div>

          ${hasSupabase() ? `
            <button class="btn btn-primary btn-block btn-lg" id="anon">Start reporting</button>

            <div class="divider">or use email</div>

            <div class="field">
              <label for="email">Email address</label>
              <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
              <p class="hint">We'll email you a magic link — no password to remember.</p>
            </div>
            <button class="btn btn-quiet btn-block" id="magic">Email me a link</button>
          ` : `
            <div class="notice">
              <b>Supabase isn't configured yet.</b> Add <code>SUPABASE_URL</code> and
              <code>SUPABASE_ANON_KEY</code> in <code>config.local.js</code> to turn on real
              accounts. Until then you can continue with a local demo profile — it registers
              a real user with the backend, so points, reports and the leaderboard all work.
            </div>
            <button class="btn btn-primary btn-block btn-lg" id="local">Continue as demo user</button>
          `}
        </div>
      </div>
    </div>`);

  const nameOf = () => ($('#display_name').value || '').trim() || 'EcoSnapper';
  const hoodOf = () => $('#neighborhood').value || null;

  const fail = (error) => {
    $('#auth-error').innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  };

  const anon = $('#anon');
  if (anon) {
    anon.onclick = () =>
      withBusy(anon, () => auth.signInAnonymously(nameOf(), hoodOf()))
        .then(onSignedIn)
        .catch(fail);
  }

  const local = $('#local');
  if (local) {
    local.onclick = () =>
      withBusy(local, () => auth.signInLocal(nameOf(), hoodOf()))
        .then(onSignedIn)
        .catch(fail);
  }

  const magic = $('#magic');
  if (magic) {
    magic.onclick = () => {
      const email = ($('#email').value || '').trim();
      if (!email) return toast('Enter your email address first.', 'bad');
      return withBusy(magic, () => auth.signInWithEmail(email))
        .then(() => toast('Check your inbox for the sign-in link.', 'good'))
        .catch(fail);
    };
  }
}
