# Trustock

**Trusted group buying for young businesses.**
Pool your purchasing power. Protect your transaction.

Built for Ecobank InnovateX 2026. Status: MVP.

Trustock lets young entrepreneurs combine their money to reach wholesale
minimum-order quantities (MOQs) they couldn't afford individually, then adds a
trust and risk layer around the pooled transaction before settlement. It turns
informal group buying — usually a WhatsApp group and manual bank transfers —
into a structured, risk-aware financial workflow.

## The workflow

```
CREATED → FUNDING → MOQ_REACHED → RISK_REVIEW → APPROVED → SETTLEMENT → COMPLETED
                                        │
                                        └→ REJECTED → REFUNDING → REFUNDED
```

1. **Pool** — an entrepreneur creates a pool with a wholesale target, a
   per-person contribution amount, and a supplier. Others join.
2. **Pay** — each member contributes their share. The last contribution to
   reach the target moves the pool to `MOQ_REACHED`.
3. **Protect** — Trustock runs an explainable rule engine over the supplier,
   the transaction, and the pool's behaviour. A LOW result clears itself
   straight to `APPROVED`. Anything else pauses the payout in `RISK_REVIEW`
   for a human to decide.
4. **Settle** — an approved pool pays the supplier. A rejected, expired, or
   cancelled pool refunds every contributor instead.

Every step is backed by a real PostgreSQL database, a real state machine that
refuses illegal transitions, and an append-only audit log.

## Why this exists

Suppliers do **not** need a Trustock account — a buyer can bring a wholesaler
they already deal with, entered as an "external" supplier. The one thing
Trustock is strict about is the payout account: every version of it is kept in
history, because a payout account that changed shortly before settlement is
the strongest fraud signal available, whatever the eventual explanation turns
out to be. That single case — pool funds, then the destination account
changes — is the scenario the whole product is built around, and it's what the
seeded demo pool (`TS-DEMO0RISK`) reproduces.

## Quick start

```bash
npm install
createdb trustock                      # or: psql -c "create database trustock"
cp .env.example .env                   # fill in DATABASE_URL / JWT_SECRET
npm run migrate                        # applies db/schema.sql
npm run seed -- --reset                # synthetic demo data — see below
npm start                              # http://localhost:4000
```

Then either open `http://localhost:4000` in a browser, or run the scripted
walkthrough in a second terminal:

```bash
npm run demo
```

`npm run demo` drives the entire brief's "Definition of Done" over the real
HTTP API: create → join → contribute → MOQ reached → risk assessment → both
the LOW-risk settlement path and the HIGH-risk pause/review/refund path →
final transaction history.

### Demo accounts

Password for all of them: `trustock123`.

| Email | Role |
|---|---|
| `amara@trustock.demo` | Pool organiser |
| `tunde@trustock.demo`, `zainab@trustock.demo`, `chidi@trustock.demo` | Members, already paid |
| `ifeoma@trustock.demo` | Member who **has not paid yet** — sign in as her to complete a pool live |
| `reviewer@trustock.demo` | Trustock reviewer — the only account that can approve a HIGH-risk payout |

Two active pools are seeded, both at 80% funded (₦200,000 / ₦250,000):

- **`TS-DEMO0CLEAN`** — a clean supplier with a settled transaction history.
  Pay the last share as Ifeoma, run the risk assessment: **LOW risk**, clears
  to settlement automatically.
- **`TS-DEMO0RISK`** — the supplier's payout account was changed two hours
  ago, after four members had already paid. Pay the last share, run the
  assessment: **HIGH risk**, payout paused, needs the reviewer account to
  approve or reject.

**All seed data is synthetic.** No real person, business, or bank account is
represented, and every transaction it produces is clearly labelled
`SIMULATED` (see below).

## Honesty about the Ecobank integration

This build could not verify the exact InnovateX-issued Ecobank API contract —
the developer portal domains were unreachable from this environment during
development. Rather than fabricate an integration against a guessed contract,
`src/services/ecobank/` is a swappable adapter with two implementations:

- **`simulator.js`** (default, `ECOBANK_MODE=simulated`) — deterministic,
  touches nothing real, and every result is labelled `simulated: true`. This
  is what `npm run seed` and `npm run demo` run against.
- **`client.js`** (`ECOBANK_MODE=live`) — a real HTTP client against the
  configured Ecobank base URL. The app **refuses to start** in `live` mode
  unless every credential (`ECOBANK_BASE_URL`, `ECOBANK_LAB_ID`,
  `ECOBANK_USERNAME`, `ECOBANK_PASSWORD`, `ECOBANK_SOURCE_ACCOUNT`) is
  present — it will not silently pretend to be live. Endpoint paths
  (`ECOBANK_PATH_*` in `.env`) are configuration, not hard-coded, so
  confirming them against the real InnovateX documentation is a config
  change, not a rewrite.

Every transaction — contribution, settlement, refund — is stamped with the
mode it ran in, in the database, the API response, and the UI (the banner at
the top of every screen, the `SIM` tags on line items). `GET
/api/system/integration` reports the live/simulated state machine-readably.

## The trust layer

`src/services/risk/rules.js` is a pure, deterministic, unit-tested rule
engine — no network calls, no black box. Each rule inspects one fact (has the
payout account changed? does the account name match the supplier? is one
member funding most of an "even split" pool?) and returns either nothing, or a
signal with a plain-language explanation and the evidence behind it. A LOW
result also reports every check that ran and came back clean — the point is
to show what was verified, not just what went wrong.

Two deliberate design choices:

- **Absence of evidence is not evidence.** A new platform has a lot of "no
  history to compare against" signals, and if those stacked freely, every
  honest first purchase would be flagged. Low-severity ("we don't know")
  signals are capped in their total contribution to the score, and a HIGH
  result requires at least one high-severity finding — something that
  actually happened, not just something unverifiable.
- **The engine never claims certainty.** Every assessment carries a
  disclaimer: it cannot prove a transaction is safe, and it cannot prove one
  is fraudulent. It's evidence for a human decision, and a HIGH-risk payout
  cannot be self-approved by the pool's own organiser — only a reviewer
  account can clear it.

## Architecture

```
src/
  app.js                    Express app wiring
  config/{env,db}.js        Config validation, PostgreSQL pool + transaction helper
  lib/                      money (kobo-exact), poolState (state machine), validate, nameMatch
  middleware/                auth (JWT), rateLimit, errorHandler
  services/
    authService, supplierService, poolService, contributionService,
    riskService, settlementService, auditService
    ecobank/                 index.js (adapter) → client.js (live) | simulator.js
    risk/rules.js             the explainable rule engine
  routes/                    auth, pools, suppliers, transactions, system
public/                      static dashboard (no build step: fetch + hash router)
db/schema.sql                PostgreSQL schema, idempotent (create if not exists)
scripts/{migrate,seed,demo}.js
tests/                       36 tests: unit (money, state machine, risk rules)
                              + integration (full HTTP workflow against real PostgreSQL)
```

**Money** is stored as `bigint` kobo everywhere — `src/lib/money.js` is the
only file allowed to convert between naira and kobo, so a rounding bug can
only ever exist in one place.

**State transitions** all go through one function
(`poolService.transition`), which checks the move is legal, writes it to
`pool_state_transitions`, and audits it — inside the same database
transaction as the change itself, so status and paper trail can never
disagree.

**Money movement** (contribute / settle / refund) follows the same shape
throughout: a short transaction records intent with the relevant row locked,
then the Ecobank call happens with *no* lock held, then a second short
transaction records the outcome. This is deliberate — holding a database lock
open across a network call is how payment systems deadlock under load.
Contributions carry an idempotency key, so a retried request is detected and
returned as-is rather than charging twice.

## Tests

```bash
createdb trustock_test   # once
npm test
```

36 tests, all against a real PostgreSQL database (no mocked persistence
layer): exact-kobo money arithmetic, every legal and illegal state
transition, the risk engine's scoring on both clean and adversarial inputs,
and the full HTTP workflow — create, join, fund, idempotent contributions, a
clean LOW-risk settlement, and the complete HIGH-risk pause → reviewer
rejection → full refund path, verified against the database to the kobo.

## What's deliberately not built

Per the brief: no marketplace, product feed, in-app chat, social network, AI
chatbot, demand forecasting, recommendation system, fraud graph, loans, credit
scoring, blockchain, or fake KYC. One workflow, done properly, beats twenty
unfinished features.
