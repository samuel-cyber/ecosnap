// src/services/auditService.js
// Append-only trail. Every write takes an optional transaction client so an
// audit entry commits or rolls back together with the thing it describes --
// an audit log that can disagree with reality is worse than none.

const db = require('../config/db');

async function record(
  { actorId = null, actorType = 'user', action, entityType, entityId = null, metadata = {} },
  client
) {
  const runner = client || db;
  const { rows } = await runner.query(
    `insert into audit_log (actor_id, actor_type, action, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, $6)
     returning id, created_at`,
    [actorId, actorType, action, entityType, entityId, metadata]
  );
  return rows[0];
}

async function listForEntity(entityType, entityId, limit = 100) {
  const { rows } = await db.query(
    `select a.id, a.action, a.actor_type, a.actor_id, a.metadata, a.created_at,
            u.full_name as actor_name
       from audit_log a
       left join users u on u.id = a.actor_id
      where a.entity_type = $1 and a.entity_id = $2
      order by a.seq asc
      limit $3`,
    [entityType, entityId, limit]
  );
  return rows;
}

async function listRecent(limit = 100) {
  const { rows } = await db.query(
    `select a.id, a.action, a.actor_type, a.actor_id, a.entity_type, a.entity_id,
            a.metadata, a.created_at, u.full_name as actor_name
       from audit_log a
       left join users u on u.id = a.actor_id
      order by a.seq desc
      limit $1`,
    [limit]
  );
  return rows;
}

module.exports = { record, listForEntity, listRecent };
