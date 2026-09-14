# Backend — what's left

For whoever owns `ecosnap-backend`. **Nothing here has been changed** — the
backend is exactly as you left it, including your `users.js` rewrite. Every
item was re-checked against the current code, not an earlier read.

This is a hackathon build, so it is ordered by what matters before a demo, and
split by **who can do it**: some of this a pull request fixes, and some of it
no amount of code can touch because it lives in a dashboard.

**Already done, thank you:** `GET /users/:id/reports` exists, so "My Impact"
shows a real report history.

**New on the frontend:** every API request now carries
`Authorization: Bearer <supabase jwt>` when a user is signed in. You do not
have to do anything with it — a backend that ignores the header is unaffected —
but it means `requireAuth` can be added whenever you want it, without a
flag-day deploy.

---

# Part 1 — Code

Things a pull request fixes. Merge, Vercel redeploys, done.

## 1. `GET /reports` doesn't return `neighborhood`  · before the demo

**Where:** `src/routes/reports.js`, the `.select()` in the `GET /` handler.

```js
.select("id, lat, lng, category, created_at")
```

The column is already on the row. Without it the map list can only show raw
coordinates — a judge sees `6.5095, 3.3711` where they should see `Yaba`,
which is the entire neighborhood-competition angle.

```js
.select("id, lat, lng, category, neighborhood, created_at")
```

One word. The frontend renders it the moment it appears.

## 2. `POST /redeem` deducts points before recording the redemption  · before the demo

**Where:** `src/routes/redeem.js` — the update at ~line 60, the insert at ~70.

The order is backwards and there is no transaction around the pair. Points come
off the balance first, then the `redemptions` row is written. If that insert
fails, the points are gone and there is no record the user ever redeemed
anything.

Write the redemption first, then deduct. An orphaned redemption row can be
reconciled by hand; silently vanished points cannot.

```js
// record first — an orphaned row can be reconciled,
// vanished points cannot
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

## 3. Redemptions are recorded as `"fulfilled"`  · before the demo

**Where:** `src/routes/redeem.js`, the insert payload.

```js
status: "fulfilled",
```

Nothing delivers a reward — no airtime, no voucher. The frontend says so
plainly on the Rewards screen, so the UI and the database currently disagree
about what happened. Write `"pending"`. One word, and "what happens after they
redeem?" becomes a question your schema already answers.

## 4. `requireAuth` — the frontend is already sending the token  · optional

**Where:** every route. `user_id` arrives in the body or the URL and is never
checked, so anyone who knows a uuid can spend that person's points or report as
them.

The frontend now sends the Supabase JWT on every request, so this is
self-contained:

```js
// src/middleware/requireAuth.js
const supabase = require("../config/supabaseClient");

module.exports = async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.userId = data.user.id;  // from the token, never the body
  next();
};
```

Mount it on the routes that act on a user, and read `req.userId` instead of
`req.body.user_id`.

**One caveat:** the frontend's "Continue as demo user" path mints a local uuid
with no Supabase session, so it sends no token. If you turn this on, that path
stops working and you will need real Supabase keys set for the demo.

## 5. Not before the demo, but pure code when you want them

- **Pagination.** `GET /reports` returns every verified report, forever. Fine
  at demo size. A `limit`/`offset` or `since` parameter does it.
- **Rate limiting.** `npm i express-rate-limit`, mount in `src/index.js`.
  Combined with item 6 below, one script can currently fill the table.
- **The `.rpc("award_points", ...)` call** — the calling code is a code change,
  but the function it calls is not. See Part 2, item 3.
- **Tests.** The points and duplicate rules in `reportService.js` are the logic
  most worth pinning down, and they are pure enough to test without a database.

---

# Part 2 — Not code

No pull request can do these. Someone has to open a dashboard and click.

The trap worth naming: pasting `alter table ... enable row level security;`
into `supabase/schema.sql` and merging it **does nothing at all.** There is no
migration runner in this repo — nothing reads that file. It is documentation.
The change only takes effect when a human runs it.

## 1. Confirm `SUPABASE_KEY` is the service_role key  · do this first

**Where:** Supabase → Settings → API, then your Vercel environment variables.

`src/config/supabaseClient.js` reads `SUPABASE_KEY` and passes it straight to
`createClient`. If that is the **anon** key rather than **service_role**, then
the moment RLS is enabled every backend write starts failing.

Check this before item 2, not after.

## 2. Turn on row-level security  · before the demo

**Where:** Supabase → SQL Editor → Run.

`supabase/schema.sql` contains no `enable row level security` and no policies.
Supabase does not enable RLS on tables created through the SQL editor.

The frontend must ship the Supabase **anon** key publicly to do auth and photo
upload, so that key is readable by anyone who opens the page. With RLS off, it
can read and write `users`, `reports` and `redemptions` **directly**, bypassing
your API and every rule in it. Someone can set their own `eco_points` without
touching a single endpoint.

```sql
alter table users       enable row level security;
alter table reports     enable row level security;
alter table redemptions enable row level security;
```

No policies are needed for the current design: the backend uses `service_role`,
which bypasses RLS, and the frontend only uses Supabase for Auth and Storage —
it never queries these tables. Three lines, and the direct path is closed while
the API keeps working exactly as it does now.

Commit the same three lines to `schema.sql` too, so the next person setting up
a database gets them — just don't mistake that commit for having applied them.

## 3. Create `award_points` — only if you do the atomic-points fix

**Where:** Supabase → SQL Editor → Run.

```sql
create function award_points(uid uuid, delta int)
returns void language sql as $$
  update users set eco_points = eco_points + delta where id = uid;
$$;
```

**Create this before deploying any code that calls it**, or reports and
redemptions start failing the moment that deploy lands.

## 4. Environment variables

**Where:** Vercel → Settings → Environment Variables.

`SUPABASE_URL` and `SUPABASE_KEY` are read at startup and the process throws
without them. They never belong in the repo.

---

# Known and accepted for a hackathon

Do not spend the week on this. Do have an answer ready — a technical judge will
ask, and "we know, here's the fix" beats being caught by it.

## The server trusts the client's AI score

**Where:** `src/routes/reports.js` reads `ai_confidence` from the body;
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
nobody needs to be signed in.

Validating harder does not help — `0.99` is as valid as `0.4`. The trust
boundary is in the wrong place, not the validation. The real fixes are
server-side classification, or awarding points only on a second signal
(another user confirming the same spot, a moderator pass). Both are more than
a hackathon needs.

Note the frontend also sends `ai_confidence: 1` for manual classifications,
labelled `ai_label: "manual:burning"`. That is deliberate and honest — it
happens when no model is configured, or when a user overrides the model's
verdict. It does mean **`ai_label` is what tells you whether a model was
involved, not `ai_confidence`.**

Taking the shortcut is fine. Just leave a comment at the decision point so
nobody later assumes it was verified.

---

# If this becomes real

Correct, but not worth your hackathon week.

**Points are read-modify-written, so concurrent updates lose.**
`reportService.js` reads `eco_points`, adds 10, writes it back; `redeem.js`
does the same in reverse. Two requests landing together and one update is lost.
The `award_points` function in Part 2 fixes this, and also closes double-spend
on redeem, where the balance check and the deduction are separate round trips.

**Nothing is transactional.** `processReport` inserts the report, then updates
points in a second call. If the second fails, the report is stored claiming
`points_awarded: 10` the user never received — and the API returns an error, so
the client believes nothing happened at all.
