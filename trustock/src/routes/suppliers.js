// src/routes/suppliers.js
//
// Suppliers do not need an account here. A buyer records the wholesaler they
// already deal with, and Trustock labels them 'external' until a settled
// history says otherwise.

const express = require('express');
const supplierService = require('../services/supplierService');
const { authenticate, requireRole } = require('../middleware/auth');
const v = require('../lib/validate');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json({ suppliers: await supplierService.list({ createdBy: req.query.mine ? req.user.id : null }) });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = v.requireFields(req.body, ['name', 'bank_name', 'account_number', 'account_name']);
    const supplier = await supplierService.create({
      name: v.assertString(body.name, 'name', { min: 2, max: 160 }),
      phone: v.optionalString(body.phone, 'phone', { max: 30 }),
      email: body.email ? v.assertEmail(body.email) : null,
      bankName: v.assertString(body.bank_name, 'bank_name', { min: 2, max: 120 }),
      accountNumber: v.assertAccountNumber(body.account_number),
      accountName: v.assertString(body.account_name, 'account_name', { min: 2, max: 160 }),
    }, req.user.id);

    res.status(201).json({
      supplier,
      notice: 'Recorded as an EXTERNAL supplier. Trustock has not independently verified these details.',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'supplier id');
    const [supplier, history] = await Promise.all([
      supplierService.getById(id),
      supplierService.accountHistory(id),
    ]);
    res.json({ supplier, account_history: history });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/suppliers/:id
 * Changing the payout account here is exactly what the risk engine will pick
 * up later -- the response says so plainly rather than letting it pass quietly.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'supplier id');
    const body = req.body || {};

    const { supplier, accountChanged } = await supplierService.update(id, {
      name: body.name ? v.assertString(body.name, 'name', { min: 2, max: 160 }) : undefined,
      phone: body.phone !== undefined ? v.optionalString(body.phone, 'phone', { max: 30 }) : undefined,
      email: body.email ? v.assertEmail(body.email) : undefined,
      bankName: body.bank_name ? v.assertString(body.bank_name, 'bank_name', { min: 2, max: 120 }) : undefined,
      accountNumber: body.account_number ? v.assertAccountNumber(body.account_number) : undefined,
      accountName: body.account_name ? v.assertString(body.account_name, 'account_name', { min: 2, max: 160 }) : undefined,
    }, req.user.id);

    res.json({
      supplier,
      account_changed: accountChanged,
      notice: accountChanged
        ? 'The payout account was changed. This is recorded and will be raised in the risk assessment of any pool paying this supplier.'
        : undefined,
    });
  } catch (error) {
    next(error);
  }
});

/** Reviewers only, and only once a settlement has actually completed. */
router.post('/:id/verify', requireRole('reviewer'), async (req, res, next) => {
  try {
    const id = v.assertUuid(req.params.id, 'supplier id');
    res.json({ supplier: await supplierService.markVerified(id, req.user.id) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
