// src/services/authService.js
// Registration, login and token issuing. Passwords are hashed with bcrypt and
// never leave this file in plain form.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const config = require('../config/env');
const audit = require('./auditService');
const { badRequest, conflict, unauthorized } = require('../lib/errors');

const BCRYPT_ROUNDS = 10;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    business_name: row.business_name,
    phone: row.phone,
    role: row.role,
    created_at: row.created_at,
  };
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

async function register({ email, password, fullName, businessName, phone, role = 'entrepreneur' }) {
  if (typeof password !== 'string' || password.length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let row;
  try {
    const result = await db.query(
      `insert into users (email, password_hash, full_name, business_name, phone, role)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [email, passwordHash, fullName, businessName, phone, role]
    );
    row = result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('An account with that email already exists');
    }
    throw error;
  }

  await audit.record({
    actorId: row.id,
    action: 'user.registered',
    entityType: 'user',
    entityId: row.id,
    metadata: { email: row.email },
  });

  return { user: publicUser(row), token: issueToken(row) };
}

async function login({ email, password }) {
  const { rows } = await db.query('select * from users where lower(email) = lower($1)', [email]);
  const row = rows[0];

  // Always run a hash comparison so a missing account and a wrong password
  // take about the same time, and neither is distinguishable from the outside.
  const hash = row ? row.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);

  if (!row || !ok) throw unauthorized('Incorrect email or password');

  await audit.record({
    actorId: row.id,
    action: 'user.logged_in',
    entityType: 'user',
    entityId: row.id,
  });

  return { user: publicUser(row), token: issueToken(row) };
}

async function findById(id) {
  const { rows } = await db.query('select * from users where id = $1', [id]);
  return rows[0] ? publicUser(rows[0]) : null;
}

module.exports = { register, login, findById, publicUser, issueToken };
