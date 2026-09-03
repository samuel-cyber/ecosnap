// scripts/seed.js
//
// Builds the demo dataset described in the Trustock brief: one supplier with a
// clean track record, one whose payout account was changed after people had
// already paid in, and two pools sitting at 80% funded so the "final
// participant pays" moment can be shown live.
//
// EVERYTHING THIS SCRIPT CREATES IS SYNTHETIC DEMO DATA. The accounts, bank
// details and transaction history below are invented for demonstration. No
// real person, business or bank account is represented here, and in simulated
// mode no real money has moved.
//
// Usage:  npm run seed          (refuses to run if the database already has data)
//         npm run seed -- --reset   (wipes every table first)

const bcrypt = require('bcryptjs');
const db = require('../src/config/db');
const { nairaToKobo } = require('../src/lib/money');

const RESET = process.argv.includes('--reset');
const DEMO_PASSWORD = 'trustock123';

const TABLES = [
  'audit_log', 'refunds', 'settlements', 'reviews', 'risk_assessments',
  'contributions', 'pool_members', 'pool_state_transitions', 'pools',
  'supplier_account_history', 'suppliers', 'users',
];

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function main() {
  const { rows: existing } = await db.query('select count(*)::int as count from users');

  if (existing[0].count > 0 && !RESET) {
    console.error(
      'The database already contains data. Re-run with --reset to wipe it and reseed:\n' +
      '  npm run seed -- --reset'
    );
    process.exit(1);
  }

  if (RESET) {
    console.log('Wiping all tables...');
    await db.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // -------------------------------------------------------------------------
  // People (synthetic)
  // -------------------------------------------------------------------------
  const people = [
    ['amara@trustock.demo', 'Amara Okonkwo', 'Amara Thrift Store', '+2348030000001', 'entrepreneur', 60],
    ['tunde@trustock.demo', 'Tunde Balogun', 'TB Streetwear', '+2348030000002', 'entrepreneur', 58],
    ['zainab@trustock.demo', 'Zainab Yusuf', 'Zee Fabrics', '+2348030000003', 'entrepreneur', 55],
    ['chidi@trustock.demo', 'Chidi Nwosu', 'Campus Kicks', '+2348030000004', 'entrepreneur', 50],
    ['ifeoma@trustock.demo', 'Ifeoma Eze', 'Ify Accessories', '+2348030000005', 'entrepreneur', 45],
    ['reviewer@trustock.demo', 'Ngozi Adeyemi', 'Trustock Risk Desk', '+2348030000099', 'reviewer', 90],
  ];

  const users = {};
  for (const [email, fullName, business, phone, role, ageDays] of people) {
    const { rows } = await db.query(
      `insert into users (email, password_hash, full_name, business_name, phone, role, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [email, passwordHash, fullName, business, phone, role, daysAgo(ageDays)]
    );
    users[email] = rows[0];
  }

  const amara = users['amara@trustock.demo'];
  const members = people.slice(0, 5).map(([email]) => users[email]);

  // -------------------------------------------------------------------------
  // Suppliers (synthetic)
  // -------------------------------------------------------------------------
  async function createSupplier(supplier, createdAt) {
    const { rows } = await db.query(
      `insert into suppliers (name, phone, email, bank_name, account_number, account_name, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning *`,
      [supplier.name, supplier.phone, supplier.email, supplier.bank_name,
       supplier.account_number, supplier.account_name, amara.id, createdAt]
    );
    await db.query(
      `insert into supplier_account_history (supplier_id, bank_name, account_number, account_name, changed_by, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [rows[0].id, supplier.bank_name, supplier.account_number, supplier.account_name, amara.id, createdAt]
    );
    return rows[0];
  }

  const abc = await createSupplier({
    name: 'ABC Wholesale Ltd',
    phone: '+2348020000010',
    email: 'sales@abcwholesale.demo',
    bank_name: 'Ecobank Nigeria',
    account_number: '2019283746',
    account_name: 'ABC Wholesale Limited',
  }, daysAgo(40));

  const balesDirect = await createSupplier({
    name: 'Bales Direct Nigeria',
    phone: '+2348020000020',
    email: 'orders@balesdirect.demo',
    bank_name: 'Ecobank Nigeria',
    account_number: '3057712398',
    account_name: 'Bales Direct Nigeria Ltd',
  }, daysAgo(35));

  // -------------------------------------------------------------------------
  // A completed pool in the past. It gives the platform a size baseline and
  // gives ABC Wholesale the settled history the risk engine looks for.
  // -------------------------------------------------------------------------
  async function createPool({ reference, title, description, supplier, target, contribution, participants, status, createdAt, deadline }) {
    const { rows } = await db.query(
      `insert into pools (reference, title, description, creator_id, supplier_id,
                          target_amount_kobo, contribution_amount_kobo, max_participants,
                          deadline, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning *`,
      [reference, title, description, amara.id, supplier.id, nairaToKobo(target),
       nairaToKobo(contribution), participants, deadline, status, createdAt]
    );
    return rows[0];
  }

  const pastPool = await createPool({
    reference: 'TS-DEMO0HIST',
    title: 'Ankara wax print - 40 yard bundle',
    description: 'Completed pool from last month. Kept so the platform has a real settled history to compare against.',
    supplier: abc,
    target: '120000',
    contribution: '30000',
    participants: 4,
    status: 'COMPLETED',
    createdAt: daysAgo(30),
    deadline: daysAgo(24),
  });

  for (let i = 0; i < 4; i += 1) {
    const member = members[i];
    await db.query(
      `insert into pool_members (pool_id, user_id, committed_amount_kobo, status, joined_at)
       values ($1, $2, $3, 'PAID', $4)`,
      [pastPool.id, member.id, nairaToKobo('30000'), daysAgo(29)]
    );
    await db.query(
      `insert into contributions (pool_id, user_id, amount_kobo, status, provider_reference, mode, idempotency_key, created_at, paid_at)
       values ($1, $2, $3, 'PAID', $4, 'simulated', $5, $6, $6)`,
      [pastPool.id, member.id, nairaToKobo('30000'), `SIM-COL-HIST${i}`,
       `seed-hist-${i}`, daysAgo(28 - i * 0.2)]
    );
  }

  await db.query(
    `insert into settlements (pool_id, supplier_id, amount_kobo, status, provider_reference, mode, created_at, completed_at)
     values ($1, $2, $3, 'COMPLETED', 'SIM-PAY-HISTORY01', 'simulated', $4, $4)`,
    [pastPool.id, abc.id, nairaToKobo('120000'), daysAgo(27)]
  );

  for (const [from, to, reason, at] of [
    [null, 'CREATED', 'Pool created', daysAgo(30)],
    ['CREATED', 'FUNDING', 'First contribution received', daysAgo(28)],
    ['FUNDING', 'MOQ_REACHED', 'Minimum order quantity funded in full', daysAgo(28)],
    ['MOQ_REACHED', 'RISK_REVIEW', 'Risk assessment run: LOW', daysAgo(28)],
    ['RISK_REVIEW', 'APPROVED', 'Low risk -- cleared for settlement automatically', daysAgo(28)],
    ['APPROVED', 'SETTLEMENT', 'Approved pool sent for settlement', daysAgo(27)],
    ['SETTLEMENT', 'COMPLETED', 'Supplier paid, pool complete', daysAgo(27)],
  ]) {
    await db.query(
      `insert into pool_state_transitions (pool_id, from_status, to_status, actor_id, reason, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [pastPool.id, from, to, amara.id, reason, at]
    );
  }

  // -------------------------------------------------------------------------
  // Demo pool 1 -- the clean path. 80% funded, waiting on the last member.
  // -------------------------------------------------------------------------
  async function fundPool(pool, contributionNaira, paidCount, startedHoursAgo) {
    for (let i = 0; i < members.length; i += 1) {
      await db.query(
        `insert into pool_members (pool_id, user_id, committed_amount_kobo, status, joined_at)
         values ($1, $2, $3, $4, $5)`,
        [pool.id, members[i].id, nairaToKobo(contributionNaira),
         i < paidCount ? 'PAID' : 'JOINED', hoursAgo(startedHoursAgo)]
      );
      if (i < paidCount) {
        await db.query(
          `insert into contributions (pool_id, user_id, amount_kobo, status, provider_reference, mode, idempotency_key, created_at, paid_at)
           values ($1, $2, $3, 'PAID', $4, 'simulated', $5, $6, $6)`,
          [pool.id, members[i].id, nairaToKobo(contributionNaira),
           `SIM-COL-${pool.reference}-${i}`, `seed-${pool.reference}-${i}`,
           hoursAgo(startedHoursAgo - i * 2)]
        );
      }
    }
  }

  const cleanPool = await createPool({
    reference: 'TS-DEMO0CLEAN',
    title: 'Vintage bale - grade A mixed',
    description: 'Five campus sellers pooling to hit ABC Wholesale\'s 250k minimum order.',
    supplier: abc,
    target: '250000',
    contribution: '50000',
    participants: 5,
    status: 'FUNDING',
    createdAt: daysAgo(3),
    deadline: daysAhead(4),
  });
  await fundPool(cleanPool, '50000', 4, 40);

  for (const [from, to, reason, at] of [
    [null, 'CREATED', 'Pool created', daysAgo(3)],
    ['CREATED', 'FUNDING', 'First contribution received', hoursAgo(40)],
  ]) {
    await db.query(
      `insert into pool_state_transitions (pool_id, from_status, to_status, actor_id, reason, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [cleanPool.id, from, to, amara.id, reason, at]
    );
  }

  // -------------------------------------------------------------------------
  // Demo pool 2 -- the safety path. Same setup, except the supplier's payout
  // account was changed AFTER members had already paid in. This is the case
  // Trustock exists to catch.
  // -------------------------------------------------------------------------
  const flaggedPool = await createPool({
    reference: 'TS-DEMO0RISK',
    title: 'Sneaker bale - 60 pair mixed',
    description: 'Same five sellers, different wholesaler. The payout account on this supplier changed after funding started.',
    supplier: balesDirect,
    target: '250000',
    contribution: '50000',
    participants: 5,
    status: 'FUNDING',
    createdAt: daysAgo(2),
    deadline: daysAhead(5),
  });
  await fundPool(flaggedPool, '50000', 4, 30);

  for (const [from, to, reason, at] of [
    [null, 'CREATED', 'Pool created', daysAgo(2)],
    ['CREATED', 'FUNDING', 'First contribution received', hoursAgo(30)],
  ]) {
    await db.query(
      `insert into pool_state_transitions (pool_id, from_status, to_status, actor_id, reason, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [flaggedPool.id, from, to, amara.id, reason, at]
    );
  }

  // The change itself: same supplier name, brand new destination account, in
  // a personal name. Recorded exactly as a real edit would be.
  const changedAt = hoursAgo(2);
  await db.query(
    `update suppliers
        set bank_name = 'Zenith Bank', account_number = '1188776655',
            account_name = 'E. J. Nwachukwu', updated_at = $2
      where id = $1`,
    [balesDirect.id, changedAt]
  );
  await db.query(
    `insert into supplier_account_history (supplier_id, bank_name, account_number, account_name, changed_by, created_at)
     values ($1, 'Zenith Bank', '1188776655', 'E. J. Nwachukwu', $2, $3)`,
    [balesDirect.id, amara.id, changedAt]
  );
  await db.query(
    `insert into audit_log (actor_id, action, entity_type, entity_id, metadata, created_at)
     values ($1, 'supplier.account_changed', 'supplier', $2, $3, $4)`,
    [amara.id, balesDirect.id, {
      from: { bank_name: 'Ecobank Nigeria', account_number: '3057712398', account_name: 'Bales Direct Nigeria Ltd' },
      to: { bank_name: 'Zenith Bank', account_number: '1188776655', account_name: 'E. J. Nwachukwu' },
      seeded: true,
    }, changedAt]
  );

  await db.query(
    `insert into audit_log (actor_type, action, entity_type, metadata)
     values ('system', 'demo.seeded', 'system', $1)`,
    [{ note: 'Synthetic demo data. No real people, businesses or bank accounts.' }]
  );

  console.log(`
Trustock demo data ready.  ALL OF IT IS SYNTHETIC.

  Sign in with any of these (password: ${DEMO_PASSWORD})
    amara@trustock.demo      Amara Okonkwo    - organiser, has paid
    tunde@trustock.demo      Tunde Balogun    - has paid
    zainab@trustock.demo     Zainab Yusuf     - has paid
    chidi@trustock.demo      Chidi Nwosu      - has paid
    ifeoma@trustock.demo     Ifeoma Eze       - HAS NOT PAID  <- pay as her
    reviewer@trustock.demo   Ngozi Adeyemi    - Trustock reviewer

  ${cleanPool.reference}  "${cleanPool.title}"
      200,000 / 250,000 funded. Clean supplier with settled history.
      Expected outcome: LOW risk -> settles.

  ${flaggedPool.reference}  "${flaggedPool.title}"
      200,000 / 250,000 funded. Supplier payout account was changed 2 hours
      ago, after members had already paid.
      Expected outcome: HIGH risk -> payout paused for review.

  Sign in as ifeoma@trustock.demo, pay the last 50,000 into either pool, and
  run the risk assessment.
`);

  await db.pool.end();
}

main().catch(async (error) => {
  console.error('Seed failed:', error.message);
  console.error(error.stack);
  process.exit(1);
});
