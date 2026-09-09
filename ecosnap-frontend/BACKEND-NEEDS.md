# Two endpoints the frontend needs

The frontend is finished and works end to end against the mock server in
`mock-api/` (`npm run dev`), which implements the whole API surface. Against
the **real** backend it needs two endpoints that don't exist yet.

Both go in `ecosnap-backend/src/routes/users.js`. Nothing else in the backend
changes.

---

## 1. `POST /users` — required, sign-in is broken without it

**Why.** Supabase Auth stores accounts in `auth.users`, but every EcoPoint,
report and redemption in this app hangs off our own `public.users` table — and
nothing creates that row. Without it:

- `POST /reports` fails on the `user_id` foreign key,
- `GET /users/:id` and `POST /redeem` both 404,
- so nobody can sign in at all.

The frontend calls this once, right after login (`js/auth.js`, `linkProfile`).
It's idempotent, so a repeated login is harmless.

**Request** `{ "id": "<uuid>", "display_name": "Ada", "neighborhood": "Yaba" }`
**Returns** `201` with the new profile, or `200` with the existing one.

```js
/**
 * POST /users
 * Create the app-side profile row for a freshly authenticated user.
 * Idempotent: calling it again for an existing id returns the existing
 * profile rather than erroring.
 */
router.post("/", async (req, res, next) => {
  try {
    const { id, display_name, neighborhood } = req.body || {};

    if (!id || !display_name) {
      return res.status(400).json({
        error: "id and display_name are required",
      });
    }

    if (!uuidPattern.test(id)) {
      return res.status(400).json({
        error: "Invalid user id format",
      });
    }

    // Already registered? Hand back what we have.
    const { data: existing, error: lookupError } = await supabase
      .from("users")
      .select("id, display_name, neighborhood, eco_points")
      .eq("id", id)
      .maybeSingle();

    if (lookupError) {
      throw new Error(`Failed to look up user: ${lookupError.message}`);
    }

    if (existing) {
      return res.json(existing);
    }

    const { data, error } = await supabase
      .from("users")
      .insert({
        id,
        display_name,
        neighborhood: neighborhood || null,
        eco_points: 0,
      })
      .select("id, display_name, neighborhood, eco_points")
      .single();

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});
```

---

## 2. `GET /users/:id/reports` — optional, improves "My Impact"

**Why.** `GET /reports` returns only verified reports and omits `user_id`, so
there's no way to show someone their own history — including the flagged ones,
which matter precisely because "flagged" is a normal outcome, not a failure.

The frontend degrades gracefully if this is missing: My Impact still shows
points, name and neighborhood, just without the report list and counts. It
never shows a wrong number.

**Returns** an array, newest first.

```js
/**
 * GET /users/:id/reports
 * A user's own reports, newest first.
 *
 * Must be declared BEFORE `router.get("/:id")`, or that route matches first.
 */
router.get("/:id/reports", async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!uuidPattern.test(id)) {
      return res.status(400).json({
        error: "Invalid user id format",
      });
    }

    const { data, error } = await supabase
      .from("reports")
      .select("id, category, status, points_awarded, neighborhood, lat, lng, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch reports: ${error.message}`);
    }

    return res.json(data);
  } catch (error) {
    next(error);
  }
});
```

---

## Placement

`users.js` already defines `uuidPattern` and imports `supabase`, so both
handlers drop in as-is. Order matters: put `/:id/reports` **above** the
existing `/:id` route, otherwise `/:id` matches `abc/reports` first.

---

## Two security notes, while you're in here

Neither is caused by the endpoints above — both already apply to the deployed
backend.

1. **The tables have no row-level security.** `schema.sql` creates `users`,
   `reports` and `redemptions` without enabling RLS, and the frontend ships a
   Supabase anon key publicly (it has to, for login). As it stands, anyone can
   take that key and read or write those tables directly through Supabase's
   REST API, bypassing this backend entirely — awarding themselves unlimited
   points. Because the frontend only uses Supabase for Auth and Storage and
   never queries tables, enabling RLS with **no policies** closes this without
   breaking anything, as long as the backend uses the `service_role` key
   (which bypasses RLS):

   ```sql
   alter table users       enable row level security;
   alter table reports     enable row level security;
   alter table redemptions enable row level security;
   ```

2. **The API doesn't verify who's calling.** Routes take `user_id` from the
   request body and trust it, so anyone can act as any user. The fix is to
   verify the Supabase JWT from the `Authorization` header and read the user id
   from the verified token instead of the body. Probably fine for a judged
   demo; not fine for real users.
