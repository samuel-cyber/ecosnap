// src/services/supplierService.js
//
// Suppliers do not need a Trustock account. A buyer can bring a wholesaler
// they already deal with; we record what they tell us and label the supplier
// 'external' until there is a reason to call them anything else.
//
// The one thing we are strict about is the payout account: every version of it
// is kept in supplier_account_history, because "the account changed just
// before payout" is the single most useful trust signal we have.

const db = require('../config/db');
const audit = require('./auditService');
const { notFound, conflict } = require('../lib/errors');

function publicSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    bank_name: row.bank_name,
    account_number: row.account_number,
    account_name: row.account_name,
    verification_status: row.verification_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function create({ name, phone, email, bankName, accountNumber, accountName }, actorId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into suppliers (name, phone, email, bank_name, account_number, account_name, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [name, phone, email, bankName, accountNumber, accountName, actorId]
    );
    const supplier = rows[0];

    // Seed the history with the account we were given, so "has this ever
    // changed?" is answerable from day one.
    await client.query(
      `insert into supplier_account_history (supplier_id, bank_name, account_number, account_name, changed_by)
       values ($1, $2, $3, $4, $5)`,
      [supplier.id, bankName, accountNumber, accountName, actorId]
    );

    await audit.record({
      actorId,
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: supplier.id,
      metadata: { name, bank_name: bankName, account_number: accountNumber },
    }, client);

    return publicSupplier(supplier);
  });
}

async function getById(id) {
  const { rows } = await db.query('select * from suppliers where id = $1', [id]);
  if (!rows[0]) throw notFound('Supplier not found');
  return publicSupplier(rows[0]);
}

async function list({ createdBy } = {}) {
  const { rows } = createdBy
    ? await db.query('select * from suppliers where created_by = $1 order by created_at desc', [createdBy])
    : await db.query('select * from suppliers order by created_at desc limit 200');
  return rows.map(publicSupplier);
}

async function accountHistory(supplierId) {
  const { rows } = await db.query(
    `select id, bank_name, account_number, account_name, changed_by, created_at
       from supplier_account_history
      where supplier_id = $1
      order by created_at asc`,
    [supplierId]
  );
  return rows;
}

/**
 * Updates supplier details. A change to the payout account is a material event:
 * it is written to history and audited, and later shows up in risk assessments.
 */
async function update(id, changes, actorId) {
  return db.withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      'select * from suppliers where id = $1 for update',
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw notFound('Supplier not found');

    const next = {
      name: changes.name ?? existing.name,
      phone: changes.phone ?? existing.phone,
      email: changes.email ?? existing.email,
      bank_name: changes.bankName ?? existing.bank_name,
      account_number: changes.accountNumber ?? existing.account_number,
      account_name: changes.accountName ?? existing.account_name,
    };

    const accountChanged =
      next.bank_name !== existing.bank_name ||
      next.account_number !== existing.account_number ||
      next.account_name !== existing.account_name;

    const { rows } = await client.query(
      `update suppliers
          set name = $2, phone = $3, email = $4,
              bank_name = $5, account_number = $6, account_name = $7,
              updated_at = now()
        where id = $1
        returning *`,
      [id, next.name, next.phone, next.email, next.bank_name, next.account_number, next.account_name]
    );

    if (accountChanged) {
      await client.query(
        `insert into supplier_account_history (supplier_id, bank_name, account_number, account_name, changed_by)
         values ($1, $2, $3, $4, $5)`,
        [id, next.bank_name, next.account_number, next.account_name, actorId]
      );
      await audit.record({
        actorId,
        action: 'supplier.account_changed',
        entityType: 'supplier',
        entityId: id,
        metadata: {
          from: {
            bank_name: existing.bank_name,
            account_number: existing.account_number,
            account_name: existing.account_name,
          },
          to: {
            bank_name: next.bank_name,
            account_number: next.account_number,
            account_name: next.account_name,
          },
        },
      }, client);
    } else {
      await audit.record({
        actorId,
        action: 'supplier.updated',
        entityType: 'supplier',
        entityId: id,
        metadata: { name: next.name },
      }, client);
    }

    return { supplier: publicSupplier(rows[0]), accountChanged };
  });
}

/**
 * A supplier becomes 'verified' only through a completed settlement history --
 * we never mark one verified on the strength of what a buyer typed in.
 */
async function markVerified(id, actorId) {
  const { rows: completed } = await db.query(
    `select count(*)::int as count
       from settlements
      where supplier_id = $1 and status = 'COMPLETED'`,
    [id]
  );
  if (completed[0].count === 0) {
    throw conflict('A supplier can only be verified after a completed settlement');
  }

  const { rows } = await db.query(
    `update suppliers set verification_status = 'verified', updated_at = now()
      where id = $1 returning *`,
    [id]
  );
  if (!rows[0]) throw notFound('Supplier not found');

  await audit.record({
    actorId,
    action: 'supplier.verified',
    entityType: 'supplier',
    entityId: id,
  });

  return publicSupplier(rows[0]);
}

module.exports = { create, getById, list, accountHistory, update, markVerified, publicSupplier };
