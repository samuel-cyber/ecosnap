// src/config/env.js
// One place that reads process.env, validates it, and hands the rest of the
// app plain values. Nothing else in the codebase touches process.env.

require('dotenv').config({ quiet: true });

function required(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV || 'development';

// The Ecobank adapter runs in exactly one of two modes and always says which.
// 'live' is only allowed when real credentials are present -- we never let a
// misconfiguration silently look like a real integration.
const ecobankMode = (process.env.ECOBANK_MODE || 'simulated').toLowerCase();
if (!['live', 'simulated'].includes(ecobankMode)) {
  throw new Error("ECOBANK_MODE must be 'live' or 'simulated'");
}

const config = {
  nodeEnv,
  port: Number(process.env.PORT || 4000),
  databaseUrl: required(
    'DATABASE_URL',
    nodeEnv === 'test' ? 'postgres://trustock:trustock@127.0.0.1:5432/trustock_test' : undefined
  ),
  jwtSecret: required(
    'JWT_SECRET',
    nodeEnv === 'production' ? undefined : 'dev-only-insecure-secret-change-me'
  ),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  ecobank: {
    mode: ecobankMode,
    baseUrl: process.env.ECOBANK_BASE_URL || '',
    labId: process.env.ECOBANK_LAB_ID || '',
    username: process.env.ECOBANK_USERNAME || '',
    password: process.env.ECOBANK_PASSWORD || '',
    affiliateCode: process.env.ECOBANK_AFFILIATE_CODE || 'ENG',
    sourceAccount: process.env.ECOBANK_SOURCE_ACCOUNT || '',
    // Endpoint paths are configuration, not code. The InnovateX Ecobank
    // documentation is the source of truth for these -- see
    // src/services/ecobank/client.js for why they are not hard-coded.
    paths: {
      token: process.env.ECOBANK_PATH_TOKEN || '/user/token',
      payment: process.env.ECOBANK_PATH_PAYMENT || '/merchant/payment',
      collection: process.env.ECOBANK_PATH_COLLECTION || '/merchant/collection',
      status: process.env.ECOBANK_PATH_STATUS || '/merchant/transactionstatus',
    },
    timeoutMs: Number(process.env.ECOBANK_TIMEOUT_MS || 15000),
  },
};

// Guard rail: refuse to claim 'live' without the credentials that make it live.
if (config.ecobank.mode === 'live') {
  const missing = ['baseUrl', 'labId', 'username', 'password', 'sourceAccount']
    .filter((key) => !config.ecobank[key]);
  if (missing.length > 0) {
    throw new Error(
      `ECOBANK_MODE=live but missing credentials: ${missing.join(', ')}. ` +
      'Trustock will not pretend a live integration exists -- set them or use ECOBANK_MODE=simulated.'
    );
  }
}

module.exports = config;
