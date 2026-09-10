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
| `TM_MODEL_URL` | AI classification | **Already set.** The trained model ships in `model/`; override only to swap in a retrained one |

**The app runs with none of these set.** A banner at the top names exactly
what's missing, and each unconfigured piece degrades to something honest
rather than something fake:

- No Supabase → "Continue as demo user" registers a real backend profile, so
  reports, points and the leaderboard all work end to end.
- The model ships with the app in `model/` (2.2MB, three classes), so
  classification works out of the box and does not depend on Teachable
  Machine's hosting staying up mid-demo. If it is ever unset or fails to
  load, the review screen asks the user to pick the category and submits it
  labelled `manual:<category>`. **It never invents a confidence score.**
- If the model calls a real hazard "not a hazard", **It is a hazard** on that
  screen hands classification back to the user rather than dead-ending the
  report. It still submits as `manual:<category>`.
- No Mapbox → the map screen lists the same reports it would have plotted.
- No Storage → the photo isn't uploaded, and the UI says so plainly.

## Deploying (Vercel)

This repository holds three separate projects (`ecosnap-frontend`,
`ecosnap-backend`, `trustock`) and nothing at its root. Vercel serves the
**Root Directory** you point it at, so a project left pointing at the repo root
finds no `index.html` and returns `404: NOT_FOUND`.

**Vercel → Settings → General → Root Directory → `ecosnap-frontend`.**
The backend is a separate Vercel project with its root set to
`ecosnap-backend` (it has its own `vercel.json`).

### Configuration comes from environment variables

The app is static — there is no server at runtime to read `process.env` — so
`scripts/build-config.js` runs at build time and writes `config.generated.js`
from `ECOSNAP_*` variables. `vercel.json` already wires it up as the build
command; nothing needs to be committed or hand-edited per environment.

Set these in **Vercel → Settings → Environment Variables**:

| Variable | Required | Value |
|---|---|---|
| `ECOSNAP_API_BASE_URL` | **yes** | The deployed backend, e.g. `https://ecosnap-backend.vercel.app` |
| `ECOSNAP_SUPABASE_URL` | for login | Supabase → Settings → API |
| `ECOSNAP_SUPABASE_ANON_KEY` | for login | The **anon/publishable** key — never the service_role key |
| `ECOSNAP_SUPABASE_STORAGE_BUCKET` | no | Defaults to `reports` |
| `ECOSNAP_MAPBOX_TOKEN` | for map pins | A **public** token (`pk.…`), scoped to your domain |
| `ECOSNAP_TM_MODEL_URL` | no | Defaults to the bundled `/model`. Set only to point at a hosted retrained model |

Only variables that are actually set get written; the rest fall through to the
defaults in `js/config.js` rather than being blanked out. Precedence is
`config.local.js` > `config.generated.js` > `js/config.js` defaults, so a local
file always beats a deployed setting and the dev workflow is unchanged.

The build **fails loudly** rather than shipping something broken when:

- `ECOSNAP_API_BASE_URL` is missing on a production deploy — otherwise the app
  silently falls back to `localhost:3000` and every visitor sees "Can't reach
  the backend".
- A Supabase **service_role** (or `sb_secret_…`) key is passed as the anon key.
  Everything written into `config.generated.js` is readable by anyone who opens
  the page; a service_role key there hands every visitor full database access,
  bypassing row-level security.
- A **secret** Mapbox token (`sk.…`) is passed instead of a public one.

To reproduce a deployment build locally:

```bash
ECOSNAP_API_BASE_URL=https://your-backend.vercel.app npm run build
```

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
| GET | `/users/:id/reports` | My Impact — the user's own report history |
| POST | `/reports` | Submitting a report |
| GET | `/reports` | Map, incl. `?minLat=&maxLat=&minLng=&maxLng=` on pan |
| GET | `/leaderboard` | Leaderboard |
| POST | `/redeem` | Rewards |

Two contract rules from §1.4 are enforced client-side, so a mistake fails with
a clear message instead of an opaque 400:

- `category` must be exactly `burning` or `blocked_drain`
- `ai_confidence` must be `0..1` — sending `91` instead of `0.91` is rejected

### The backend is untouched by this work

`ecosnap-backend/` is byte-identical to `main`. Everything the frontend needs
is already there.

Building against it did surface real problems, including two that let anyone
award themselves unlimited EcoPoints. They are written up for whoever owns
that service in [BACKEND-ISSUES.md](BACKEND-ISSUES.md) — nothing has been
changed on their behalf.

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
- Mapbox's WebGL context is released when navigating away from the map, and
  captured-photo object URLs are revoked rather than leaking for the life of
  the page.

## What could not be verified here

No Supabase, Mapbox or Teachable Machine credentials were available in the
build environment, and the CDNs were unreachable from it, so these paths are
written to the documented contracts but have **not** been run end to end:
magic-link email sign-in, Supabase Storage upload, live Mapbox tile rendering,
and real model inference. Everything else — the full report → points →
leaderboard → redeem flow, the flagged path, session persistence and the
backend-unreachable state — was driven in a real browser against the mock.
Worth an end-to-end pass once the keys and the model land, per §2.6.
