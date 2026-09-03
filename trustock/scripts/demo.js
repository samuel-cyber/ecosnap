// scripts/demo.js
//
// Walks the entire Trustock workflow against a running server and prints what
// happens at each step. Useful for a terminal demo, and as a smoke test that
// the whole path still works after a change.
//
//   npm start          # in one terminal
//   npm run seed -- --reset
//   npm run demo
//
// It runs against whatever ECOBANK_MODE the server is in, and prints that mode
// before it moves any money.

const BASE = process.env.DEMO_BASE_URL || 'http://localhost:4000';
const PASSWORD = 'trustock123';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload.error || 'failed'}`);
  }
  return payload;
}

const login = (email) => call('POST', '/auth/login', { body: { email, password: PASSWORD } });

function step(n, title) {
  console.log(`\n${c.bold(`${n}. ${title}`)}`);
  console.log(c.dim('   ' + '-'.repeat(title.length + 3)));
}

function riskSummary(assessment) {
  const colour = { LOW: c.green, MEDIUM: c.yellow, HIGH: c.red }[assessment.level];
  console.log(`   ${colour(`${assessment.level} RISK`)} — score ${assessment.score}/100 (${assessment.decision})`);
  if (assessment.level_note) console.log(c.dim(`   ${assessment.level_note}`));

  for (const signal of assessment.signals) {
    console.log(`     ${signal.weight > 0 ? c.red(`+${signal.weight}`) : c.green(String(signal.weight))}  ${signal.label}`);
    const e = signal.evidence || {};
    if (e.previous_account && e.current_account) {
      console.log(c.dim(`          was: ${e.previous_account.account_name} / ${e.previous_account.account_number} (${e.previous_account.bank_name})`));
      console.log(c.red(`          now: ${e.current_account.account_name} / ${e.current_account.account_number} (${e.current_account.bank_name})`));
    }
  }
  for (const check of assessment.checks_passed || []) {
    console.log(c.dim(`      ${c.green('ok')}  ${check.label}`));
  }
  console.log(c.dim(`\n   ${assessment.disclaimer}`));
}

async function main() {
  console.log(c.bold('\nTRUSTOCK — end-to-end workflow demo'));

  const integration = await call('GET', '/system/integration');
  const provider = integration.provider;
  console.log(
    provider.simulated
      ? c.yellow(`\n${provider.notice}`)
      : c.green(`\n${provider.notice}`)
  );

  const [ifeoma, amara, reviewer] = await Promise.all([
    login('ifeoma@trustock.demo'),
    login('amara@trustock.demo'),
    login('reviewer@trustock.demo'),
  ]);

  const { pools } = await call('GET', '/pools', { token: ifeoma.token });
  const clean = pools.find((p) => p.reference === 'TS-DEMO0CLEAN');
  const flagged = pools.find((p) => p.reference === 'TS-DEMO0RISK');

  if (!clean || !flagged) {
    throw new Error('Demo pools not found. Run: npm run seed -- --reset');
  }

  // -------------------------------------------------------------- clean path
  console.log(c.cyan('\n\n=== PATH A: the transaction that clears ==='));

  step(1, `Pool ${clean.reference} — "${clean.title}"`);
  console.log(`   ${clean.funding.funded_amount_display} / ${clean.funding.target_amount_display} (${clean.funding.percent_funded}%)`);
  console.log(`   Supplier: ${clean.supplier.name} · ${clean.supplier.account_name} · ${clean.supplier.account_number}`);

  step(2, 'The last member pays her share');
  const paid = await call('POST', `/pools/${clean.id}/contribute`, {
    token: ifeoma.token, body: { idempotency_key: `demo-clean-${Date.now()}` },
  });
  console.log(`   ${paid.contribution.amount_display} ${paid.contribution.status} · ref ${paid.contribution.provider_reference} · ${c.yellow(paid.contribution.mode)}`);
  console.log(`   ${paid.pool.funding.funded_amount_display} / ${paid.pool.funding.target_amount_display} — ${c.green(paid.pool_status)}`);

  step(3, 'Trustock assesses the supplier and the transaction');
  const cleanRisk = await call('POST', `/pools/${clean.id}/risk-assessment`, { token: ifeoma.token });
  riskSummary(cleanRisk.assessment);
  console.log(`   Pool is now ${c.green(cleanRisk.pool_status)}`);

  step(4, 'Settlement — released by the pool organiser');
  const settled = await call('POST', `/pools/${clean.id}/settle`, { token: amara.token });
  console.log(`   ${settled.settlement.amount_display} to ${clean.supplier.account_name}`);
  console.log(`   ${settled.settlement.status} · ref ${settled.settlement.provider_reference} · ${c.yellow(settled.settlement.mode)}`);
  console.log(`   Pool is now ${c.green(settled.pool.status)}`);

  // ------------------------------------------------------------ flagged path
  console.log(c.cyan('\n\n=== PATH B: the transaction Trustock exists to stop ==='));

  step(5, `Pool ${flagged.reference} — "${flagged.title}"`);
  console.log(`   ${flagged.funding.funded_amount_display} / ${flagged.funding.target_amount_display} (${flagged.funding.percent_funded}%)`);
  console.log(`   Supplier: ${flagged.supplier.name} · ${flagged.supplier.account_name} · ${flagged.supplier.account_number}`);
  console.log(c.dim('   (this supplier\'s payout account was changed after members had already paid)'));

  step(6, 'The last member pays her share');
  const paid2 = await call('POST', `/pools/${flagged.id}/contribute`, {
    token: ifeoma.token, body: { idempotency_key: `demo-risk-${Date.now()}` },
  });
  console.log(`   ${paid2.pool.funding.funded_amount_display} / ${paid2.pool.funding.target_amount_display} — ${c.green(paid2.pool_status)}`);

  step(7, 'Trustock assesses the supplier and the transaction');
  const risk = await call('POST', `/pools/${flagged.id}/risk-assessment`, { token: ifeoma.token });
  riskSummary(risk.assessment);
  console.log(`\n   ${c.red('PAYOUT PAUSED')} — pool is ${risk.pool_status}, review required`);

  step(8, 'Settlement is attempted anyway');
  try {
    await call('POST', `/pools/${flagged.id}/settle`, { token: reviewer.token });
    console.log(c.red('   It went through. That is a bug.'));
  } catch (error) {
    console.log(`   ${c.green('Refused:')} ${error.message.split(': ').pop()}`);
  }

  step(9, 'A reviewer looks at the evidence and rejects it');
  const rejected = await call('POST', `/pools/${flagged.id}/review`, {
    token: reviewer.token,
    body: {
      decision: 'REJECTED',
      notes: 'Called the supplier on the number on file. They confirmed the Zenith account is not theirs.',
    },
  });
  console.log(`   Pool is now ${c.red(rejected.pool_status)}`);

  step(10, 'Every contributor is refunded');
  const refunded = await call('POST', `/pools/${flagged.id}/refund`, { token: reviewer.token, body: {} });
  for (const refund of refunded.refunds) {
    console.log(`   ${refund.recipient_name.padEnd(18)} ${refund.amount_display.padStart(13)}  ${refund.status}  ${c.yellow(refund.mode)}`);
  }
  const total = refunded.refunds.reduce((sum, r) => sum + r.amount_kobo, 0);
  console.log(`   ${c.bold('Total returned:')} ₦${(total / 100).toLocaleString('en-NG')}`);
  console.log(`   Pool is now ${c.green(refunded.pool_status)}`);

  // ------------------------------------------------------------------ ledger
  step(11, 'Ifeoma\'s transaction history');
  const { transactions } = await call('GET', '/transactions', { token: ifeoma.token });
  for (const entry of transactions.slice(0, 8)) {
    const sign = entry.direction === 'in' ? c.green('+') : '−';
    console.log(
      `   ${entry.type.padEnd(13)} ${sign}${entry.amount_display.padStart(13)}  ` +
      `${entry.status.padEnd(10)} ${entry.simulated ? c.yellow('SIMULATED') : c.green('LIVE')}  ${entry.pool_reference}`
    );
  }

  console.log(c.bold('\n\nDone.'));
  if (provider.simulated) {
    console.log(c.yellow('Reminder: every movement above was simulated. No real funds moved.\n'));
  }
}

main().catch((error) => {
  console.error(c.red(`\nDemo failed: ${error.message}`));
  console.error(c.dim('Is the server running (npm start) and seeded (npm run seed -- --reset)?\n'));
  process.exit(1);
});
