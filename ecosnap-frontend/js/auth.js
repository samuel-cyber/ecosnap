/* auth.js
 *
 * Login via Supabase Auth (report section 1.3 step 1), then immediately
 * create the matching app profile through the backend.
 *
 * That second step matters: Supabase Auth accounts live in auth.users, but
 * every EcoPoint, report and redemption hangs off the backend's own users
 * table. Without the profile row, POST /reports fails on its foreign key.
 */

import { config, hasSupabase } from './config.js';
import * as api from './api.js';

const SESSION_KEY = 'ecosnap.session';

let supabase = null;
let currentUser = null; // { id, display_name, neighborhood, eco_points }

/** Lazily creates the Supabase browser client. */
function client() {
  if (!hasSupabase()) return null;
  if (!window.supabase) {
    throw new Error(
      'The Supabase library did not load — check your connection, then reload. ' +
      'Auth and photo upload need it.'
    );
  }
  if (!supabase) {
    supabase = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  }
  return supabase;
}

/**
 * Hand the API layer a way to read the current access token. Guarded at every
 * step: with no Supabase configured there is no token, and the request goes
 * out exactly as it does today.
 */
api.setTokenProvider(async () => {
  try {
    if (!hasSupabase() || !window.supabase) return null;
    const { data } = await client().auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch {
    return null;
  }
});

export const getUser = () => currentUser;
export const isSignedIn = () => Boolean(currentUser);

function remember(user) {
  currentUser = user;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    /* private browsing — the session just won't survive a refresh */
  }
  // Lets the header's points chip update the moment points change, without
  // every screen having to know the header exists.
  window.dispatchEvent(new CustomEvent('ecosnap:user-changed', { detail: user }));
}

function forget() {
  currentUser = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Ensures the backend has a profile row for this auth user, then caches it.
 * Safe to call repeatedly — POST /users is idempotent.
 */
async function linkProfile(authUserId, displayName, neighborhood) {
  await api.createUser({ id: authUserId, displayName, neighborhood });
  const profile = await api.getUser(authUserId);
  remember(profile);
  return profile;
}

/** Restores a session on page load. */
export async function restore() {
  const sb = client();

  if (sb) {
    const { data } = await sb.auth.getSession();
    if (data && data.session && data.session.user) {
      const authUser = data.session.user;
      try {
        const profile = await api.getUser(authUser.id);
        remember(profile);
        return profile;
      } catch (error) {
        // Authenticated but no profile yet (e.g. first magic-link landing).
        if (error.status === 404) {
          return linkProfile(
            authUser.id,
            authUser.email ? authUser.email.split('@')[0] : 'EcoSnapper',
            null
          );
        }
        throw error;
      }
    }
    return null;
  }

  // No Supabase configured — fall back to the locally cached profile.
  try {
    const cached = localStorage.getItem(SESSION_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Re-read from the backend so points are never stale.
      try {
        const fresh = await api.getUser(parsed.id);
        remember(fresh);
        return fresh;
      } catch {
        remember(parsed);
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Sends a magic-link email. The user returns via the redirect URL. */
export async function signInWithEmail(email) {
  const sb = client();
  if (!sb) throw new Error('Supabase is not configured — add SUPABASE_URL and SUPABASE_ANON_KEY.');

  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
}

/** Anonymous sign-in — the fastest path for a demo (report section 1.3). */
export async function signInAnonymously(displayName, neighborhood) {
  const sb = client();
  if (!sb) throw new Error('Supabase is not configured — add SUPABASE_URL and SUPABASE_ANON_KEY.');

  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(error.message);

  return linkProfile(data.user.id, displayName || 'EcoSnapper', neighborhood);
}

/**
 * Development sign-in used when Supabase is not configured. It mints a UUID
 * locally and registers it with the backend, so the whole report -> points ->
 * leaderboard flow can be built and demoed before auth keys exist.
 *
 * The UI labels this clearly; it is not a way around authentication in
 * production, it is a way to keep working while waiting on keys.
 */
export async function signInLocal(displayName, neighborhood) {
  const id = crypto.randomUUID();
  return linkProfile(id, displayName || 'EcoSnapper', neighborhood);
}

/** Re-reads the profile so points shown are current. */
export async function refresh() {
  if (!currentUser) return null;
  const fresh = await api.getUser(currentUser.id);
  remember(fresh);
  return fresh;
}

export async function signOut() {
  const sb = client();
  if (sb) await sb.auth.signOut();
  forget();
}
