// The whole product, exercised through the HTTP API against a real database:
// create, join, fund, assess, review, settle and refund.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/setup');

let organiser;
let members;
let reviewer;

test.before(async () => {
  await h.start();

  organiser = await h.register('organiser@test.local', { full_name: 'Amara Okonkwo' });
  members = [];
  for (let i = 0; i < 4; i += 1) {
    members.push(await h.register(`member${i}@test.local`, { full_name: `Member ${i}` }));
  }
  reviewer = await h.register('reviewer@test.local', { full_name: 'Risk Desk' });
  await h.makeReviewer(reviewer.user.id);
  const refreshed = await h.request('POST', '/api/auth/login', {
    body: { email: 'reviewer@test.local', password: 'password1234' },
  });
  reviewer = refreshed.body;
});

test.after(async () => { await h.stop(); });

// A distinct account per pool. Reusing one account number across supplier
// records is itself a risk signal, so the fixture must not accidentally
// create one.
let accountSeed = 2019283746;
const cleanSupplier = () => ({
  name: 'ABC Wholesale Ltd',
  bank_name: 'Ecobank Nigeria',
  account_number: String((accountSeed += 7)),
  account_name: 'ABC Wholesale Limited',
  phone: '+2348020000010',
  email: 'sales@abc.test',
});

async function createPool(token, supplier = cleanSupplier(), overrides = {}) {
  const { status, body } = await h.request('POST', '/api/pools', {
    token,
    body: {
      title: 'Vintage bale - grade A mixed',
      description: 'Five sellers reaching a 250k minimum order.',
      target_amount: '250000',
      contribution_amount: '50000',
      max_participants: 5,
      deadline: h.daysAhead(7),
      supplier,
      ...overrides,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.pool;
}

/** Everyone joins and pays; returns the pool state afterwards. */
async function fundFully(pool, { skipLast = false } = {}) {
  for (const member of members) {
    const join = await h.request('POST', `/api/pools/${pool.id}/join`, { token: member.token });
    assert.equal(join.status, 201, JSON.stringify(join.body));
  }

  const payers = skipLast
    ? [organiser, ...members.slice(0, 3)]
    : [organiser, ...members];

  let last;
  for (const payer of payers) {
    last = await h.request('POST', `/api/pools/${pool.id}/contribute`, {
      token: payer.token,
      body: { idempotency_key: `test-${pool.id}-${payer.user.id}` },
    });
    assert.equal(last.status, 201, JSON.stringify(last.body));
  }
  return last.body;
}

// ---------------------------------------------------------------------------

test('a pool funds to its MOQ and the amounts are exact', async () => {
  const pool = await createPool(organiser.token);
  assert.equal(pool.status, 'CREATED');
  assert.equal(pool.funding.target_amount_kobo, 25_000_000);

  const partial = await fundFully(pool, { skipLast: true });
  assert.equal(partial.pool.status, 'FUNDING');
  assert.equal(partial.pool.funding.funded_amount_kobo, 20_000_000);
  assert.equal(partial.pool.funding.percent_funded, 80);
  assert.equal(partial.pool.funding.moq_reached, false);

  const final = await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: members[3].token,
    body: { idempotency_key: `test-${pool.id}-last` },
  });
  assert.equal(final.status, 201);
  assert.equal(final.body.pool.status, 'MOQ_REACHED');
  assert.equal(final.body.pool.funding.funded_amount_kobo, 25_000_000);
  assert.equal(final.body.pool.funding.percent_funded, 100);
});

test('a repeated contribution request never charges twice', async () => {
  const pool = await createPool(organiser.token);
  const key = `idem-${pool.id}`;

  const first = await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: organiser.token, body: { idempotency_key: key },
  });
  const second = await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: organiser.token, body: { idempotency_key: key },
  });

  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.contribution.id, first.body.contribution.id);

  const { rows } = await h.db.query(
    "select count(*)::int as c, sum(amount_kobo)::bigint as total from contributions where pool_id = $1 and status = 'PAID'",
    [pool.id]
  );
  assert.equal(rows[0].c, 1);
  assert.equal(Number(rows[0].total), 5_000_000);
});

test('a member cannot pay their share twice', async () => {
  const pool = await createPool(organiser.token);
  await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: organiser.token, body: { idempotency_key: `dup-a-${pool.id}` },
  });
  const again = await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: organiser.token, body: { idempotency_key: `dup-b-${pool.id}` },
  });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already paid/i);
});

test('contributions never overshoot the target', async () => {
  // 6 x 50,000 could reach 300,000, but the pool only needs 250,000.
  const pool = await createPool(organiser.token, cleanSupplier(), {
    target_amount: '220000', contribution_amount: '50000', max_participants: 5,
  });
  await fundFully(pool);

  const { rows } = await h.db.query(
    "select sum(amount_kobo)::bigint as total from contributions where pool_id = $1 and status = 'PAID'",
    [pool.id]
  );
  assert.equal(Number(rows[0].total), 22_000_000, 'the last contributor pays only the remainder');
});

test('settlement is refused until the risk review has happened', async () => {
  const pool = await createPool(organiser.token);
  await fundFully(pool);

  const settle = await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });
  assert.equal(settle.status, 409);
  assert.match(settle.body.error, /approved pool/i);
});

test('a clean pool assesses LOW, settles, and completes', async () => {
  const pool = await createPool(organiser.token);
  await fundFully(pool);

  const assessment = await h.request('POST', `/api/pools/${pool.id}/risk-assessment`, { token: organiser.token });
  assert.equal(assessment.status, 201);
  assert.equal(assessment.body.assessment.level, 'LOW');
  assert.equal(assessment.body.payout_paused, false);
  assert.equal(assessment.body.pool.status, 'APPROVED');

  const settled = await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });
  assert.equal(settled.status, 201);
  assert.equal(settled.body.settlement.status, 'COMPLETED');
  assert.equal(settled.body.settlement.amount_kobo, 25_000_000);
  assert.equal(settled.body.pool.status, 'COMPLETED');

  // Settling twice must be impossible.
  const twice = await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });
  assert.equal(twice.status, 409);

  const { rows } = await h.db.query(
    "select count(*)::int as c from settlements where pool_id = $1 and status = 'COMPLETED'", [pool.id]
  );
  assert.equal(rows[0].c, 1);
});

test('a payout account changed mid-funding pauses the payout', async () => {
  const pool = await createPool(organiser.token, {
    name: 'Bales Direct Nigeria',
    bank_name: 'Ecobank Nigeria',
    account_number: '3057712398',
    account_name: 'Bales Direct Nigeria Ltd',
    phone: '+2348020000020',
    email: 'orders@bales.test',
  });

  await fundFully(pool, { skipLast: true });

  // The supplier's payout details change after members have already paid.
  const changed = await h.request('PATCH', `/api/suppliers/${pool.supplier.id}`, {
    token: organiser.token,
    body: { bank_name: 'Zenith Bank', account_number: '1188776655', account_name: 'E. J. Nwachukwu' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.account_changed, true);

  await h.request('POST', `/api/pools/${pool.id}/contribute`, {
    token: members[3].token, body: { idempotency_key: `risk-${pool.id}-last` },
  });

  const assessment = await h.request('POST', `/api/pools/${pool.id}/risk-assessment`, { token: organiser.token });
  assert.equal(assessment.body.assessment.level, 'HIGH');
  assert.equal(assessment.body.payout_paused, true);
  assert.equal(assessment.body.pool.status, 'RISK_REVIEW');

  const codes = assessment.body.assessment.signals.map((s) => s.code);
  assert.ok(codes.includes('ACCOUNT_CHANGED_AFTER_POOL_CREATED'));

  // Money must not be able to leave while the pool is paused.
  const settle = await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });
  assert.equal(settle.status, 409);

  // The organiser cannot wave through a HIGH risk payout on their own.
  const selfApprove = await h.request('POST', `/api/pools/${pool.id}/review`, {
    token: organiser.token, body: { decision: 'APPROVED' },
  });
  assert.equal(selfApprove.status, 403);
  assert.match(selfApprove.body.error, /reviewer/i);

  // A reviewer rejects it, and every contributor gets their money back.
  const rejected = await h.request('POST', `/api/pools/${pool.id}/review`, {
    token: reviewer.token,
    body: { decision: 'REJECTED', notes: 'Supplier confirmed the Zenith account is not theirs.' },
  });
  assert.equal(rejected.body.pool_status, 'REJECTED');

  const refunded = await h.request('POST', `/api/pools/${pool.id}/refund`, {
    token: reviewer.token, body: {},
  });
  assert.equal(refunded.body.pool_status, 'REFUNDED');
  assert.equal(refunded.body.refunds.length, 5);

  const { rows } = await h.db.query(
    `select
       (select coalesce(sum(amount_kobo),0)::bigint from refunds where pool_id = $1 and status = 'COMPLETED') as refunded,
       (select count(*)::int from contributions where pool_id = $1 and status = 'PAID') as still_paid`,
    [pool.id]
  );
  assert.equal(Number(rows[0].refunded), 25_000_000, 'every kobo collected must be returned');
  assert.equal(rows[0].still_paid, 0);
});

test('a reviewer can approve a flagged pool and it then settles', async () => {
  const pool = await createPool(organiser.token, {
    name: 'Kano Textiles',
    bank_name: 'Ecobank Nigeria',
    account_number: '4455667788',
    account_name: 'Musa A. Ibrahim',   // name mismatch -> flagged, not HIGH
  });
  await fundFully(pool);

  const assessment = await h.request('POST', `/api/pools/${pool.id}/risk-assessment`, { token: organiser.token });
  assert.notEqual(assessment.body.assessment.level, 'LOW');
  assert.equal(assessment.body.pool.status, 'RISK_REVIEW');

  const approved = await h.request('POST', `/api/pools/${pool.id}/review`, {
    token: reviewer.token,
    body: { decision: 'APPROVED', notes: 'Confirmed by phone: sole trader, account is in the owner\'s name.' },
  });
  assert.equal(approved.body.pool_status, 'APPROVED');

  const settled = await h.request('POST', `/api/pools/${pool.id}/settle`, { token: reviewer.token });
  assert.equal(settled.body.pool.status, 'COMPLETED');
});

test('every money movement records whether it was live or simulated', async () => {
  const pool = await createPool(organiser.token);
  await fundFully(pool);
  await h.request('POST', `/api/pools/${pool.id}/risk-assessment`, { token: organiser.token });
  await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });

  const history = await h.request('GET', '/api/transactions', { token: organiser.token });
  assert.ok(history.body.transactions.length > 0);
  for (const entry of history.body.transactions) {
    assert.ok(['live', 'simulated'].includes(entry.mode), 'every entry must state its mode');
    assert.equal(entry.simulated, true, 'these tests run against the simulator');
  }

  const integration = await h.request('GET', '/api/system/integration');
  assert.equal(integration.body.provider.simulated, true);
  assert.equal(integration.body.provider.verified, false);
  assert.match(integration.body.provider.notice, /No real funds moved/i);
});

test('the pool lifecycle is written down as it happens', async () => {
  const pool = await createPool(organiser.token);
  await fundFully(pool);
  await h.request('POST', `/api/pools/${pool.id}/risk-assessment`, { token: organiser.token });
  await h.request('POST', `/api/pools/${pool.id}/settle`, { token: organiser.token });

  const detail = await h.request('GET', `/api/pools/${pool.id}`, { token: organiser.token });
  const states = detail.body.timeline.map((t) => t.to_status);
  assert.deepEqual(states, [
    'CREATED', 'FUNDING', 'MOQ_REACHED', 'RISK_REVIEW', 'APPROVED', 'SETTLEMENT', 'COMPLETED',
  ]);

  const actions = detail.body.audit_trail.map((a) => a.action);
  assert.ok(actions.includes('pool.created'));
  assert.ok(actions.includes('risk.assessed'));
  assert.ok(actions.filter((a) => a === 'pool.status_changed').length >= 6);
});
