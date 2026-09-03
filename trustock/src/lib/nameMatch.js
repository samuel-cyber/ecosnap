// src/lib/nameMatch.js
// Compares a supplier's business name with the name on their bank account.
//
// "ABC Wholesale Ltd" paying into an account called "ABC Wholesale Nigeria" is
// ordinary. The same supplier paying into "Chinedu J Okafor" is worth a human
// look. This module turns that judgement into a number the risk engine can
// explain.

// Words that carry no identifying information in Nigerian business names.
const NOISE_WORDS = new Set([
  'LTD', 'LIMITED', 'PLC', 'ENTERPRISE', 'ENTERPRISES', 'VENTURES', 'VENTURE',
  'NIG', 'NIGERIA', 'NIGERIAN', 'GLOBAL', 'INTERNATIONAL', 'INTL', 'COMPANY',
  'CO', 'AND', 'THE', 'STORES', 'STORE', 'TRADING', 'TRADERS', 'GENERAL',
  'MERCHANT', 'MERCHANTS', 'CONCEPT', 'CONCEPTS', 'GROUP', 'SONS', 'BROTHERS',
]);

function tokenise(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !NOISE_WORDS.has(token));
}

/**
 * Returns 0..1: the share of the smaller name's meaningful words that also
 * appear in the larger one. Containment rather than exact equality, so a
 * longer legal name still matches its trading name.
 */
function similarity(a, b) {
  const left = new Set(tokenise(a));
  const right = new Set(tokenise(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

module.exports = { similarity, tokenise, NOISE_WORDS };
