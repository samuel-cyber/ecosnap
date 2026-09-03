// src/services/contributionService.js
//
// Money in. Each member pays their share; when the paid total reaches the
// target, the pool moves to MOQ_REACHED and the trust layer takes over.
//
// The bank call deliberately happens BETWEEN two short database transactions
// rather than inside one long one. Holding a row lock open across a network
// call is how payment systems deadlock under load; recording intent, calling
// out, then recording the outcome is how they stay correct.

const crypto = require('crypto');
const db = require('../config/db');
const ecobank = require('./ecobank');
const audit = require('./auditService');
const poolService = require('./poolService');
const { STATES, FUNDABLE_STATES } = require('../lib/poolState');
const { koboToNaira, formatNaira } = require('../lib/money');
const { conflict, notFound, badRequest } = require('../lib/errors');

function shapeContribution(row) {
  return {
    id: row.id,
    pool_id: row.pool_id,
    user_id: row.user_id,
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
    paid_at: row.paid_at,
    contributor_name: row.contributor_name,
  };
}

/**
 * Step 1 -- record the intent to pay, inside a transaction, with the pool row
 * locked so two people cannot both claim the last slot of funding.
 */
async function openContribution(poolId, userId, idempotencyKey) {
  return db.withTransaction(async (client) => {
    // An identical request that already exists is returned as-is rather than
    // charging the member twice.
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'select * from contributions where idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing[0]) return { contribution: existing[0], replayed: true };
    }

    const pool = await poolService.lockPool(client, poolId);

    if (!FUNDABLE_STATES.includes(pool.status)) {
      throw conflict(`This pool is ${pool.status} and is no longer accepting contributions`);
    }
    if (new Date(pool.deadline) <= new Date()) {
      throw conflict('This pool\'s deadline has passed, so it can no longer be funded');
    }

    const { rows: memberRows } = await client.query(
      `select * from pool_members where pool_id = $1 and user_id = $2 and status <> 'LEFT'`,
      [poolId, userId]
    );
    const member = memberRows[0];
    if (!member) throw notFound('Join this pool before contributing to it');

    const { rows: paidRows } = await client.query(
      `select coalesce(sum(amount_kobo), 0)::bigint as mine
         from contributions
        where pool_id = $1 and user_id = $2 and status = 'PAID'`,
      [poolId, userId]
    );
    if (BigInt(paidRows[0].mine) >= BigInt(member.committed_amount_kobo)) {
      throw conflict('You have already paid your share of this pool');
    }

    const { rows: pendingRows } = await client.query(
      `select id from contributions
        where pool_id = $1 and user_id = $2 and status = 'PENDING' limit 1`,
      [poolId, userId]
    );
    if (pendingRows[0]) {
      throw conflict('You already have a contribution being processed for this pool');
    }

    const funded = await poolService.fundedAmountKobo(client, poolId);
    const remaining = BigInt(pool.target_amount_kobo) - funded;
    if (remaining <= 0n) throw conflict('This pool is already fully funded');

    // Never collect more than the pool still needs: the last contributor pays
    // the remainder, not a full share that would overshoot the target.
    const outstandingForMember = BigInt(member.committed_amount_kobo) - BigInt(paidRows[0].mine);
    const amountKobo = outstandingForMember < remaining ? outstandingForMember : remaining;
    if (amountKobo <= 0n) throw badRequest('There is nothing left for you to pay on this pool');

    const key = idempotencyKey || `auto-${crypto.randomUUID()}`;

    const { rows } = await client.query(
      `insert into contributions (pool_id, user_id, amount_kobo, status, mode, idempotency_key)
       values ($1, $2, $3, 'PENDING', $4, $5)
       returning *`,
      [poolId, userId, amountKobo.toString(), ecobank.mode(), key]
    );

    await audit.record({
      actorId: userId,
      action: 'contribution.initiated',
      entityType: 'contribution',
      entityId: rows[0].id,
      metadata: { pool_id: poolId, amount_kobo: Number(amountKobo), mode: ecobank.mode() },
    }, client);

    return { contribution: rows[0], replayed: false, pool };
  });
}

/**
 * Step 3 -- write the provider's answer down, and let a fully funded pool move
 * on to MOQ_REACHED. Runs with the pool row locked again.
 */
async function closeContribution(contributionId, providerResult, userId) {
  return db.withTransaction(async (client) => {
    const { rows: contributionRows } = await client.query(
      'select * from contributions where id = $1 for update',
      [contributionId]
    );
    const contribution = contributionRows[0];
    if (!contribution) throw notFound('Contribution not found');
    if (contribution.status !== 'PENDING') return { contribution, poolStatus: null };

    const pool = await poolService.lockPool(client, contribution.pool_id);
    const status = providerResult.success ? 'PAID' : 'FAILED';

    const { rows } = await client.query(
      `update contributions
          set status = $2,
              provider_reference = $3,
              failure_reason = $4,
              paid_at = case when $2 = 'PAID' then now() else null end
        where id = $1
        returning *`,
      [contributionId, status, providerResult.providerReference,
       providerResult.success ? null : providerResult.message]
    );
    const updated = rows[0];

    await audit.record({
      actorId: userId,
      action: providerResult.success ? 'contribution.paid' : 'contribution.failed',
      entityType: 'contribution',
      entityId: contributionId,
      metadata: {
        pool_id: pool.id,
        amount_kobo: Number(contribution.amount_kobo),
        mode: contribution.mode,
        provider_reference: providerResult.providerReference,
        provider_message: providerResult.message,
      },
    }, client);

    let currentPool = pool;

    if (providerResult.success) {
      await client.query(
        `update pool_members set status = 'PAID'
          where pool_id = $1 and user_id = $2
            and coalesce((select sum(c.amount_kobo) from contributions c
                           where c.pool_id = $1 and c.user_id = $2 and c.status = 'PAID'), 0)
                >= committed_amount_kobo`,
        [pool.id, contribution.user_id]
      );

      // First money in opens the funding window.
      if (currentPool.status === STATES.CREATED) {
        currentPool = await poolService.transition(client, currentPool, STATES.FUNDING, {
          actorId: userId,
          reason: 'First contribution received',
        });
      }

      const funded = await poolService.fundedAmountKobo(client, pool.id);
      if (funded >= BigInt(pool.target_amount_kobo) && currentPool.status === STATES.FUNDING) {
        currentPool = await poolService.transition(client, currentPool, STATES.MOQ_REACHED, {
          actorType: 'system',
          reason: 'Minimum order quantity funded in full',
        });
      }
    }

    return { contribution: updated, poolStatus: currentPool.status };
  });
}

/**
 * The whole contribution flow: record intent, call the bank, record the result.
 */
async function contribute(poolId, userId, { idempotencyKey } = {}) {
  const { contribution, replayed } = await openContribution(poolId, userId, idempotencyKey);

  if (replayed) {
    const pool = await poolService.getPoolRow(poolId);
    return {
      contribution: shapeContribution(contribution),
      pool_status: pool.status,
      replayed: true,
      provider: ecobank.describe(),
    };
  }

  const { rows: userRows } = await db.query('select * from users where id = $1', [userId]);
  const user = userRows[0];

  // Step 2 -- the outbound call, with no database lock held.
  let providerResult;
  try {
    providerResult = await ecobank.collectContribution({
      reference: contribution.idempotency_key,
      amountKobo: Number(contribution.amount_kobo),
      narration: `Trustock pool contribution`,
      payer: { customerId: user.id, email: user.email, name: user.full_name, phone: user.phone },
    });
  } catch (error) {
    // A provider error is an outcome, not a crash: record the failure so the
    // member can retry, then surface the error.
    providerResult = {
      success: false,
      providerReference: null,
      message: error.message,
    };
    await closeContribution(contribution.id, providerResult, userId);
    throw error;
  }

  const { contribution: finalContribution, poolStatus } =
    await closeContribution(contribution.id, providerResult, userId);

  return {
    contribution: shapeContribution(finalContribution),
    pool_status: poolStatus,
    replayed: false,
    provider: ecobank.describe(),
    provider_message: providerResult.message,
  };
}

async function listForPool(poolId) {
  const { rows } = await db.query(
    `select c.*, u.full_name as contributor_name
       from contributions c
       join users u on u.id = c.user_id
      where c.pool_id = $1
      order by c.created_at asc`,
    [poolId]
  );
  return rows.map(shapeContribution);
}

async function listForUser(userId) {
  const { rows } = await db.query(
    `select c.*, u.full_name as contributor_name, p.title as pool_title, p.reference as pool_reference
       from contributions c
       join users u on u.id = c.user_id
       join pools p on p.id = c.pool_id
      where c.user_id = $1
      order by c.created_at desc
      limit 100`,
    [userId]
  );
  return rows.map((row) => ({
    ...shapeContribution(row),
    pool_title: row.pool_title,
    pool_reference: row.pool_reference,
  }));
}

module.exports = { contribute, listForPool, listForUser, shapeContribution, openContribution, closeContribution };
