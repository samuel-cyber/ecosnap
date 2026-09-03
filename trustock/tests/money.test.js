// Money is the one thing that must be exactly right, so it gets its own tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { nairaToKobo, koboToNaira, formatNaira, percentOf } = require('../src/lib/money');

test('naira strings convert to exact integer kobo', () => {
  assert.equal(nairaToKobo('250000'), 25_000_000);
  assert.equal(nairaToKobo('50000.50'), 5_000_050);
  assert.equal(nairaToKobo('0.01'), 1);
  assert.equal(nairaToKobo(1999.99), 199_999);
});

test('the classic float error cannot happen through nairaToKobo', () => {
  // 0.1 + 0.2 === 0.30000000000000004 in floating point. In kobo it is 30.
  assert.equal(nairaToKobo('0.10') + nairaToKobo('0.20'), 30);
});

test('malformed amounts are rejected rather than coerced', () => {
  for (const bad of ['', 'abc', '-100', '1.234', '1e5', '₦500', null, undefined, {}]) {
    assert.throws(() => nairaToKobo(bad), `${String(bad)} should be rejected`);
  }
});

test('kobo formats as naira for display', () => {
  assert.equal(formatNaira(25_000_000), '₦250,000.00');
  assert.equal(formatNaira(5_000_050), '₦50,000.50');
  assert.equal(formatNaira(0), '₦0.00');
  assert.equal(formatNaira(-5_000), '-₦50.00');
});

test('koboToNaira round-trips', () => {
  assert.equal(koboToNaira(nairaToKobo('250000')), 250000);
  assert.equal(koboToNaira(nairaToKobo('50000.50')), 50000.5);
});

test('funding percentage rounds down and never exceeds 100', () => {
  assert.equal(percentOf(20_000_000, 25_000_000), 80);
  assert.equal(percentOf(25_000_000, 25_000_000), 100);
  assert.equal(percentOf(30_000_000, 25_000_000), 100);
  assert.equal(percentOf(0, 25_000_000), 0);
  // One kobo short must not display as 100%.
  assert.equal(percentOf(24_999_999, 25_000_000), 99);
});
