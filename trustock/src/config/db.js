// src/config/db.js
// A single shared PostgreSQL connection pool plus the two helpers every
// service uses: query() for reads, and withTransaction() for anything that
// moves money or changes a pool's state.

const { Pool } = require('pg');
const config = require('./env');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a single database transaction and hands it a client.
 * Commits when `fn` resolves, rolls back if it throws. Every state change in
 * Trustock goes through here -- a pool must never be half-updated.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
