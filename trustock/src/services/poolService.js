// src/services/poolService.js
//
// The pool is the heart of Trustock: several entrepreneurs putting money
// together to reach a wholesale minimum order quantity. This file owns pool
// creation, joining, the funding picture, and -- most importantly -- the one
// function allowed to change a pool's status.

const crypto = require('crypto');
const db = require('../config/db');
const audit = require('./auditService');
const { STATES, FUNDABLE_STATES, canTransition, nextStates } = require('../lib/poolState');
const { koboToNaira, formatNaira, percentOf } = require('../lib/money');
const { badRequest, notFound, conflict, forbidden } = require('../lib/errors');

/** Human-friendly, collision-resistant pool reference, e.g. TS-K4M2P9XA. */
function generateReference() {
  return `TS-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * The ONLY way a pool's status changes. It refuses illegal moves, writes the
 * transition to history and audits it -- all inside the caller's transaction,
 * so the status and its paper trail can never disagree.
 */
async function transition(client, pool, toStatus, { actorId = null, actorType = 'user', reason = null } = {}) {
  if (pool.status === toStatus) return pool;

  if (!canTransition(pool.status, toStatus)) {
    throw conflict(
      `A pool in ${pool.status} cannot move to ${toStatus}`,
      { from: pool.status, to: toStatus, allowed: nextStates(pool.status) }
    );
  }

  const { rows } = await client.query(
    `update pools set status = $2, updated_at = now() where id = $1 returning *`,
    [pool.id, toStatus]
  );

  await client.query(
    `insert into pool_state_transitions (pool_id, from_status, to_status, actor_id, reason)
     values ($1, $2, $3, $4, $5)`,
    [pool.id, pool.status, toStatus, actorId, reason]
  );

  await audit.record({
    actorId,
    actorType,
    action: 'pool.status_changed',
    entityType: 'pool',
    entityId: pool.id,
    metadata: { from: pool.status, to: toStatus, reason },
  }, client);

  return rows[0];
}

/** Locks the pool row for the rest of the transaction. */
async function lockPool(client, poolId) {
  const { rows } = await client.query('select * from pools where id = $1 for update', [poolId]);
  if (!rows[0]) throw notFound('Pool not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Funding maths -- always derived from paid contributions, never cached
// ---------------------------------------------------------------------------

/**
 * Sums the contributions that actually settled. Deriving this instead of
 * keeping a running total on the pool means the funding figure cannot drift
 * away from the transactions that back it.
 */
async function fundedAmountKobo(runner, poolId) {
  const { rows } = await runner.query(
    `select coalesce(sum(amount_kobo), 0)::bigint as total
       from contributions
      where pool_id = $1 and status = 'PAID'`,
    [poolId]
  );
  return BigInt(rows[0].total);
}

function fundingSummary(pool, fundedKobo) {
  const funded = BigInt(fundedKobo);
  const target = BigInt(pool.target_amount_kobo);
  const remaining = target > funded ? target - funded : 0n;

  return {
    target_amount_kobo: Number(target),
    target_amount: koboToNaira(target),
    target_amount_display: formatNaira(target),
    funded_amount_kobo: Number(funded),
    funded_amount: koboToNaira(funded),
    funded_amount_display: formatNaira(funded),
    remaining_amount_kobo: Number(remaining),
    remaining_amount: koboToNaira(remaining),
    remaining_amount_display: formatNaira(remaining),
    percent_funded: percentOf(funded, target),
    moq_reached: funded >= target,
  };
}

// ---------------------------------------------------------------------------
// Create / join
// ---------------------------------------------------------------------------

async function create(input, actorId) {
  const {
    title, description, supplierId,
    targetAmountKobo, contributionAmountKobo, maxParticipants, deadline,
  } = input;

  // The pool has to be able to reach its own target, or it is a trap for
  // whoever joins it.
  if (BigInt(contributionAmountKobo) * BigInt(maxParticipants) < BigInt(targetAmountKobo)) {
    throw badRequest(
      'This pool can never reach its target: contribution x participants is less than the target amount',
      {
        max_reachable_kobo: Number(BigInt(contributionAmountKobo) * BigInt(maxParticipants)),
        target_amount_kobo: Number(targetAmountKobo),
      }
    );
  }

  return db.withTransaction(async (client) => {
    const { rows: supplierRows } = await client.query('select id from suppliers where id = $1', [supplierId]);
    if (!supplierRows[0]) throw notFound('Supplier not found');

    const { rows } = await client.query(
      `insert into pools (reference, title, description, creator_id, supplier_id,
                          target_amount_kobo, contribution_amount_kobo, max_participants, deadline)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [generateReference(), title, description, actorId, supplierId,
       targetAmountKobo, contributionAmountKobo, maxParticipants, deadline]
    );
    const pool = rows[0];

    // The creator is a participant, not a spectator -- they join their own pool.
    await client.query(
      `insert into pool_members (pool_id, user_id, committed_amount_kobo)
       values ($1, $2, $3)`,
      [pool.id, actorId, contributionAmountKobo]
    );

    await client.query(
      `insert into pool_state_transitions (pool_id, from_status, to_status, actor_id, reason)
       values ($1, null, 'CREATED', $2, 'Pool created')`,
      [pool.id, actorId]
    );

    await audit.record({
      actorId,
      action: 'pool.created',
      entityType: 'pool',
      entityId: pool.id,
      metadata: {
        reference: pool.reference,
        target_amount_kobo: Number(targetAmountKobo),
        supplier_id: supplierId,
      },
    }, client);

    return pool;
  });
}

async function join(poolId, userId) {
  return db.withTransaction(async (client) => {
    const pool = await lockPool(client, poolId);

    if (!FUNDABLE_STATES.includes(pool.status)) {
      throw conflict(`This pool is ${pool.status} and is no longer accepting members`);
    }
    if (new Date(pool.deadline) <= new Date()) {
      throw conflict('This pool\'s deadline has passed');
    }

    const { rows: memberRows } = await client.query(
      `select count(*)::int as count from pool_members where pool_id = $1 and status <> 'LEFT'`,
      [poolId]
    );
    if (memberRows[0].count >= pool.max_participants) {
      throw conflict('This pool is already full');
    }

    try {
      const { rows } = await client.query(
        `insert into pool_members (pool_id, user_id, committed_amount_kobo)
         values ($1, $2, $3)
         returning *`,
        [poolId, userId, pool.contribution_amount_kobo]
      );

      await audit.record({
        actorId: userId,
        action: 'pool.joined',
        entityType: 'pool',
        entityId: poolId,
        metadata: { committed_amount_kobo: Number(pool.contribution_amount_kobo) },
      }, client);

      return rows[0];
    } catch (error) {
      if (error.code === '23505') throw conflict('You have already joined this pool');
      throw error;
    }
  });
}

async function leave(poolId, userId) {
  return db.withTransaction(async (client) => {
    const pool = await lockPool(client, poolId);

    if (pool.creator_id === userId) {
      throw forbidden('The pool creator cannot leave their own pool');
    }

    const { rows: paid } = await client.query(
      `select count(*)::int as count from contributions
        where pool_id = $1 and user_id = $2 and status = 'PAID'`,
      [poolId, userId]
    );
    if (paid[0].count > 0) {
      throw conflict('You have already contributed to this pool, so you cannot leave it');
    }

    const { rowCount } = await client.query(
      `update pool_members set status = 'LEFT'
        where pool_id = $1 and user_id = $2 and status = 'JOINED'`,
      [poolId, userId]
    );
    if (rowCount === 0) throw notFound('You are not a member of this pool');

    await audit.record({
      actorId: userId,
      action: 'pool.left',
      entityType: 'pool',
      entityId: poolId,
    }, client);

    return { left: true };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const POOL_SELECT = `
  select p.*,
         s.name as supplier_name,
         s.bank_name as supplier_bank_name,
         s.account_number as supplier_account_number,
         s.account_name as supplier_account_name,
         s.verification_status as supplier_verification_status,
         u.full_name as creator_name,
         u.business_name as creator_business_name,
         (select coalesce(sum(c.amount_kobo), 0)::bigint from contributions c
           where c.pool_id = p.id and c.status = 'PAID') as funded_amount_kobo,
         (select count(*)::int from pool_members m
           where m.pool_id = p.id and m.status <> 'LEFT') as member_count
    from pools p
    join suppliers s on s.id = p.supplier_id
    join users u on u.id = p.creator_id`;

function shapePool(row) {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    description: row.description,
    status: row.status,
    deadline: row.deadline,
    created_at: row.created_at,
    updated_at: row.updated_at,
    creator: {
      id: row.creator_id,
      full_name: row.creator_name,
      business_name: row.creator_business_name,
    },
    supplier: {
      id: row.supplier_id,
      name: row.supplier_name,
      bank_name: row.supplier_bank_name,
      account_number: row.supplier_account_number,
      account_name: row.supplier_account_name,
      verification_status: row.supplier_verification_status,
    },
    contribution_amount_kobo: Number(row.contribution_amount_kobo),
    contribution_amount: koboToNaira(row.contribution_amount_kobo),
    contribution_amount_display: formatNaira(row.contribution_amount_kobo),
    max_participants: row.max_participants,
    member_count: row.member_count,
    funding: fundingSummary(row, row.funded_amount_kobo),
    next_states: nextStates(row.status),
  };
}

async function listPools({ status, userId, mine } = {}) {
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (mine && userId) {
    params.push(userId);
    conditions.push(
      `(p.creator_id = $${params.length} or exists (
          select 1 from pool_members m
           where m.pool_id = p.id and m.user_id = $${params.length} and m.status <> 'LEFT'))`
    );
  }

  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const { rows } = await db.query(`${POOL_SELECT} ${where} order by p.created_at desc limit 100`, params);
  return rows.map(shapePool);
}

async function getPoolRow(poolId) {
  const { rows } = await db.query(`${POOL_SELECT} where p.id = $1`, [poolId]);
  if (!rows[0]) throw notFound('Pool not found');
  return rows[0];
}

async function getMembers(poolId) {
  const { rows } = await db.query(
    `select m.id, m.user_id, m.committed_amount_kobo, m.status, m.joined_at,
            u.full_name, u.business_name,
            coalesce((select sum(c.amount_kobo) from contributions c
                       where c.pool_id = m.pool_id and c.user_id = m.user_id
                         and c.status = 'PAID'), 0)::bigint as paid_amount_kobo
       from pool_members m
       join users u on u.id = m.user_id
      where m.pool_id = $1
      order by m.joined_at asc`,
    [poolId]
  );

  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    full_name: row.full_name,
    business_name: row.business_name,
    status: row.status,
    joined_at: row.joined_at,
    committed_amount_kobo: Number(row.committed_amount_kobo),
    committed_amount_display: formatNaira(row.committed_amount_kobo),
    paid_amount_kobo: Number(row.paid_amount_kobo),
    paid_amount_display: formatNaira(row.paid_amount_kobo),
    has_paid: BigInt(row.paid_amount_kobo) >= BigInt(row.committed_amount_kobo),
  }));
}

async function getTimeline(poolId) {
  const { rows } = await db.query(
    `select t.id, t.from_status, t.to_status, t.reason, t.created_at, u.full_name as actor_name
       from pool_state_transitions t
       left join users u on u.id = t.actor_id
      where t.pool_id = $1
      order by t.seq asc`,
    [poolId]
  );
  return rows;
}

/**
 * Marks pools whose deadline passed before the MOQ was reached. Contributions
 * already collected are then refundable through the settlement service.
 */
async function expireOverduePools() {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from pools
        where status in ('CREATED', 'FUNDING') and deadline < now()
        for update`
    );

    const expired = [];
    for (const pool of rows) {
      const updated = await transition(client, pool, STATES.EXPIRED, {
        actorType: 'system',
        reason: 'Deadline passed before the minimum order quantity was reached',
      });
      expired.push(updated.id);
    }
    return expired;
  });
}

module.exports = {
  create,
  join,
  leave,
  listPools,
  getPoolRow,
  getMembers,
  getTimeline,
  shapePool,
  fundedAmountKobo,
  fundingSummary,
  transition,
  lockPool,
  expireOverduePools,
  generateReference,
};
