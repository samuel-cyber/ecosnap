# Backend issues — EcoSnap

Written for whoever owns `ecosnap-backend`. **Nothing here has been changed** —
the backend is exactly as you left it, including your `users.js` rewrite. This
is what the frontend ran into, checked against the current code.

This is a hackathon build, so it is ordered by what actually matters before a
demo, not by what a production review would flag first. The last section is
the "if this becomes real" list — genuinely fine to leave alone this week.

**Already fixed, thank you:** `GET /users/:id/reports` now exists, so the
"My Impact" screen shows a real report history instead of hiding it.

---

## Fix before the demo

Three small ones. Together they are maybe twenty minutes.

### 1. `GET /reports` doesn't return `neighborhood`

**Where:** `src/routes/reports.js`, the `.select()` in the `GET /` handler.

```js
.select("id, lat, lng, category, created_at")
```

The column is already on the row. Without it the map's list view can only show
raw coordinates — a judge sees `6.5095, 3.3711` where they should see `Yaba`,
which is the whole point of the neighborhood angle.

```js
.select("id, lat, lng, category, neighborhood, created_at")
```

One word. The frontend already renders it the moment it appears.

### 2. `POST /redeem` deducts the points before recording the redemption

**Where:** `src/routes/redeem.js` — the update at line ~60, the insert at ~70.

The order is backwards. Points come off the balance first, then the
`redemptions` row is written. If that insert fails, the user's points are gone
and there is no record they ever redeemed anything. There is no transaction
around the pair, so nothing rolls it back.

Cheapest correct version: write the redemption first, then deduct. A redemption
row with the points still in the balance is a recoverable inconsistency; the
other direction is a user quietly losing points.

```js
// record first — an orphaned redemption row can be reconciled,
// silently-vanished points cannot
const { error: redemptionError } = await supabase
  .from("redemptions")
  .insert({ user_id, points_spent, reward_type, status: "pending" });

if (redemptionError) {
  throw new Error(`Failed to create redemption: ${redemptionError.message}`);
}

const { error: updateError } = await supabase
  .from("users")
  .update({ eco_points: newBalance })
  .eq("id", user_id);
```

### 3. Redemptions are recorded as `"fulfilled"` when nothing is fulfilled

**Where:** `src/routes/redeem.js`, the insert payload.

```js
status: "fulfilled",
```

Nothing delivers a reward — no airtime, no voucher. The frontend says so
plainly on the Rewards screen, so the UI and the database currently disagree
about what happened. Write `"pending"` instead. It costs one word and it means
that when someone asks "so what happens after they redeem?", the honest answer
is already in your schema.

---

## Worth the three lines: turn on row-level security

**Where:** `supabase/schema.sql` — there is no `enable row level security`
anywhere in it, and no policies.

Supabase does not enable RLS on tables created through the SQL editor. The
frontend has to ship the Supabase **anon** key publicly to do auth and photo
upload, which means that key is readable by anyone who opens the page. With RLS
off, that key can read and write `users`, `reports` and `redemptions`
**directly**, bypassing your API and every rule in it. Someone can set their
own `eco_points` without touching a single endpoint.

```sql
alter table users       enable row level security;
alter table reports     enable row level security;
alter table redemptions enable row level security;
```

No policies are needed for the current design: the backend uses the
`service_role` key, which bypasses RLS, and the frontend only uses Supabase for
Auth and Storage — it never queries these tables. That one change closes the
direct path while leaving the API working exactly as it does now.

Worth confirming your `SUPABASE_KEY` is the `service_role` key and not the anon
key, or these writes will start failing the moment RLS is on.

---

## Known and acceptable for a hackathon — but say it out loud

Do not spend the week on these. Do have an answer ready, because a technical
judge will ask, and "we know, here's the fix" is a much better answer than
being caught by it.

### The server trusts the client's AI score

**Where:** `src/routes/reports.js` reads `ai_confidence` from the request body;
`src/services/reportService.js` compares it to `CONFIDENCE_THRESHOLD` (0.75) to
decide `status` and `points_awarded`.

Classification runs in the browser, so `ai_confidence` is a number the client
chooses. Nothing stops this:

```bash
curl -X POST https://your-backend/reports \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"<any uuid>","image_url":"https://example.com/x.jpg",
       "category":"burning","lat":6.5,"lng":3.4,
       "ai_label":"burning","ai_confidence":1}'
```

That returns `verified` and credits 10 points. The only brake is the duplicate
check, and moving `lat`/`lng` a few metres defeats it. No photo is uploaded and
no user needs to be signed in.

Validating the number harder does not help: `0.99` is as valid as `0.4`. The
trust boundary is in the wrong place, not the validation.

Note that the frontend also sends `ai_confidence: 1` for manual
classifications, labelled `ai_label: "manual:burning"`. That is deliberate and
honest — but it means `ai_label` is the field that tells you whether a model was
involved, not the confidence.

The real fix is to classify server-side, or to award points only on a second
signal (another user confirming the same spot, or a moderator pass). Both are
more than a hackathon needs. **Taking the shortcut is fine — just put a comment
at the decision point so nobody later assumes it was verified.**

### No authentication — any caller can act as any user

**Where:** every route. `user_id` arrives in the request body or the URL and is
never checked against a token.

`POST /reports`, `POST /redeem` and `GET /users/:id` all take a user id on
trust, so anyone who knows a uuid can spend that person's points or report as
them. The frontend already signs users in through Supabase Auth and holds a
JWT, so if you want it, the fix is mostly plumbing:

```js
// middleware/requireAuth.js
const supabase = require("../config/supabaseClient");

module.exports = async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid token" });

  req.userId = data.user.id;   // take the id from the token, never the body
  next();
};
```

Mount it on the routes that act on a user and read `req.userId` instead of
`req.body.user_id`. The frontend can start sending the header whenever you are
ready — say the word and it will.

---

## If this becomes real

Correct, but not worth your hackathon week.

**Points are read-modify-written, so concurrent updates lose.**
`reportService.js` reads `eco_points`, adds 10, writes it back;
`redeem.js` does the same in reverse. Two requests landing together and one
update is silently lost. Postgres can do this atomically:

```sql
create function award_points(uid uuid, delta int)
returns void language sql as $$
  update users set eco_points = eco_points + delta where id = uid;
$$;
```

Then `supabase.rpc("award_points", { uid: user_id, delta: 10 })`. This also
fixes double-spend on redeem, where the balance check and the deduction are
two separate round trips.

**Nothing is transactional.** `processReport` inserts the report, then updates
the points in a second call. If the second fails, the report is already stored
claiming `points_awarded: 10` that the user never received — and the API
returns an error, so the client thinks nothing happened at all.

**`GET /reports` is unpaginated.** It returns every verified report, forever.
Fine at demo size, not at a few thousand. A `limit`/`offset` or a `since`
parameter would do it.

**No rate limiting.** Combined with the client-supplied confidence score, one
script can fill the table.

**No tests.** The points and duplicate-detection rules in `reportService.js`
are the logic most worth pinning down, and they are pure enough to test
without a database.
