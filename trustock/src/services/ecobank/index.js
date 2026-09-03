// src/services/ecobank/index.js
//
// The only door between Trustock and the bank. Services call this adapter and
// never the client or the simulator directly, which means there is exactly one
// place that decides whether a money movement was real -- and it labels every
// single result with that decision.

const config = require('../../config/env');
const liveClient = require('./client');
const simulator = require('./simulator');

const isLive = config.ecobank.mode === 'live';
const provider = isLive ? liveClient : simulator;

const SIMULATED_NOTICE =
  'SIMULATED: Ecobank credentials are not configured, so this transaction was ' +
  'processed by Trustock\'s labelled simulator. No real funds moved.';

const LIVE_NOTICE =
  'LIVE: this transaction was sent to the configured Ecobank API.';

function mode() {
  return config.ecobank.mode;
}

/** Everything the UI needs to tell the truth about the integration. */
function describe() {
  return {
    provider: 'ecobank',
    mode: config.ecobank.mode,
    simulated: !isLive,
    notice: isLive ? LIVE_NOTICE : SIMULATED_NOTICE,
    baseUrl: isLive ? config.ecobank.baseUrl : null,
    capabilities: {
      collection: true,
      payment: true,
      reversal: true,
      transactionStatus: true,
    },
    // Named so nobody has to guess what is real in a demo.
    verified: isLive,
  };
}

function stamp(result) {
  return {
    ...result,
    mode: config.ecobank.mode,
    simulated: !isLive,
    notice: isLive ? LIVE_NOTICE : SIMULATED_NOTICE,
  };
}

async function collectContribution(params) {
  return stamp(await provider.collect(params));
}

async function disburseToSupplier(params) {
  return stamp(await provider.disburse(params));
}

async function reverseToContributor(params) {
  return stamp(await provider.reverse(params));
}

async function transactionStatus(reference) {
  return stamp(await provider.getStatus(reference));
}

module.exports = {
  mode,
  describe,
  collectContribution,
  disburseToSupplier,
  reverseToContributor,
  transactionStatus,
};
