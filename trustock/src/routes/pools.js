// src/routes/pools.js
//
// The whole demo path lives here: create a pool, join it, contribute, reach
// the MOQ, assess the risk, review a flagged payout, settle or refund.

const express = require('express');
const poolService = require('../services/poolService');
const contributionService = require('../services/contributionService');
const riskService = require('../services/riskService');
const settlementService = require('../services/settlementService');
const supplierService = require('../services/supplierService');
const audit = require('../services/auditService');
const ecobank = require('../services/ecobank');
const { authenticate } = require('../middleware/auth');
const { STATES } = require('../lib/poolState');
const v = require('../lib/validate');
const { badRequest, forbidden } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);

// --- list & create -------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const pools = await poolService.listPools({
      status: req.query.status,
      userId: req.user.id,
      mine: req.query.mine === 'true',
    });
    res.json({ pools, provider: ecobank.describe() });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pools
 * A supplier can be referenced by id, or supplied inline for a wholesaler the
 * buyer already deals with -- that is the common case, so it should not need
 * two round trips.
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    v.requireFields(body, ['title', 'target_amount', 'contribution_amount', 'max_participants', 'deadline']);

    let supplierId = body.supplier_id;
    if (supplierId) {
      v.assertUuid(supplierId, 'supplier_id');
      await supplierService.getById(supplierId);
    } else if (body.supplier) {
      const s = v.requireFields(body.supplier, ['name', 'bank_name', 'account_number', 'account_name']);
      const created = await supplierService.create({
        name: v.assertString(s.name, 'supplier.name', { min: 2, max: 160 }),
        phone: v.optionalString(s.phone, 'supplier.phone', { max: 30 }),
        email: s.email ? v.assertEmail(s.email) : null,
        bankName: v.assertString(s.bank_name, 'supplier.bank_name', { min: 2, max: 120 }),
        accountNumber: v.assertAccountNumber(s.account_number),
        accountName: v.assertString(s.account_name, 'supplier.account_name', { min: 2, max: 160 }),
      }, req.user.id);
      supplierId = created.id;
    } else {
      throw badRequest('Provide either supplier_id or a supplier object');
    }

    const pool = await poolService.create({
      title: v.assertString(body.title, 'title', { min: 3, max: 160 }),
      description: v.optionalString(body.description, 'description', { max: 2000 }),
      supplierId,
      targetAmountKobo: v.assertMoneyKobo(body.target_amount, 'target_amount'),
      contributionAmountKobo: v.assertMoneyKobo(body.contribution_amount, 'contribution_amount'),
      maxParticipants: v.assertInteger(body.max_participants, 'max_participants', { min: 2, max: 50 }),
      deadline: v.assertFutureDate(body.deadline, 'deadline'),
    }, req.user.id);

    const row = await poolService.getPoolRow(pool.id);
    res.status(201).json({ pool: poolService.shapePool(row) });
  } catch (error) {
    next(error);
  }
});

// --- one pool ------------------------------------------------------------

/**
 * GET /api/pools/:id
 * Everything about a pool in one response: money, members, trust, settlement
 * and the audit trail behind all of it.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');

    const [row, members, contributions, risk, riskHistory, reviews, settlement, refunds, timeline, trail] =
      await Promise.all([
        poolService.getPoolRow(id),
        poolService.getMembers(id),
        contributionService.listForPool(id),
        riskService.latestForPool(id),
        riskService.listForPool(id),
        riskService.listReviews(id),
        settlementService.getForPool(id),
        settlementService.listRefunds(id),
        poolService.getTimeline(id),
        audit.listForEntity('pool', id),
      ]);

    const pool = poolService.shapePool(row);
    const membership = members.find((m) => m.user_id === req.user.id && m.status !== 'LEFT');

    res.json({
      pool,
      members,
      contributions,
      risk_assessment: risk,
      risk_history: riskHistory,
      reviews,
      settlement,
      refunds,
      timeline,
      audit_trail: trail,
      provider: ecobank.describe(),
      viewer: {
        is_member: Boolean(membership),
        is_creator: row.creator_id === req.user.id,
        is_reviewer: req.user.role === 'reviewer',
        has_paid: membership ? membership.has_paid : false,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/join', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const member = await poolService.join(id, req.user.id);
    const row = await poolService.getPoolRow(id);
    res.status(201).json({ member, pool: poolService.shapePool(row) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/leave', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    res.json(await poolService.leave(id, req.user.id));
  } catch (error) {
    next(error);
  }
});

// --- money in ------------------------------------------------------------

/**
 * POST /api/pools/:id/contribute
 * Send an `idempotency_key` and a retried request will never charge twice.
 */
router.post('/:id/contribute', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const idempotencyKey = req.body && req.body.idempotency_key
      ? v.assertString(req.body.idempotency_key, 'idempotency_key', { min: 8, max: 120 })
      : undefined;

    const result = await contributionService.contribute(id, req.user.id, { idempotencyKey });
    const row = await poolService.getPoolRow(id);

    res.status(201).json({ ...result, pool: poolService.shapePool(row) });
  } catch (error) {
    next(error);
  }
});

// --- trust layer ---------------------------------------------------------

/** POST /api/pools/:id/risk-assessment -- runs the explainable rule engine. */
router.post('/:id/risk-assessment', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const row = await poolService.getPoolRow(id);

    const isMember = row.creator_id === req.user.id || req.user.role === 'reviewer';
    if (!isMember) {
      const members = await poolService.getMembers(id);
      if (!members.some((m) => m.user_id === req.user.id && m.status !== 'LEFT')) {
        throw forbidden('Only a member of this pool or a reviewer can run its risk assessment');
      }
    }

    const result = await riskService.assess(id, req.user.id);
    const updated = await poolService.getPoolRow(id);
    res.status(201).json({ ...result, pool: poolService.shapePool(updated) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/pools/:id/review -- the human decision on a paused payout. */
router.post('/:id/review', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const body = v.requireFields(req.body, ['decision']);
    const decision = String(body.decision).toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw badRequest("decision must be 'APPROVED' or 'REJECTED'");
    }

    const result = await riskService.review(id, req.user, {
      decision,
      notes: v.optionalString(body.notes, 'notes', { max: 1000 }),
    });
    const row = await poolService.getPoolRow(id);
    res.status(201).json({ ...result, pool: poolService.shapePool(row) });
  } catch (error) {
    next(error);
  }
});

// --- money out -----------------------------------------------------------

/** POST /api/pools/:id/settle -- pay the supplier. */
router.post('/:id/settle', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const row = await poolService.getPoolRow(id);
    if (row.creator_id !== req.user.id && req.user.role !== 'reviewer') {
      throw forbidden('Only the pool organiser or a reviewer can release settlement');
    }

    const result = await settlementService.settle(id, req.user.id);
    const updated = await poolService.getPoolRow(id);
    res.status(201).json({ ...result, pool: poolService.shapePool(updated) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/pools/:id/refund -- return every kobo collected. */
router.post('/:id/refund', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'pool id');
    const row = await poolService.getPoolRow(id);
    if (row.creator_id !== req.user.id && req.user.role !== 'reviewer') {
      throw forbidden('Only the pool organiser or a reviewer can start refunds');
    }

    const reason = v.optionalString(req.body && req.body.reason, 'reason', { max: 500 })
      || (row.status === STATES.EXPIRED
        ? 'Pool expired before reaching its MOQ'
        : 'Pool was rejected at review');

    const result = await settlementService.refund(id, req.user.id, reason);
    const updated = await poolService.getPoolRow(id);
    res.status(201).json({ ...result, pool: poolService.shapePool(updated) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
