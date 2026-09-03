// tests/helpers/setup.js
//
// Boots the real application against a real PostgreSQL database. These are
// not mocked tests: a payment workflow that has only ever been exercised
// against fakes has not been tested at all.
//
// Point TEST_DATABASE_URL at a throwaway database -- the helper truncates
// every table before each file runs.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://trustock:trustock@127.0.0.1:5432/trustock_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-anywhere-real';
process.env.ECOBANK_MODE = 'simulated';
process.env.SIMULATOR_LATENCY_MS = '0';

const fs = require('fs');
const path = require('path');
const db = require('../../src/config/db');
const app = require('../../src/app');

const TABLES = [
  'audit_log', 'refunds', 'settlements', 'reviews', 'risk_assessments',
  'contributions', 'pool_members', 'pool_state_transitions', 'pools',
  'supplier_account_history', 'suppliers', 'users',
];

let server;
let baseUrl;

async function start() {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
  await db.pool.query(schema);
  await db.pool.query(`truncate ${TABLES.join(', ')} restart identity cascade`);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.pool.end();
}

/** Thin fetch wrapper that returns { status, body } instead of throwing. */
async function request(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Registers a user and returns { token, user }. */
async function register(email, overrides = {}) {
  const { body } = await request('POST', '/api/auth/register', {
    body: {
      email,
      password: 'password1234',
      full_name: overrides.full_name || email.split('@')[0],
      business_name: overrides.business_name,
      phone: overrides.phone,
    },
  });
  return body;
}

/** Promotes a user to reviewer -- the API deliberately offers no way to do this. */
async function makeReviewer(userId) {
  await db.query("update users set role = 'reviewer' where id = $1", [userId]);
}

const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();

module.exports = { start, stop, request, register, makeReviewer, db, daysAhead, TABLES };
