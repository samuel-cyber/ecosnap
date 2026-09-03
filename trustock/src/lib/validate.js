// src/lib/validate.js
// Small hand-rolled validators. Routes call these so that a bad request is
// rejected with a clear message before any service or database work happens.

const { badRequest } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireFields(body, fields) {
  const source = body || {};
  const missing = fields.filter((field) => {
    const value = source[field];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw badRequest(`Missing required field(s): ${missing.join(', ')}`, { missing });
  }
  return source;
}

function assertUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest(`${label} must be a valid UUID`);
  }
  return value;
}

function assertEmail(value) {
  const email = String(value).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is required');
  return email;
}

function assertString(value, label, { min = 1, max = 500 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max) {
    throw badRequest(`${label} must be between ${min} and ${max} characters`);
  }
  return text;
}

function optionalString(value, label, options) {
  if (value === undefined || value === null || value === '') return null;
  return assertString(value, label, options);
}

function assertInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${label} must be a whole number between ${min} and ${max}`);
  }
  return number;
}

/** Accepts naira as a number or string and returns integer kobo. */
function assertMoneyKobo(value, label) {
  const { nairaToKobo } = require('./money');
  try {
    const kobo = nairaToKobo(value);
    if (kobo <= 0) throw new Error('not positive');
    return kobo;
  } catch {
    throw badRequest(`${label} must be a positive amount in naira with at most 2 decimal places`);
  }
}

function assertFutureDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} must be a valid date`);
  if (date.getTime() <= Date.now()) throw badRequest(`${label} must be in the future`);
  return date;
}

/** Digits only, 10 for NUBAN. Kept lenient enough for other Ecobank markets. */
function assertAccountNumber(value) {
  const digits = String(value).replace(/\s/g, '');
  if (!/^\d{8,20}$/.test(digits)) {
    throw badRequest('Account number must be 8-20 digits');
  }
  return digits;
}

module.exports = {
  UUID_RE,
  requireFields,
  assertUuid,
  assertEmail,
  assertString,
  optionalString,
  assertInteger,
  assertMoneyKobo,
  assertFutureDate,
  assertAccountNumber,
};
