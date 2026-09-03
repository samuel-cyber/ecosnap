// src/services/ecobank/client.js
//
// HTTP client for the Ecobank APIs.
//
// IMPORTANT, AND DELIBERATE:
// The endpoint paths and payload field names below follow the shape published
// on Ecobank's developer portal (token call, then Origin/labId headers on each
// request). They have NOT been verified against the InnovateX-issued
// documentation from inside this build, so every path and the base URL are
// read from configuration rather than hard-coded. Verifying the contract is a
// change to .env, not a rewrite of this file.
//
// This client is only ever reached when ECOBANK_MODE=live AND real credentials
// are configured (src/config/env.js refuses to start otherwise). If it is not
// configured, Trustock uses the clearly-labelled simulator instead and says so
// in every API response and on every screen. We do not fake this integration.

const config = require('../../config/env');
const { badGateway } = require('../../lib/errors');

let cachedToken = null; // { value, expiresAt }

async function request(path, { method = 'POST', body, token, headers = {} } = {}) {
  const url = `${config.ecobank.baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ecobank.timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Origin: config.ecobank.labId,
        labId: config.ecobank.labId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw badGateway(`Ecobank responded ${response.status}`, {
        status: response.status,
        payload,
      });
    }
    return payload;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.name === 'AbortError') {
      throw badGateway(`Ecobank request timed out after ${config.ecobank.timeoutMs}ms`);
    }
    throw badGateway(`Could not reach Ecobank: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches (and briefly caches) an access token. */
async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const payload = await request(config.ecobank.paths.token, {
    body: {
      userId: config.ecobank.username,
      password: config.ecobank.password,
    },
  });

  const value = payload.token || payload.access_token || (payload.data && payload.data.token);
  if (!value) {
    throw badGateway('Ecobank token response did not contain a token', { payload });
  }

  // Ecobank tokens are long-lived; we re-fetch every 30 minutes regardless.
  cachedToken = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
  return value;
}

/**
 * Debits a contributor and credits the Trustock collection account.
 * `reference` is our idempotency handle -- reusing it must not double-charge.
 */
async function collect({ reference, amountKobo, narration, payer }) {
  const token = await getToken();
  const payload = await request(config.ecobank.paths.collection, {
    token,
    body: {
      requestId: reference,
      affiliateCode: config.ecobank.affiliateCode,
      amount: (amountKobo / 100).toFixed(2),
      currency: 'NGN',
      narration,
      customerId: payer.customerId || payer.email,
      customerName: payer.name,
      customerPhone: payer.phone || '',
      destinationAccountNumber: config.ecobank.sourceAccount,
    },
  });
  return normaliseProviderResult(payload, reference);
}

/** Pays the pooled amount out to the supplier's bank account. */
async function disburse({ reference, amountKobo, narration, beneficiary }) {
  const token = await getToken();
  const payload = await request(config.ecobank.paths.payment, {
    token,
    body: {
      requestId: reference,
      affiliateCode: config.ecobank.affiliateCode,
      amount: (amountKobo / 100).toFixed(2),
      currency: 'NGN',
      narration,
      sourceAccountNumber: config.ecobank.sourceAccount,
      destinationAccountNumber: beneficiary.accountNumber,
      destinationAccountName: beneficiary.accountName,
      destinationBankName: beneficiary.bankName,
      destinationBankCode: beneficiary.bankCode || '',
    },
  });
  return normaliseProviderResult(payload, reference);
}

/**
 * Returns money to a contributor after a rejection or expiry.
 *
 * A reversal is expressed against the ORIGINAL collection, not as a fresh
 * transfer to a bank account. Trustock never stores a contributor's account
 * number -- the money goes back the way it came in, which is both safer and
 * the only thing we are actually able to do.
 */
async function reverse({ reference, amountKobo, narration, originalReference }) {
  const token = await getToken();
  const payload = await request(config.ecobank.paths.payment, {
    token,
    body: {
      requestId: reference,
      affiliateCode: config.ecobank.affiliateCode,
      transactionType: 'REVERSAL',
      originalRequestId: originalReference,
      amount: (amountKobo / 100).toFixed(2),
      currency: 'NGN',
      narration,
      sourceAccountNumber: config.ecobank.sourceAccount,
    },
  });
  return normaliseProviderResult(payload, reference);
}

async function getStatus(reference) {
  const token = await getToken();
  const payload = await request(config.ecobank.paths.status, {
    token,
    body: { requestId: reference, affiliateCode: config.ecobank.affiliateCode },
  });
  return normaliseProviderResult(payload, reference);
}

/**
 * Different Ecobank products word success slightly differently. We reduce the
 * response to the two things Trustock needs -- did it succeed, and what is the
 * provider's reference -- while keeping the raw payload for the audit trail.
 */
function normaliseProviderResult(payload, reference) {
  const code = String(
    payload.responseCode ?? payload.response_code ?? payload.code ?? ''
  );
  const success = ['000', '00', '0', '200'].includes(code) ||
    /^success$/i.test(String(payload.status || ''));

  return {
    success,
    providerReference:
      payload.transactionId || payload.paymentId || payload.reference || reference,
    message: payload.responseMessage || payload.message || (success ? 'Successful' : 'Failed'),
    raw: payload,
  };
}

module.exports = { collect, disburse, reverse, getStatus, _request: request };
