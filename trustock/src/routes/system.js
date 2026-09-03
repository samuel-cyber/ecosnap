// src/routes/system.js
// Health, and the one endpoint that tells any client -- including the UI --
// exactly what is real about this deployment.

const express = require('express');
const db = require('../config/db');
const ecobank = require('../services/ecobank');
const poolService = require('../services/poolService');
const rules = require('../services/risk/rules');
const { TRANSITIONS } = require('../lib/poolState');

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    await db.query('select 1');
    res.json({ status: 'ok', database: 'connected', provider: ecobank.describe() });
  } catch (error) {
    res.status(503).json({ status: 'degraded', database: 'unavailable', error: error.message });
  }
});

/**
 * GET /api/system/integration
 * The honesty endpoint. It states whether money movement on this deployment is
 * live or simulated, and the UI renders that answer where nobody can miss it.
 */
router.get('/integration', (req, res) => {
  res.json({
    provider: ecobank.describe(),
    risk_engine: {
      engine_version: rules.ENGINE_VERSION,
      rule_count: rules.RULES.length,
      thresholds: { medium: rules.MEDIUM_THRESHOLD, high: rules.HIGH_THRESHOLD },
      disclaimer: rules.DISCLAIMER,
    },
    pool_states: TRANSITIONS,
  });
});

/** Sweeps pools whose deadline passed before the MOQ was reached. */
router.post('/expire-pools', async (req, res, next) => {
  try {
    res.json({ expired_pool_ids: await poolService.expireOverduePools() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
