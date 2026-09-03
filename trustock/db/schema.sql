-- Trustock database schema (PostgreSQL)
--
-- Money rule for the whole system: every amount is stored as BIGINT in KOBO
-- (the minor unit of the Naira). No floating point ever touches an amount,
-- because 0.1 + 0.2 !== 0.3 and money must be exact.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- users: the young entrepreneurs pooling their purchasing power
-- ---------------------------------------------------------------------------
create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  full_name      text not null,
  business_name  text,
  phone          text,
  role           text not null default 'entrepreneur'
                 check (role in ('entrepreneur', 'reviewer')),
  created_at     timestamptz not null default now()
);

create index if not exists users_email_idx on users (lower(email));

-- ---------------------------------------------------------------------------
-- suppliers: wholesalers being paid. A supplier does NOT need a Trustock
-- account -- a buyer can bring one they already deal with ("external").
-- ---------------------------------------------------------------------------
create table if not exists suppliers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text,
  email               text,
  bank_name           text not null,
  account_number      text not null,
  account_name        text not null,
  verification_status text not null default 'external'
                      check (verification_status in ('external', 'verified')),
  created_by          uuid not null references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists suppliers_account_idx on suppliers (bank_name, account_number);
create index if not exists suppliers_name_idx on suppliers (lower(name));

-- Every change to a supplier's payout destination is kept forever. A payout
-- account that changed shortly before settlement is one of the strongest
-- signals the risk engine has.
create table if not exists supplier_account_history (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references suppliers(id) on delete cascade,
  bank_name      text not null,
  account_number text not null,
  account_name   text not null,
  changed_by     uuid references users(id),
  created_at     timestamptz not null default now()
);

create index if not exists supplier_account_history_supplier_idx
  on supplier_account_history (supplier_id, created_at desc);

-- ---------------------------------------------------------------------------
-- pools: one wholesale purchase, funded by several entrepreneurs
-- ---------------------------------------------------------------------------
create table if not exists pools (
  id                       uuid primary key default gen_random_uuid(),
  reference                text not null unique,
  title                    text not null,
  description              text,
  creator_id               uuid not null references users(id),
  supplier_id              uuid not null references suppliers(id),
  target_amount_kobo       bigint not null check (target_amount_kobo > 0),
  contribution_amount_kobo bigint not null check (contribution_amount_kobo > 0),
  max_participants         integer not null check (max_participants between 2 and 50),
  deadline                 timestamptz not null,
  status                   text not null default 'CREATED' check (status in (
                             'CREATED', 'FUNDING', 'MOQ_REACHED', 'RISK_REVIEW',
                             'APPROVED', 'REJECTED', 'SETTLEMENT', 'COMPLETED',
                             'REFUNDING', 'REFUNDED', 'EXPIRED', 'CANCELLED')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists pools_status_idx on pools (status);
create index if not exists pools_creator_idx on pools (creator_id);

-- Every state change, with who caused it and why. This is the audit spine of
-- the settlement workflow.
create table if not exists pool_state_transitions (
  id          uuid primary key default gen_random_uuid(),
  -- now() is the transaction's start time, so two transitions written in one
  -- transaction share a timestamp. seq keeps the history in the order it
  -- actually happened.
  seq         bigserial not null,
  pool_id     uuid not null references pools(id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor_id    uuid references users(id),
  reason      text,
  created_at  timestamptz not null default now()
);

-- For databases created before seq existed.
alter table pool_state_transitions add column if not exists seq bigserial not null;

create index if not exists pool_state_transitions_pool_idx
  on pool_state_transitions (pool_id, seq);

-- ---------------------------------------------------------------------------
-- pool_members: who has committed to a pool
-- ---------------------------------------------------------------------------
create table if not exists pool_members (
  id                    uuid primary key default gen_random_uuid(),
  pool_id               uuid not null references pools(id) on delete cascade,
  user_id               uuid not null references users(id),
  committed_amount_kobo bigint not null check (committed_amount_kobo > 0),
  status                text not null default 'JOINED'
                        check (status in ('JOINED', 'PAID', 'LEFT')),
  joined_at             timestamptz not null default now(),
  unique (pool_id, user_id)
);

create index if not exists pool_members_pool_idx on pool_members (pool_id);

-- ---------------------------------------------------------------------------
-- contributions: money in. `mode` records whether the movement was a live
-- Ecobank call or the labelled simulator -- history must never lie about that.
-- ---------------------------------------------------------------------------
create table if not exists contributions (
  id                 uuid primary key default gen_random_uuid(),
  pool_id            uuid not null references pools(id) on delete cascade,
  user_id            uuid not null references users(id),
  amount_kobo        bigint not null check (amount_kobo > 0),
  status             text not null default 'PENDING'
                     check (status in ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
  provider           text not null default 'ecobank',
  provider_reference text,
  mode               text not null check (mode in ('live', 'simulated')),
  failure_reason     text,
  idempotency_key    text unique,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);

create index if not exists contributions_pool_idx on contributions (pool_id, status);
create index if not exists contributions_user_idx on contributions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- risk_assessments: explainable output of the trust layer
-- ---------------------------------------------------------------------------
create table if not exists risk_assessments (
  id            uuid primary key default gen_random_uuid(),
  pool_id       uuid not null references pools(id) on delete cascade,
  score         integer not null check (score between 0 and 100),
  level         text not null check (level in ('LOW', 'MEDIUM', 'HIGH')),
  decision      text not null check (decision in ('AUTO_APPROVE', 'REVIEW_REQUIRED')),
  signals       jsonb not null default '[]'::jsonb,
  checks_passed jsonb not null default '[]'::jsonb,
  engine_version text not null,
  data_quality  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists risk_assessments_pool_idx
  on risk_assessments (pool_id, created_at desc);

-- For databases created before checks_passed existed.
alter table risk_assessments add column if not exists checks_passed jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- reviews: a human decision on a flagged pool
-- ---------------------------------------------------------------------------
create table if not exists reviews (
  id                 uuid primary key default gen_random_uuid(),
  pool_id            uuid not null references pools(id) on delete cascade,
  risk_assessment_id uuid references risk_assessments(id),
  reviewer_id        uuid not null references users(id),
  decision           text not null check (decision in ('APPROVED', 'REJECTED')),
  notes              text,
  created_at         timestamptz not null default now()
);

create index if not exists reviews_pool_idx on reviews (pool_id, created_at desc);

-- ---------------------------------------------------------------------------
-- settlements: money out, to the supplier
-- ---------------------------------------------------------------------------
create table if not exists settlements (
  id                 uuid primary key default gen_random_uuid(),
  pool_id            uuid not null references pools(id) on delete cascade,
  supplier_id        uuid not null references suppliers(id),
  amount_kobo        bigint not null check (amount_kobo > 0),
  status             text not null default 'PENDING'
                     check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  provider           text not null default 'ecobank',
  provider_reference text,
  mode               text not null check (mode in ('live', 'simulated')),
  failure_reason     text,
  -- A pool settles once. The partial index below enforces that.
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create unique index if not exists settlements_one_active_per_pool
  on settlements (pool_id) where status <> 'FAILED';

-- ---------------------------------------------------------------------------
-- refunds: money back, when a pool is rejected or expires
-- ---------------------------------------------------------------------------
create table if not exists refunds (
  id                 uuid primary key default gen_random_uuid(),
  pool_id            uuid not null references pools(id) on delete cascade,
  contribution_id    uuid not null references contributions(id),
  user_id            uuid not null references users(id),
  amount_kobo        bigint not null check (amount_kobo > 0),
  status             text not null default 'PENDING'
                     check (status in ('PENDING', 'COMPLETED', 'FAILED')),
  provider_reference text,
  mode               text not null check (mode in ('live', 'simulated')),
  reason             text,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  unique (contribution_id)
);

create index if not exists refunds_pool_idx on refunds (pool_id);

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of everything that mattered
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  seq         bigserial not null,   -- see pool_state_transitions.seq
  actor_id    uuid references users(id),
  actor_type  text not null default 'user'
              check (actor_type in ('user', 'system')),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table audit_log add column if not exists seq bigserial not null;

create index if not exists audit_log_entity_idx on audit_log (entity_type, entity_id, seq);
create index if not exists audit_log_actor_idx on audit_log (actor_id, seq desc);

commit;
