/* screens/leaderboard.js — report section 1.3 step 6. */

import * as api from '../api.js';
import { icon } from '../icons.js';
import * as auth from '../auth.js';
import { render, loading, errorState, $, esc } from '../ui.js';

const MEDALS = ['gold', 'silver', 'bronze'];

export async function show() {
  loading('Loading the leaderboard…');

  let rows;
  try {
    rows = await api.getLeaderboard();
  } catch (error) {
    errorState(error.message, 'Try again');
    const retry = $('#retry');
    if (retry) retry.onclick = show;
    return;
  }

  const user = auth.getUser();
  const mine = user && user.neighborhood;
  const total = rows.reduce((sum, r) => sum + r.total_points, 0);

  render(`
    <div class="page-head">
      <h1>Neighborhood ranks</h1>
      <p>${total.toLocaleString()} EcoPoints earned across Lagos so far.</p>
    </div>

    ${rows.length === 0 ? `
      <div class="card state">
        <div class="state-icon">${icon('ranking', { size: 30 })}</div>
        <h2>Nobody on the board yet</h2>
        <p>Submit the first verified report and put your neighborhood in first place.</p>
        <a class="btn btn-primary" href="#/capture">Report a hazard</a>
      </div>` : `
      <div class="card">
        ${rows.map((row, index) => `
          <div class="rank ${MEDALS[index] || ''}">
            <span class="rank-pos">${index + 1}</span>
            <span class="rank-name">
              ${esc(row.neighborhood)}
              ${mine && row.neighborhood === mine ? '<span class="you">· your area</span>' : ''}
            </span>
            <span class="rank-pts">${row.total_points.toLocaleString()}</span>
          </div>`).join('')}
      </div>

      ${mine && !rows.some((r) => r.neighborhood === mine) ? `
        <p class="small muted center mt">
          ${esc(mine)} hasn't scored yet — your first verified report puts it on the board.
        </p>` : ''}`}`);
}
