// src/services/riskService.js
//
// Gathers the facts a pool's risk assessment needs, runs the rule engine over
// them, stores the result, and moves the pool. The rules themselves live in
// ./risk/rules.js and know nothing about the database -- this file is the only
// part that does.

const db = require('../config/db');
const audit = require('./auditService');
const poolService = require('./poolService');
const rules = require('./risk/rules');
const { STATES } = require('../lib/poolState');
const { conflict, notFound, forbidden } = require('../lib/errors');

const ASSESSABLE_STATES = [STATES.MOQ_REACHED, STATES.RISK_REVIEW, STATES.REJECTED];

/**
 * Reads everything the rules need in one place, so the rule functions stay
 * pure and the queries stay visible.
 */
async function gatherFacts(runner, poolId) {
  const { rows: poolRows } = await runner.query('select * from pools where id = $1', [poolId]);
  const pool = poolRows[0];
  if (!pool) throw notFound('Pool not found');

  const [
    supplierResult,
    creatorResult,
    historyResult,
    sharedAccountResult,
    supplierEditsResult,
    supplierStatsResult,
    platformStatsResult,
    contributionStatsResult,
    largestResult,
    windowResult,
    memberResult,
  ] = await Promise.all([
    runner.query('select * from suppliers where id = $1', [pool.supplier_id]),
    runner.query('select * from users where id = $1', [pool.creator_id]),
    runner.query(
      `select * from supplier_account_history where supplier_id = $1 order by created_at asc`,
      [pool.supplier_id]
    ),
    runner.query(
      `select id, name from suppliers
        where account_number = (select account_number from suppliers where id = $1)
          and bank_name = (select bank_name from suppliers where id = $1)
          and id <> $1`,
      [pool.supplier_id]
    ),
    runner.query(
      `select action, created_at from audit_log
        where entity_type = 'supplier' and entity_id = $1
          and action in ('supplier.updated', 'supplier.account_changed')
          and created_at > $2
        order by created_at asc`,
      [pool.supplier_id, pool.created_at]
    ),
    runner.query(
      `select count(*)::int as completed,
              coalesce(avg(p.target_amount_kobo), 0)::float as average_kobo
         from settlements s
         join pools p on p.id = s.pool_id
        where s.supplier_id = $1 and s.status = 'COMPLETED'`,
      [pool.supplier_id]
    ),
    runner.query(
      `select count(*)::int as completed,
              coalesce(avg(p.target_amount_kobo), 0)::float as average_kobo
         from pools p
        where p.status = 'COMPLETED' and p.id <> $1`,
      [poolId]
    ),
    runner.query(
      `select
         count(*) filter (where status = 'FAILED')::int as failed,
         count(*) filter (where status = 'PAID')::int as paid
       from contributions where pool_id = $1`,
      [poolId]
    ),
    runner.query(
      `select coalesce(max(total), 0)::bigint as largest from (
         select sum(amount_kobo) as total from contributions
          where pool_id = $1 and status = 'PAID' group by user_id) t`,
      [poolId]
    ),
    runner.query(
      `select extract(epoch from (max(paid_at) - min(paid_at))) / 60 as minutes
         from contributions where pool_id = $1 and status = 'PAID'`,
      [poolId]
    ),
    runner.query(
      `select count(*)::int as member_count,
              count(*) filter (where completed > 0)::int as members_with_completed_pools
         from (
           select m.user_id,
                  (select count(*) from pool_members m2
                     join pools p2 on p2.id = m2.pool_id
                    where m2.user_id = m.user_id and p2.status = 'COMPLETED') as completed
             from pool_members m
            where m.pool_id = $1 and m.status <> 'LEFT') t`,
      [poolId]
    ),
  ]);

  const supplierStats = supplierStatsResult.rows[0];
  const platformStats = platformStatsResult.rows[0];
  const contributionStats = contributionStatsResult.rows[0];
  const memberStats = memberResult.rows[0];

  return {
    now: new Date().toISOString(),
    pool,
    supplier: supplierResult.rows[0],
    creator: creatorResult.rows[0],
    supplierAccountHistory: historyResult.rows,
    suppliersSharingAccount: sharedAccountResult.rows,
    supplierEditsDuringFunding: supplierEditsResult.rows,
    supplierCompletedSettlements: supplierStats.completed,
    supplierAveragePoolKobo: supplierStats.completed > 0 ? supplierStats.average_kobo : null,
    platformAveragePoolKobo: platformStats.completed > 0 ? platformStats.average_kobo : null,
    failedContributionCount: contributionStats.failed,
    paidContributionCount: contributionStats.paid,
    largestContributorPaidKobo: Number(largestResult.rows[0].largest),
    fundingWindowMinutes: windowResult.rows[0].minutes === null
      ? null
      : Number(windowResult.rows[0].minutes),
    memberCount: memberStats.member_count,
    membersWithCompletedPools: memberStats.members_with_completed_pools,
  };
}

/**
 * Says out loud which comparisons could not be made. A reviewer should know the
 * difference between "we checked and it was fine" and "we had nothing to check
 * against".
 */
function dataQuality(facts) {
  const unavailable = [];
  if (facts.supplierCompletedSettlements === 0) {
    unavailable.push('No completed settlement history for this supplier to compare against.');
  }
  if (facts.platformAveragePoolKobo === null) {
    unavailable.push('No completed pools on the platform yet, so no size baseline exists.');
  }
  if (!facts.supplier.phone && !facts.supplier.email) {
    unavailable.push('No supplier contact details on file to confirm payout details out of band.');
  }
  if (facts.supplier.verification_status === 'external') {
    unavailable.push('Supplier is external: their details were entered by a buyer and are unconfirmed.');
  }

  return {
    checks_run: rules.RULES.length,
    limitations: unavailable,
    // Every assessment carries this. Nothing here proves anything.
    disclaimer: rules.DISCLAIMER,
  };
}

function shapeAssessment(row) {
  return {
    id: row.id,
    pool_id: row.pool_id,
    score: row.score,
    level: row.level,
    decision: row.decision,
    signals: row.signals,
    checks_passed: row.checks_passed,
    engine_version: row.engine_version,
    data_quality: row.data_quality,
    created_at: row.created_at,
    disclaimer: rules.DISCLAIMER,
  };
}

/**
 * Assesses a pool that has reached its MOQ. LOW clears itself straight to
 * APPROVED; anything else leaves the pool in RISK_REVIEW with the payout
 * paused until a person decides.
 */
async function assess(poolId, actorId) {
  return db.withTransaction(async (client) => {
    const pool = await poolService.lockPool(client, poolId);

    if (!ASSESSABLE_STATES.includes(pool.status)) {
      throw conflict(
        `A risk assessment runs once a pool has reached its MOQ. This pool is ${pool.status}.`,
        { status: pool.status, assessable_states: ASSESSABLE_STATES }
      );
    }

    const facts = await gatherFacts(client, poolId);
    const evaluation = rules.evaluate(facts);
    const quality = dataQuality(facts);

    const { rows } = await client.query(
      `insert into risk_assessments (pool_id, score, level, decision, signals, checks_passed, engine_version, data_quality)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [poolId, evaluation.score, evaluation.level, evaluation.decision,
       JSON.stringify(evaluation.signals), JSON.stringify(evaluation.checks_passed),
       evaluation.engine_version, JSON.stringify(quality)]
    );
    const assessment = rows[0];

    await audit.record({
      actorId,
      action: 'risk.assessed',
      entityType: 'pool',
      entityId: poolId,
      metadata: {
        score: evaluation.score,
        level: evaluation.level,
        decision: evaluation.decision,
        signal_codes: evaluation.signals.map((s) => s.code),
        engine_version: evaluation.engine_version,
      },
    }, client);

    let currentPool = pool;
    if (currentPool.status !== STATES.RISK_REVIEW) {
      currentPool = await poolService.transition(client, currentPool, STATES.RISK_REVIEW, {
        actorId,
        reason: `Risk assessment run: ${evaluation.level} (score ${evaluation.score})`,
      });
    }

    if (evaluation.decision === 'AUTO_APPROVE') {
      currentPool = await poolService.transition(client, currentPool, STATES.APPROVED, {
        actorType: 'system',
        reason: `Low risk (score ${evaluation.score}) -- cleared for settlement automatically`,
      });
    }

    return {
      assessment: shapeAssessment(assessment),
      pool_status: currentPool.status,
      payout_paused: evaluation.decision === 'REVIEW_REQUIRED',
      thresholds: evaluation.thresholds,
    };
  });
}

async function latestForPool(poolId) {
  const { rows } = await db.query(
    'select * from risk_assessments where pool_id = $1 order by created_at desc limit 1',
    [poolId]
  );
  return rows[0] ? shapeAssessment(rows[0]) : null;
}

async function listForPool(poolId) {
  const { rows } = await db.query(
    'select * from risk_assessments where pool_id = $1 order by created_at desc',
    [poolId]
  );
  return rows.map(shapeAssessment);
}

/**
 * A human decision on a paused pool.
 *
 * Separation of duties: a HIGH-risk payout cannot be approved by the person
 * who organised the pool. Someone with the reviewer role has to look at it.
 */
async function review(poolId, reviewer, { decision, notes }) {
  return db.withTransaction(async (client) => {
    const pool = await poolService.lockPool(client, poolId);

    if (pool.status !== STATES.RISK_REVIEW) {
      throw conflict(`Only a pool in RISK_REVIEW can be reviewed. This pool is ${pool.status}.`);
    }

    const { rows: assessmentRows } = await client.query(
      'select * from risk_assessments where pool_id = $1 order by created_at desc limit 1',
      [poolId]
    );
    const assessment = assessmentRows[0];
    if (!assessment) throw conflict('Run a risk assessment before reviewing this pool');

    const isReviewer = reviewer.role === 'reviewer';
    const isCreator = pool.creator_id === reviewer.id;

    if (!isReviewer && !isCreator) {
      throw forbidden('Only the pool organiser or a Trustock reviewer can decide on this pool');
    }
    if (assessment.level === 'HIGH' && decision === 'APPROVED' && !isReviewer) {
      throw forbidden(
        'A HIGH risk payout cannot be approved by the pool organiser. A Trustock reviewer must approve it.'
      );
    }

    const { rows } = await client.query(
      `insert into reviews (pool_id, risk_assessment_id, reviewer_id, decision, notes)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [poolId, assessment.id, reviewer.id, decision, notes || null]
    );

    const nextStatus = decision === 'APPROVED' ? STATES.APPROVED : STATES.REJECTED;
    const updatedPool = await poolService.transition(client, pool, nextStatus, {
      actorId: reviewer.id,
      reason: `Reviewed by ${reviewer.role}: ${decision}${notes ? ` -- ${notes}` : ''}`,
    });

    await audit.record({
      actorId: reviewer.id,
      action: `review.${decision.toLowerCase()}`,
      entityType: 'pool',
      entityId: poolId,
      metadata: {
        risk_assessment_id: assessment.id,
        risk_level: assessment.level,
        risk_score: assessment.score,
        notes: notes || null,
      },
    }, client);

    return { review: rows[0], pool_status: updatedPool.status };
  });
}

async function listReviews(poolId) {
  const { rows } = await db.query(
    `select r.*, u.full_name as reviewer_name, u.role as reviewer_role
       from reviews r join users u on u.id = r.reviewer_id
      where r.pool_id = $1 order by r.created_at desc`,
    [poolId]
  );
  return rows;
}

module.exports = { assess, review, latestForPool, listForPool, listReviews, gatherFacts, dataQuality };
