/* screens/profile.js — report section 1.3 step 7 ("My Impact"). */

import * as api from '../api.js';
import * as auth from '../auth.js';
import { render, loading, errorState, $, esc, toast } from '../ui.js';

export async function show() {
  loading('Loading your impact…');

  const cached = auth.getUser();
  if (!cached) return;

  let user;
  try {
    user = await api.getUser(cached.id);
  } catch (error) {
    errorState(error.message, 'Try again');
    const retry = $('#retry');
    if (retry) retry.onclick = show;
    return;
  }

  // The backend's GET /reports only returns verified reports without an owner
  // filter, so "my reports" is derived client-side from what's visible. It is
  // labelled as verified-only so the number isn't mistaken for a total.
  const points = user.eco_points || 0;
  const verifiedReports = Math.floor(points / 10);

  render(`
    <div class="page-head">
      <h1>My impact</h1>
      <p>What you've contributed so far.</p>
    </div>

    <div class="card center">
      <div class="stat-value" style="font-size:44px;color:var(--green)">${points.toLocaleString()}</div>
      <div class="stat-label">EcoPoints</div>
      <p class="small muted mt">${esc(user.display_name)}${user.neighborhood ? ` · ${esc(user.neighborhood)}` : ''}</p>
    </div>

    <div class="stat-grid mt">
      <div class="stat">
        <div class="stat-value">${verifiedReports}</div>
        <div class="stat-label">Verified reports</div>
      </div>
      <div class="stat">
        <div class="stat-value">${Math.floor(points / 50)}</div>
        <div class="stat-label">Rewards affordable</div>
      </div>
    </div>

    <div class="card mt">
      <h3>How points work</h3>
      <div class="rank" style="border:none">
        <span class="rank-name small muted">Verified report</span>
        <span class="rank-pts">+10</span>
      </div>
      <div class="rank">
        <span class="rank-name small muted">Flagged report (low confidence or duplicate)</span>
        <span class="rank-pts">0</span>
      </div>
      <p class="hint mt">
        Reports are verified automatically when the model is at least 75% confident
        and the spot hasn't just been reported by someone else.
      </p>
    </div>

    <div class="actions mt">
      <a class="btn btn-quiet" href="#/redeem">Spend points</a>
      <button class="btn btn-ghost" id="signout">Sign out</button>
    </div>`);

  $('#signout').onclick = async () => {
    await auth.signOut();
    toast('Signed out.');
    location.hash = '#/';
    location.reload();
  };
}
