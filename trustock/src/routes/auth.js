// src/routes/auth.js
const express = require('express');
const authService = require('../services/authService');
const { authenticate } = require('../middleware/auth');
const v = require('../lib/validate');

const router = express.Router();

/** POST /api/auth/register -- create an account and return a session token. */
router.post('/register', async (req, res, next) => {
  try {
    const body = v.requireFields(req.body, ['email', 'password', 'full_name']);
    const result = await authService.register({
      email: v.assertEmail(body.email),
      password: body.password,
      fullName: v.assertString(body.full_name, 'full_name', { min: 2, max: 120 }),
      businessName: v.optionalString(body.business_name, 'business_name', { max: 120 }),
      phone: v.optionalString(body.phone, 'phone', { max: 30 }),
      // The reviewer role is not self-serve; it is granted by seeding or by an
      // administrator, so a user cannot sign up as their own approver.
      role: 'entrepreneur',
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/auth/login */
router.post('/login', async (req, res, next) => {
  try {
    const body = v.requireFields(req.body, ['email', 'password']);
    res.json(await authService.login({ email: body.email, password: body.password }));
  } catch (error) {
    next(error);
  }
});

/** GET /api/auth/me */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await authService.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
