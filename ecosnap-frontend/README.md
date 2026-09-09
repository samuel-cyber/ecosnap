# EcoSnap — Frontend

Report burning trash and blocked drains in Lagos, earn EcoPoints, and put your
neighborhood on the leaderboard.

This implements **Part 1 (Frontend Developer)** of the EcoSnap Frontend & PM
Task Report, wired to the Express backend in `../ecosnap-backend`.

No build step. Plain ES modules plus four CDN libraries, so there's no
toolchain to break the morning of a demo.

## Run it

```bash
# From this directory. Serves the frontend AND a mock backend on :3000
node mock-api/server.js --seed
# → http://localhost:3000
```

To run against the **real** backend instead:

```bash
cd ../ecosnap-backend && npm install && npm run dev    # :3000
cd ../ecosnap-frontend && python3 -m http.server 5173  # any static server
```

...then set `API_BASE_URL` to `http://localhost:3000` in `config.local.js`.

## Configuration

Copy `config.local.example.js` to `config.local.js` (gitignored) and fill in:

| Key | What it unlocks | Where to get it |
|---|---|---|
| `API_BASE_URL` | Everything | `http://localhost:3000`, or `https://ecosnap-blue.vercel.app` |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Real accounts + photo upload | Supabase dashboard → Settings → API |
| `SUPABASE_STORAGE_BUCKET` | Photo upload | Bucket name, default `reports` |
| `MAPBOX_TOKEN` | Map pins | Mapbox → Account → Tokens |
| `TM_MODEL_URL` | AI classification | PM's Teachable Machine export (§2.2) |

**The app runs with none of these set.** A banner at the top names exactly
what's missing, and each unconfigured piece degrades to something honest
rather than something fake:

- No Supabase → "Continue as demo user" registers a real backend profile, so
  reports, points and the leaderboard all work end to end.
- No model → the review screen asks the user to pick the category and submits
  it labelled `manual:<category>`. **It never invents a confidence score.**
- No Mapbox → the map screen lists the same reports it would have plotted.
- No Storage → the photo isn't uploaded, and the UI says so plainly.

## Build order (report §1.3) — all 8 done

| # | Step | Where |
|---|---|---|
| 1 | Auth screen | `js/screens/auth.js`, `js/auth.js` |
| 2 | Camera capture | `js/screens/capture.js` (`<input capture="environment">`) |
| 3 | AI classification | `js/classifier.js` (TF.js + Teachable Machine) |
| 4 | Upload flow | `js/storage.js` → `POST /reports` |
| 5 | Map screen | `js/screens/map.js` (Mapbox GL JS, bbox filtering) |
| 6 | Leaderboard | `js/screens/leaderboard.js` |
| 7 | My Impact / profile | `js/screens/profile.js` |
| 8 | Redeem | `js/screens/redeem.js` |

Plus the **verified vs flagged result screen** the report calls out twice
(§1.2, §2.3): verified gets a celebratory `+10 EcoPoints`, flagged gets
"Thanks — we're double-checking this one". Flagged is never shown as an error.

## How it connects to the backend

`js/api.js` is the only file that talks to the backend. Every endpoint from
report §1.1:

| Method | Route | Used by |
|---|---|---|
| GET | `/ping` | Startup check — fails loudly with the URL it tried |
| POST | `/users` | After login, to create the app profile **(see below)** |
| GET | `/users/:id` | Profile, redeem, points chip |
| POST | `/reports` | Submitting a report |
| GET | `/reports` | Map, incl. `?minLat=&maxLat=&minLng=&maxLng=` on pan |
| GET | `/leaderboard` | Leaderboard |
| POST | `/redeem` | Rewards |

Two contract rules from §1.4 are enforced client-side, so a mistake fails with
a clear message instead of an opaque 400:

- `category` must be exactly `burning` or `blocked_drain`
- `ai_confidence` must be `0..1` — sending `91` instead of `0.91` is rejected

### One backend change was required

`POST /users` **did not exist**, and nothing else created rows in the backend's
`users` table. Supabase Auth stores accounts in `auth.users`, but every
EcoPoint, report and redemption hangs off the backend's own `public.users`
table, and `reports.user_id` has a foreign key onto it.

Without that row, a freshly signed-up user hit three failures: `POST /reports`
violated the foreign key, and `GET /users/:id` and `POST /redeem` both 404'd.
So `ecosnap-backend/src/routes/users.js` now has an idempotent `POST /users`,
which the frontend calls once at login. This is exactly the kind of
integration gap §2.6 warns about catching before demo day.

## The three-class model

The PM's model has **three** classes (`burning`, `blocked_drain`, and a
`none`/irrelevant class — §2.2) but the backend only accepts two categories.
`js/classifier.js` handles the mismatch:

- Class names are normalised, so "Blocked Drain", `blocked-drain` and
  `blocked_drain` all map correctly — a cosmetic naming choice in Teachable
  Machine won't break submission.
- A top prediction of `none` **blocks submission** and asks for another photo,
  rather than being coerced into one of the two real categories.
- Below-threshold confidence still submits, but warns the user it will
  probably come back flagged. The backend remains the only thing that decides.

## Notes

- Location uses `maximumAge: 0`. A cached fix meant someone reporting several
  drains along one street submitted them all at identical coordinates, which
  the backend's duplicate check then flagged — costing points for genuinely
  distinct reports.
- `mock-api/server.js` mirrors `ecosnap-backend/src/routes/*` exactly (same
  validation, same 0.75 threshold, same 1-hour/50m duplicate window, same
  neighborhood boxes). The real backend is the source of truth; if they
  disagree, the mock is wrong.
- Mapbox's WebGL context is released when navigating away from the map.
