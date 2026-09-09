/* screens/redeem.js — report section 1.3 step 8.
 *
 * The rewards are intentionally mocked (the backend records the redemption and
 * deducts points, but nothing is actually fulfilled). The UI says so plainly,
 * matching the report's own advice to be explicit about what's simulated.
 */

import * as api from '../api.js';
import { icon } from '../icons.js';
import * as auth from '../auth.js';
import { render, loading, errorState, $, esc, toast, withBusy } from '../ui.js';

const REWARDS = [
  { icon: 'signal', name: '100MB Data', cost: 50 },
  { icon: 'phone', name: '₦200 Airtime', cost: 100 },
  { icon: 'ticket', name: 'Eco Voucher', cost: 150 },
  { icon: 'shirt', name: 'EcoSnap T-shirt', cost: 500 },
];

export async function show() {
  loading('Loading rewards…');

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

  const points = user.eco_points || 0;

  render(`
    <div class="page-head">
      <h1>Rewards</h1>
      <p>You have <b class="accent">${points.toLocaleString()}</b> EcoPoints to spend.</p>
    </div>

    <div class="notice info">
      Rewards are simulated for this MVP — redeeming deducts your points and records the
      transaction, but nothing is actually delivered yet.
    </div>

    <div class="card">
      ${REWARDS.map((reward) => {
        const affordable = points >= reward.cost;
        return `
          <div class="reward">
            <span class="reward-ico">${icon(reward.icon)}</span>
            <span class="reward-info">
              <span class="reward-name">${esc(reward.name)}</span>
              <span class="reward-cost">${reward.cost} points</span>
            </span>
            <button class="btn ${affordable ? 'btn-primary' : 'btn-ghost'}"
                    data-reward="${esc(reward.name)}" data-cost="${reward.cost}"
                    ${affordable ? '' : 'disabled'}>
              ${affordable ? 'Redeem' : `Need ${reward.cost - points}`}
            </button>
          </div>`;
      }).join('')}
    </div>`);

  document.querySelectorAll('[data-reward]').forEach((button) => {
    button.onclick = () =>
      withBusy(button, async () => {
        await api.redeem({
          userId: user.id,
          pointsSpent: Number(button.dataset.cost),
          rewardType: button.dataset.reward,
        });
        await auth.refresh();
        showSuccess(button.dataset.reward);
      }).catch((error) => toast(error.message, 'bad'));
  });
}

function showSuccess(rewardName) {
  render(`
    <div class="result verified">
      <div class="state-icon">${icon('check', { size: 32 })}</div>
      <h1>Reward Sent</h1>
      <p>Your <b>${esc(rewardName)}</b> is on its way — simulated for this MVP, but your points
         have genuinely been deducted.</p>
    </div>
    <div class="actions mt">
      <button class="btn btn-quiet" id="more">Back to rewards</button>
      <a class="btn btn-primary" href="#/capture">Earn more points</a>
    </div>`);

  $('#more').onclick = show;
}
