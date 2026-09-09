/* screens/profile.js — report section 1.3 step 7 ("My Impact"). */

import * as api from '../api.js';
import { icon } from '../icons.js';
import * as auth from '../auth.js';
import {
  render, loading, errorState, $, esc, toast, relativeTime,
  CATEGORY_LABELS, categoryIcon,
} from '../ui.js';

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

  // GET /users/:id/reports is optional (see BACKEND-NEEDS.md). Where the
  // backend doesn't serve it, the screen drops the history and the counts
  // rather than guessing at them -- a wrong number here is worse than none,
  // because deriving a count from the points balance makes redeeming look
  // like it erased work already done.
  let reports = null;
  try {
    reports = await api.getUserReports(cached.id);
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const points = user.eco_points || 0;
  const hasHistory = Array.isArray(reports);
  const verified = hasHistory ? reports.filter((r) => r.status === 'verified') : [];
  const flagged = hasHistory ? reports.filter((r) => r.status === 'flagged') : [];

  // Counted from the reports themselves, not derived from the points balance:
  // spending points must not appear to erase work already done.
  const earned = hasHistory
    ? reports.reduce((sum, r) => sum + (r.points_awarded || 0), 0)
    : 0;

  render(`
    <div class="page-head">
      <h1>My impact</h1>
      <p>What you've contributed so far.</p>
    </div>

    <div class="card center">
      <div class="balance">${points.toLocaleString()}</div>
      <div class="stat-label">EcoPoints available</div>
      <p class="small muted mt">${esc(user.display_name)}${user.neighborhood ? ` · ${esc(user.neighborhood)}` : ''}</p>
    </div>

    ${!hasHistory ? '' : `
      <div class="stat-grid mt">
        <div class="stat">
          <div class="stat-value">${verified.length}</div>
          <div class="stat-label">Verified report${verified.length === 1 ? '' : 's'}</div>
        </div>
        <div class="stat">
          <div class="stat-value">${earned.toLocaleString()}</div>
          <div class="stat-label">Points earned all time</div>
        </div>
      </div>`}

    ${!hasHistory ? '' : reports.length === 0 ? `
      <div class="card state mt">
        <div class="state-icon">${icon('impact', { size: 30 })}</div>
        <h2>No reports yet</h2>
        <p>Your first verified report earns 10 EcoPoints.</p>
        <a class="btn btn-primary" href="#/capture">Report a hazard</a>
      </div>` : `
      <div class="card mt">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h3>Your reports</h3>
          <span class="small muted">${reports.length} total</span>
        </div>
        ${flagged.length ? `
          <p class="hint mt">
            ${flagged.length} ${flagged.length === 1 ? 'is' : 'are'} still being double-checked —
            low confidence or a possible duplicate. They earn no points, but they still help.
          </p>` : ''}
        <div class="mt">
          ${reports.slice(0, 12).map((r) => `
            <div class="rank">
              <span class="rank-pos">${categoryIcon(r.category)}</span>
              <span class="rank-name">
                ${esc(CATEGORY_LABELS[r.category] || r.category)}
                <div class="small muted">
                  ${esc(r.neighborhood || 'Unknown')} · ${esc(relativeTime(r.created_at))}
                </div>
              </span>
              <span class="pill ${r.status === 'verified' ? 'pill-green' : 'pill-warn'}">
                ${r.status === 'verified' ? `+${r.points_awarded}` : 'checking'}
              </span>
            </div>`).join('')}
        </div>
      </div>`}

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
