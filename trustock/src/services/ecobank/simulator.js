// src/services/ecobank/simulator.js
//
// A stand-in for the Ecobank rails, used when live credentials are not
// configured. It is deterministic, it never touches a real account, and every
// result it returns is stamped mode: 'simulated' so that the API, the audit
// trail and the UI can all say plainly that no real money moved.
//
// The point of this file is honesty, not realism. It exists so that the pool,
// risk and settlement workflow can be demonstrated end to end without anyone
// being led to believe a bank transfer happened.

const crypto = require('crypto');

const SIMULATED_LATENCY_MS = Number(process.env.SIMULATOR_LATENCY_MS || 250);

// Deterministic reference derived from our own request reference, so replaying
// the same request produces the same provider reference -- the same property a
// real idempotent payment API gives us.
function simulatedReference(prefix, reference) {
  const hash = crypto.createHash('sha256').update(reference).digest('hex');
  return `SIM-${prefix}-${hash.slice(0, 12).toUpperCase()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Demo control: a request whose reference contains "FAILDEMO" fails. This lets
 * the failure and refund paths be shown on stage without editing code, and it
 * is the only way the simulator ever returns success: false.
 */
function shouldFail(reference) {
  return /FAILDEMO/i.test(reference);
}

async function respond(prefix, reference, message) {
  await sleep(SIMULATED_LATENCY_MS);
  if (shouldFail(reference)) {
    return {
      success: false,
      providerReference: simulatedReference(prefix, reference),
      message: 'Simulated provider decline (reference marked FAILDEMO)',
      simulated: true,
      raw: { simulated: true, outcome: 'declined' },
    };
  }
  return {
    success: true,
    providerReference: simulatedReference(prefix, reference),
    message,
    simulated: true,
    raw: { simulated: true, outcome: 'accepted' },
  };
}

async function collect({ reference }) {
  return respond('COL', reference, 'Simulated collection accepted. No real funds moved.');
}

async function disburse({ reference }) {
  return respond('PAY', reference, 'Simulated payout accepted. No real funds moved.');
}

async function reverse({ reference }) {
  return respond('REV', reference, 'Simulated reversal accepted. No real funds moved.');
}

async function getStatus(reference) {
  return respond('STA', reference, 'Simulated status lookup.');
}

module.exports = { collect, disburse, reverse, getStatus };
