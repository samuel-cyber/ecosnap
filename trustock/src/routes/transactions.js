// src/routes/transactions.js
// The signed-in user's own money history, newest first.

const express = require('express');
const contributionService = require('../services/contributionService');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { koboToNaira, formatNaira } = require('../lib/money');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const [contributions, refundResult, settlementResult] = await Promise.all([
      contributionService.listForUser(req.user.id),
      db.query(
        `select r.*, p.title as pool_title, p.reference as pool_reference
           from refunds r join pools p on p.id = r.pool_id
          where r.user_id = $1 order by r.created_at desc limit 100`,
        [req.user.id]
      ),
      db.query(
        `select s.*, p.title as pool_title, p.reference as pool_reference, sup.name as supplier_name
           from settlements s
           join pools p on p.id = s.pool_id
           join suppliers sup on sup.id = s.supplier_id
          where p.creator_id = $1
             or exists (select 1 from pool_members m
                         where m.pool_id = p.id and m.user_id = $1 and m.status <> 'LEFT')
          order by s.created_at desc limit 100`,
        [req.user.id]
      ),
    ]);

    // One list, one shape, so the history screen reads as a statement rather
    // than three unrelated tables.
    const entries = [
      ...contributions.map((c) => ({
        type: 'CONTRIBUTION',
        direction: 'out',
        id: c.id,
        pool_id: c.pool_id,
        pool_title: c.pool_title,
        pool_reference: c.pool_reference,
        amount_kobo: c.amount_kobo,
        amount_display: c.amount_display,
        status: c.status,
        mode: c.mode,
        simulated: c.simulated,
        provider_reference: c.provider_reference,
        created_at: c.created_at,
      })),
      ...refundResult.rows.map((r) => ({
        type: 'REFUND',
        direction: 'in',
        id: r.id,
        pool_id: r.pool_id,
        pool_title: r.pool_title,
        pool_reference: r.pool_reference,
        amount_kobo: Number(r.amount_kobo),
        amount_display: formatNaira(r.amount_kobo),
        amount: koboToNaira(r.amount_kobo),
        status: r.status,
        mode: r.mode,
        simulated: r.mode === 'simulated',
        provider_reference: r.provider_reference,
        created_at: r.created_at,
      })),
      ...settlementResult.rows.map((s) => ({
        type: 'SETTLEMENT',
        direction: 'out',
        id: s.id,
        pool_id: s.pool_id,
        pool_title: s.pool_title,
        pool_reference: s.pool_reference,
        counterparty: s.supplier_name,
        amount_kobo: Number(s.amount_kobo),
        amount_display: formatNaira(s.amount_kobo),
        amount: koboToNaira(s.amount_kobo),
        status: s.status,
        mode: s.mode,
        simulated: s.mode === 'simulated',
        provider_reference: s.provider_reference,
        created_at: s.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ transactions: entries });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
