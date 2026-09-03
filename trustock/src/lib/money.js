// src/lib/money.js
// Amounts live as integers in kobo everywhere inside Trustock. These helpers
// are the only place naira <-> kobo conversion is allowed to happen, so a
// rounding mistake can only ever exist in one file.

const KOBO_PER_NAIRA = 100;

/** Naira (number or numeric string, max 2 decimals) -> integer kobo. */
function nairaToKobo(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(`Invalid naira amount: ${value}`);
  }
  const [whole, fraction = ''] = text.split('.');
  const paddedFraction = fraction.padEnd(2, '0');
  return Number(whole) * KOBO_PER_NAIRA + Number(paddedFraction);
}

/** Integer kobo -> naira as a plain number (for JSON responses). */
function koboToNaira(kobo) {
  return Number(BigInt(kobo)) / KOBO_PER_NAIRA;
}

/** Integer kobo -> "₦250,000.00" for display. */
function formatNaira(kobo) {
  const negative = BigInt(kobo) < 0n;
  const absolute = negative ? -BigInt(kobo) : BigInt(kobo);
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${grouped}.${fraction}`;
}

/**
 * Percentage funded, rounded down so the UI never shows "100%" for a pool
 * that is one kobo short.
 */
function percentOf(partKobo, wholeKobo) {
  const whole = BigInt(wholeKobo);
  if (whole === 0n) return 0;
  const pct = (BigInt(partKobo) * 100n) / whole;
  return Number(pct > 100n ? 100n : pct);
}

module.exports = { KOBO_PER_NAIRA, nairaToKobo, koboToNaira, formatNaira, percentOf };
