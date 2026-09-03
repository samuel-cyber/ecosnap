// The risk engine is pure, so it can be tested by handing it facts directly.
// These tests pin the behaviour the product is built around: a payout account
// that changed after people paid in must produce a HIGH result, and a clean
// transaction must not be flagged for the sake of looking clever.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/services/risk/rules');
const { similarity } = require('../src/lib/nameMatch');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** A pool that should raise nothing. Individual tests bend one thing at a time. */
function cleanFacts(overrides = {}) {
  return {
    now: new Date().toISOString(),
    pool: { created_at: daysAgo(3), target_amount_kobo: 25_000_000 },
    supplier: {
      name: 'ABC Wholesale Ltd',
      account_name: 'ABC Wholesale Limited',
      account_number: '2019283746',
      bank_name: 'Ecobank Nigeria',
      phone: '+2348020000010',
      email: 'sales@abcwholesale.demo',
      verification_status: 'external',
      created_at: daysAgo(40),
    },
    creator: { created_at: daysAgo(60) },
    supplierAccountHistory: [
      { bank_name: 'Ecobank Nigeria', account_number: '2019283746', account_name: 'ABC Wholesale Limited', created_at: daysAgo(40) },
    ],
    suppliersSharingAccount: [],
    supplierEditsDuringFunding: [],
    supplierCompletedSettlements: 2,
    supplierAveragePoolKobo: 20_000_000,
    platformAveragePoolKobo: 18_000_000,
    failedContributionCount: 0,
    paidContributionCount: 5,
    largestContributorPaidKobo: 5_000_000,
    fundingWindowMinutes: 2400,
    memberCount: 5,
    membersWithCompletedPools: 4,
    ...overrides,
  };
}

test('a clean transaction scores LOW and clears itself', () => {
  const result = rules.evaluate(cleanFacts());
  assert.equal(result.level, 'LOW');
  assert.equal(result.decision, 'AUTO_APPROVE');
  assert.ok(result.score < rules.MEDIUM_THRESHOLD);
});

test('a clean transaction still reports what it checked', () => {
  const result = rules.evaluate(cleanFacts());
  assert.ok(result.checks_passed.length >= 8,
    'a LOW result must show the checks that passed, not just an empty list');
  const codes = result.checks_passed.map((c) => c.code);
  assert.ok(codes.includes('ACCOUNT_UNCHANGED'));
  assert.ok(codes.includes('ACCOUNT_NAME_CONSISTENT'));
});

test('an account changed after the pool opened is the headline signal', () => {
  const facts = cleanFacts({
    supplierAccountHistory: [
      { bank_name: 'Ecobank Nigeria', account_number: '2019283746', account_name: 'ABC Wholesale Limited', created_at: daysAgo(40) },
      { bank_name: 'Zenith Bank', account_number: '1188776655', account_name: 'E. J. Nwachukwu', created_at: daysAgo(0.05) },
    ],
    supplier: { ...cleanFacts().supplier, account_name: 'E. J. Nwachukwu', account_number: '1188776655', bank_name: 'Zenith Bank' },
    supplierCompletedSettlements: 0,
    supplierAveragePoolKobo: null,
  });

  const result = rules.evaluate(facts);
  assert.equal(result.level, 'HIGH');
  assert.equal(result.decision, 'REVIEW_REQUIRED');

  const codes = result.signals.map((s) => s.code);
  assert.ok(codes.includes('ACCOUNT_CHANGED_AFTER_POOL_CREATED'));
  assert.ok(codes.includes('ACCOUNT_NAME_MISMATCH'));
});

test('every signal carries evidence and a plain-language explanation', () => {
  const facts = cleanFacts({
    supplierAccountHistory: [
      { bank_name: 'Ecobank Nigeria', account_number: '2019283746', account_name: 'ABC Wholesale Limited', created_at: daysAgo(40) },
      { bank_name: 'Zenith Bank', account_number: '1188776655', account_name: 'E. J. Nwachukwu', created_at: daysAgo(0.05) },
    ],
  });

  const result = rules.evaluate(facts);
  assert.ok(result.signals.length > 0);
  for (const signal of result.signals) {
    assert.ok(signal.code, 'signal needs a code');
    assert.ok(signal.label, 'signal needs a label');
    assert.ok(signal.explanation.length > 40, `${signal.code} needs a real explanation`);
    assert.ok(signal.evidence && Object.keys(signal.evidence).length > 0, `${signal.code} needs evidence`);
    assert.ok(['increases_risk', 'reduces_risk'].includes(signal.direction));
  }
});

test('the score breakdown adds up, so a reviewer can check it by hand', () => {
  const facts = cleanFacts({
    supplierAccountHistory: [
      { bank_name: 'Ecobank Nigeria', account_number: '2019283746', account_name: 'ABC Wholesale Limited', created_at: daysAgo(40) },
      { bank_name: 'Zenith Bank', account_number: '1188776655', account_name: 'E. J. Nwachukwu', created_at: daysAgo(0.05) },
    ],
  });
  const result = rules.evaluate(facts);
  const s = result.scoring;
  assert.equal(
    s.substantiated_weight + s.unverifiable_weight_counted + s.reducing_weight,
    result.raw_score
  );
  assert.equal(result.score, Math.max(0, Math.min(100, result.raw_score)));
  assert.equal(s.unverifiable_weight_counted, Math.min(s.unverifiable_weight, s.unverifiable_weight_cap));
});

test('being new is not the same as being suspicious', () => {
  // Everything about this pool is unknown, and nothing about it is wrong.
  const brandNew = cleanFacts({
    pool: { created_at: new Date().toISOString(), target_amount_kobo: 25_000_000 },
    supplier: { ...cleanFacts().supplier, created_at: new Date().toISOString() },
    creator: { created_at: new Date().toISOString() },
    supplierCompletedSettlements: 0,
    supplierAveragePoolKobo: null,
    platformAveragePoolKobo: null,
    membersWithCompletedPools: 0,
  });

  const result = rules.evaluate(brandNew);
  const rawSum = result.signals.reduce((total, x) => total + x.weight, 0);

  assert.ok(rawSum > rules.MEDIUM_THRESHOLD,
    'the unverifiable signals do add up to something on their own');
  assert.equal(result.scoring.unverifiable_weight_counted, rules.LOW_SEVERITY_CAP,
    'but their combined contribution is capped');
  assert.notEqual(result.level, 'HIGH',
    'an honest first purchase must never be assessed as HIGH risk');
});

test('HIGH requires a substantiated finding, not an accumulation of unknowns', () => {
  // Every low-severity signal at once, and nothing high-severity.
  const allUnknowns = cleanFacts({
    pool: { created_at: new Date().toISOString(), target_amount_kobo: 900_000_000 },
    supplier: {
      ...cleanFacts().supplier,
      created_at: new Date().toISOString(),
      phone: null,
      email: null,
    },
    creator: { created_at: new Date().toISOString() },
    supplierCompletedSettlements: 0,
    supplierAveragePoolKobo: null,
    platformAveragePoolKobo: 10_000_000,
    membersWithCompletedPools: 0,
    fundingWindowMinutes: 1,
  });

  const result = rules.evaluate(allUnknowns);
  assert.ok(!result.signals.some((s) => s.severity === 'high'));
  assert.notEqual(result.level, 'HIGH');
  if (result.level_note) assert.match(result.level_note, /could not verify|Held at MEDIUM/i);
});

test('a proven supplier reduces the score but cannot push it below zero', () => {
  const result = rules.evaluate(cleanFacts({ supplierCompletedSettlements: 9 }));
  assert.ok(result.raw_score < 0);
  assert.equal(result.score, 0);
});

test('one bank account behind several suppliers is flagged', () => {
  const result = rules.evaluate(cleanFacts({
    suppliersSharingAccount: [{ id: 'x', name: 'Totally Different Traders' }],
  }));
  assert.ok(result.signals.some((s) => s.code === 'ACCOUNT_SHARED_ACROSS_SUPPLIERS'));
});

test('a single member funding most of an even-split pool is flagged', () => {
  const result = rules.evaluate(cleanFacts({ largestContributorPaidKobo: 20_000_000 }));
  assert.ok(result.signals.some((s) => s.code === 'CONCENTRATED_FUNDING'));
});

test('repeated payment failures are flagged', () => {
  const result = rules.evaluate(cleanFacts({ failedContributionCount: 3 }));
  assert.ok(result.signals.some((s) => s.code === 'FAILED_CONTRIBUTIONS'));
});

test('the engine never claims certainty', () => {
  // The disclaimer is allowed to say the word "fraudulent" -- it says we
  // cannot prove it. The claims themselves are what must stay hedged.
  assert.match(rules.evaluate(cleanFacts()).disclaimer, /cannot prove/i);

  const overclaiming = /\b(guarantee\w*|definitely|certainly|proves?\b|confirmed fraud|is fraudulent|will be fraud)/i;

  for (const facts of [
    cleanFacts(),
    cleanFacts({ failedContributionCount: 4, largestContributorPaidKobo: 24_000_000 }),
    cleanFacts({
      suppliersSharingAccount: [{ id: 'x', name: 'Other Traders' }],
      supplierCompletedSettlements: 0,
      supplierAveragePoolKobo: null,
    }),
  ]) {
    const result = rules.evaluate(facts);
    for (const item of [...result.signals, ...result.checks_passed]) {
      assert.doesNotMatch(item.label, overclaiming, `${item.code} label overclaims`);
      assert.doesNotMatch(item.explanation, overclaiming, `${item.code} explanation overclaims`);
    }
  }
});

test('the engine is deterministic', () => {
  const facts = cleanFacts();
  assert.deepEqual(rules.evaluate(facts), rules.evaluate(facts));
});

test('business-name noise does not create false mismatches', () => {
  assert.ok(similarity('ABC Wholesale Ltd', 'ABC Wholesale Nigeria Limited') >= 0.5);
  assert.ok(similarity('Bales Direct Nigeria', 'E. J. Nwachukwu') < 0.5);
});
