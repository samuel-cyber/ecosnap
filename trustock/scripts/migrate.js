// scripts/migrate.js -- applies db/schema.sql. Safe to run more than once.

const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.pool.query(sql);
  console.log('Schema applied.');
  await db.pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
