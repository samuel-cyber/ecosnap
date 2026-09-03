// src/services/settlementService.js
//
// Money out. Two paths:
//   settle()  -- an approved pool pays the supplier
//   refund()  -- a rejected, expired or cancelled pool returns every kobo it
//                collected to the people who paid it
//
// Same discipline as contributions: short transactions around the provider
// call, never a lock held across the network, and every row stamped with the
// mode it ran in so history never overstates what happened.

const db = require('../config/db');
const ecobank = require('./ecobank');
const audit = require('./auditService');
const poolService = require('./poolService');
const { STATES } = require('../lib/poolState');
const { koboToNaira, formatNaira } = require('../lib/money');
const { conflict, notFound } = require('../lib/errors');

const REFUNDABLE_STATES = [STATES.REJECTED, STATES.EXPIRED, STATES.CANCELLED, STATES.REFUNDING];

function shapeSettlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    pool_id: row.pool_id,
    supplier_id: row.supplier_id,
    amount_kobo: Number(row.amount_kobo),
    amount: koboToNaira(row.amount_kobo),
    amount_display: formatNaira(row.amount_kobo),
    status: row.status,
    provider: row.provider,
    provider_reference: row.provider_reference,
    mode: row.mode,
    simulated: row.mode === 'simulated',
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function shapeRefund(row) {
  return {
    id: row.id,
    pool_id: row.pool_id,
    contribution_id: row.contribution_id,
    user_id: row.user_id,
    recipient_name: row.recipient_name,
    amount_kobo: Number(row.amount_kobo),
    amount: koboToNaira(row.amount_kobo),
    amount_display: formatNaira(row.amount_kobo),
    status: row.status,
    provider_reference: row.provider_reference,
    mode: row.mode,
    simulated: row.mode === 'simulated',
    reason: row.reason,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

async function openSettlement(poolId, actorId) {
  return db.withTransaction(async (client) => {
    const pool = await poolService.lockPool(client, poolId);

    if (pool.status !== STATES.APPROVED) {
      throw conflict(
        `Settlement needs an approved pool. This pool is ${pool.status}.`,
        { status: pool.status }
      );
    }

    // Belt and braces: the approval said yes, but the money still has to be
    // there. We pay out what was actually collected, never the target figure.
    const funded = await poolService.fundedAmountKobo(client, poolId);
    if (funded < BigInt(pool.target_amount_kobo)) {
      throw conflict('The collected amount no longer covers this pool\'s target', {
        funded_amount_kobo: Number(funded),
        target_amount_kobo: Number(pool.target_amount_kobo),
      });
    }

    const { rows: existing } = await client.query(
      `select * from settlements where pool_id = $1 and status <> 'FAILED'`,
      [poolId]
    );
    if (existing[0] && existing[0].status === 'COMPLETED') {
      throw conflict('This pool has already been settled');
    }

    const settlement = existing[0]
      ? existing[0]
      : (await client.query(
          `insert into settlements (pool_id, supplier_id, amount_kobo, status, mode)
           values ($1, $2, $3, 'PROCESSING', $4)
           returning *`,
          [poolId, pool.supplier_id, funded.toString(), ecobank.mode()]
        )).rows[0];

    const updatedPool = await poolService.transition(client, pool, STATES.SETTLEMENT, {
      actorId,
      reason: 'Approved pool sent for settlement',
    });

    await audit.record({
      actorId,
      action: 'settlement.initiated',
      entityType: 'settlement',
      entityId: settlement.id,
      metadata: { pool_id: poolId, amount_kobo: Number(funded), mode: ecobank.mode() },
    }, client);

    return { settlement, pool: updatedPool };
  });
}

async function closeSettlement(settlementId, providerResult, actorId) {
  return db.withTransaction(async (client) => {
    const { rows: settlementRows } = await client.query(
      'select * from settlements where id = $1 for update',
      [settlementId]
    );
    const settlement = settlementRows[0];
    if (!settlement) throw notFound('Settlement not found');

    const pool = await poolService.lockPool(client, settlement.pool_id);
    const status = providerResult.success ? 'COMPLETED' : 'FAILED';

    const { rows } = await client.query(
      `update settlements
          set status = $2, provider_reference = $3, failure_reason = $4,
              completed_at = case when $2 = 'COMPLETED' then now() else null end
        where id = $1
        returning *`,
      [settlementId, status, providerResult.providerReference,
       providerResult.success ? null : providerResult.message]
    );

    await audit.record({
      actorId,
      action: providerResult.success ? 'settlement.completed' : 'settlement.failed',
      entityType: 'settlement',
      entityId: settlementId,
      metadata: {
        pool_id: pool.id,
        amount_kobo: Number(settlement.amount_kobo),
        mode: settlement.mode,
        provider_reference: providerResult.providerReference,
        provider_message: providerResult.message,
      },
    }, client);

    // A failed payout returns the pool to APPROVED so it can be retried
    // without needing a second human approval -- the authorisation still holds.
    const updatedPool = await poolService.transition(
      client,
      pool,
      providerResult.success ? STATES.COMPLETED : STATES.APPROVED,
      {
        actorType: 'system',
        reason: providerResult.success
          ? 'Supplier paid, pool complete'
          : `Settlement failed at the provider: ${providerResult.message}`,
      }
    );

    return { settlement: rows[0], pool_status: updatedPool.status };
  });
}

async function settle(poolId, actorId) {
  const { settlement, pool } = await openSettlement(poolId, actorId);

  const { rows: supplierRows } = await db.query('select * from suppliers where id = $1', [pool.supplier_id]);
  const supplier = supplierRows[0];

  let providerResult;
  try {
    providerResult = await ecobank.disburseToSupplier({
      reference: `SETTLE-${settlement.id}`,
      amountKobo: Number(settlement.amount_kobo),
      narration: `Trustock pool ${pool.reference}`,
      beneficiary: {
        accountNumber: supplier.account_number,
        accountName: supplier.account_name,
        bankName: supplier.bank_name,
      },
    });
  } catch (error) {
    providerResult = { success: false, providerReference: null, message: error.message };
    await closeSettlement(settlement.id, providerResult, actorId);
    throw error;
  }

  const result = await closeSettlement(settlement.id, providerResult, actorId);

  return {
    settlement: shapeSettlement(result.settlement),
    pool_status: result.pool_status,
    provider: ecobank.describe(),
    provider_message: providerResult.message,
  };
}

async function getForPool(poolId) {
  const { rows } = await db.query(
    `select * from settlements where pool_id = $1 order by created_at desc limit 1`,
    [poolId]
  );
  return shapeSettlement(rows[0]);
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

async function openRefunds(poolId, actorId, reason) {
  return db.withTransaction(async (client) => {
    const pool = await poolService.lockPool(client, poolId);

    if (!REFUNDABLE_STATES.includes(pool.status)) {
      throw conflict(
        `Refunds run on a rejected, expired or cancelled pool. This pool is ${pool.status}.`,
        { status: pool.status }
      );
    }

    // One refund row per paid contribution. The unique constraint on
    // contribution_id means running this twice cannot double-refund anyone.
    await client.query(
      `insert into refunds (pool_id, contribution_id, user_id, amount_kobo, mode, reason)
       select c.pool_id, c.id, c.user_id, c.amount_kobo, $2, $3
         from contributions c
        where c.pool_id = $1 and c.status = 'PAID'
       on conflict (contribution_id) do nothing`,
      [poolId, ecobank.mode(), reason]
    );

    let updatedPool = pool;
    if (pool.status !== STATES.REFUNDING) {
      updatedPool = await poolService.transition(client, pool, STATES.REFUNDING, {
        actorId,
        reason: reason || 'Refunding contributors',
      });
    }

    // The original collection reference travels with the refund: a reversal
    // is expressed against the payment that brought the money in.
    const { rows } = await client.query(
      `select r.*, u.full_name as recipient_name,
              c.provider_reference as original_provider_reference,
              c.idempotency_key as original_request_id
         from refunds r
         join users u on u.id = r.user_id
         join contributions c on c.id = r.contribution_id
        where r.pool_id = $1 and r.status <> 'COMPLETED'`,
      [poolId]
    );

    await audit.record({
      actorId,
      action: 'refund.initiated',
      entityType: 'pool',
      entityId: poolId,
      metadata: { refund_count: rows.length, mode: ecobank.mode(), reason },
    }, client);

    return { pool: updatedPool, pending: rows };
  });
}

async function closeRefund(refundId, providerResult, actorId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `update refunds
          set status = $2, provider_reference = $3, failure_reason = $4,
              completed_at = case when $2 = 'COMPLETED' then now() else null end
        where id = $1
        returning *`,
      [refundId, providerResult.success ? 'COMPLETED' : 'FAILED',
       providerResult.providerReference, providerResult.success ? null : providerResult.message]
    );
    const refund = rows[0];

    if (providerResult.success) {
      await client.query(
        `update contributions set status = 'REFUNDED' where id = $1`,
        [refund.contribution_id]
      );
    }

    await audit.record({
      actorId,
      action: providerResult.success ? 'refund.completed' : 'refund.failed',
      entityType: 'refund',
      entityId: refundId,
      metadata: {
        pool_id: refund.pool_id,
        amount_kobo: Number(refund.amount_kobo),
        mode: refund.mode,
        provider_reference: providerResult.providerReference,
      },
    }, client);

    return refund;
  });
}

/**
 * Returns every paid contribution. The pool only reaches REFUNDED when there
 * is nothing outstanding -- a partial failure leaves it in REFUNDING so it can
 * be retried, rather than being quietly marked done.
 */
async function refund(poolId, actorId, reason = 'Pool did not proceed to settlement') {
  const { pending } = await openRefunds(poolId, actorId, reason);

  for (const row of pending) {
    let providerResult;
    try {
      providerResult = await ecobank.reverseToContributor({
        reference: `REFUND-${row.id}`,
        amountKobo: Number(row.amount_kobo),
        narration: `Trustock refund for pool ${poolId}`,
        originalReference: row.original_request_id,
        originalProviderReference: row.original_provider_reference,
      });
    } catch (error) {
      providerResult = { success: false, providerReference: null, message: error.message };
    }
    await closeRefund(row.id, providerResult, actorId);
  }

  const finalStatus = await db.withTransaction(async (client) => {
    const pool = await poolService.lockPool(client, poolId);
    const { rows: outstanding } = await client.query(
      `select count(*)::int as count from refunds where pool_id = $1 and status <> 'COMPLETED'`,
      [poolId]
    );

    if (outstanding[0].count === 0 && pool.status === STATES.REFUNDING) {
      const updated = await poolService.transition(client, pool, STATES.REFUNDED, {
        actorType: 'system',
        reason: 'All contributors refunded',
      });
      return updated.status;
    }
    return pool.status;
  });

  return {
    // Re-read so the response carries recipient names alongside the amounts.
    refunds: await listRefunds(poolId),
    pool_status: finalStatus,
    provider: ecobank.describe(),
  };
}

async function listRefunds(poolId) {
  const { rows } = await db.query(
    `select r.*, u.full_name as recipient_name
       from refunds r join users u on u.id = r.user_id
      where r.pool_id = $1 order by r.created_at asc`,
    [poolId]
  );
  return rows.map(shapeRefund);
}

module.exports = { settle, refund, getForPool, listRefunds, shapeSettlement, shapeRefund };
