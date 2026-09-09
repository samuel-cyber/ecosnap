# Backend issues found while building the frontend

Written for whoever owns `ecosnap-backend`. Nothing here has been changed —
the backend is exactly as you left it. This is a list of what the frontend
ran into, worst first.

Two of these let anyone give themselves unlimited EcoPoints.

---

## 1. The server trusts the client's AI score — anyone can mint points

**Where:** `src/routes/reports.js` takes `ai_confidence` from the request body;
`src/services/reportService.js` compares it to `CONFIDENCE_THRESHOLD` (0.75)
to decide `status` and `points_awarded`.

**The problem.** Classification runs in the browser, so `ai_confidence` is a
number the client chooses. Nothing stops this:

```bash
curl -X POST https://your-backend/reports \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"<any uuid>","image_url":"https://example.com/x.jpg",
       "category":"burning","lat":6.5,"lng":3.4,
       "ai_label":"burning","ai_confidence":1}'
```

That returns `verified` and credits 10 points. Repeat in a loop — the only
brake is the duplicate check, and moving `lat`/`lng` a few metres defeats it.
The leaderboard and every reward become meaningless.

This is not theoretical. Run against a server carrying this logic, four
requests with a drifting coordinate and `ai_confidence: 1` produced:

```
verified points: 10
verified points: 10
verified points: 10
verified points: 10
-> 40 EcoPoints
```

No photo was uploaded and no user was signed in — `image_url` pointed at
example.com and `user_id` was a uuid typed by hand (see issue 2).

Validating the number harder does not fix it: `0.99` is as valid as `0.4`.
The trust boundary is in the wrong place.

**Options, roughly in order of effort:**

- **Classify server-side.** Backend downloads `image_url` and runs the model.
  Removes the hole completely; costs latency and hosting for inference.
- **Keep client scoring, but stop paying for it directly.** Award points only
  after a second signal — another user confirming the same spot, or a
  moderator pass. Client confidence becomes a hint for triage, not currency.
- **Accept it for the hackathon** and say so out loud in the demo. Fine for a
  judged prototype, not for real users. If you take this path, please add a
  comment at the decision point so nobody later assumes it is verified.

This one needs a product decision, not just a patch.

## 2. No authentication — any caller can act as any user

**Where:** every route. `user_id` arrives in the request body and is never
checked against a token.

`POST /reports`, `POST /redeem` and `GET /users/:id` all take a `user_id` on
trust, so anyone who knows a uuid can spend that person's points or report as
them. The frontend already signs users in through Supabase Auth and holds a
JWT, so the fix is mostly plumbing:

```js
// middleware/requireAuth.js
const { createClient } = require("@supabase/supabase-js");
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

Then mount it on the routes that act on a user, and read `req.userId` instead
of `req.body.user_id`. The frontend can start sending the header as soon as
you are ready — say the word and it will.

## 3. Tables have no row-level security

**Where:** `supabase/schema.sql`.

Supabase does not enable RLS on tables created through the SQL editor, and
nothing in the schema turns it on. The frontend has to ship the Supabase
**anon** key publicly to do auth and photo upload — which means that key is
readable by anyone, and with RLS off it can read and write `users`,
`reports` and `redemptions` **directly**, bypassing the API and every rule in
it. Someone can simply set their own `eco_points`.

```sql
alter table users       enable row level security;
alter table reports     enable row level security;
alter table redemptions enable row level security;
```

No policies needed for the current design: the backend uses the
`service_role` key, which bypasses RLS, and the frontend only uses Supabase
for Auth and Storage — it never queries these tables. That one change closes
the direct path while leaving the API working.

Worth confirming the backend's `SUPABASE_KEY` is the `service_role` key and
not the anon key, or these writes will start failing once RLS is on.

---

## Smaller things

**`GET /reports` omits `neighborhood`.** It returns `id, lat, lng, category,
created_at`, so the map's list view can only show raw coordinates —
"6.5095, 3.3711" instead of "Yaba". The column is already on the row; adding
it to the `select` is a one-word change.

**`GET /reports` is unpaginated.** It returns every verified report, forever.
Fine at demo size, not at a few thousand. A `limit`/`offset` or a
`since` parameter would do.

**No rate limiting.** Combined with issue 1, one script can fill the table.

**Rewards are recorded but never fulfilled.** `POST /redeem` deducts points
and writes a `redemptions` row; nothing delivers anything. The frontend says
so plainly on the Rewards screen, so this is a known gap rather than a bug —
worth deciding who closes it before launch.

**No tests.** The points and duplicate-detection rules in `reportService.js`
are the logic most worth pinning down, and they are pure enough to test
without a database.
