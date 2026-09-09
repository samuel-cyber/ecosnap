const express = require("express");
const supabase = require("../config/supabaseClient");

const router = express.Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /users
 * Idempotent — creates the backend profile row for a Supabase Auth user
 * the first time they log in. Safe to call on every login: if the row
 * already exists, this updates display_name/neighborhood but never
 * touches eco_points, so calling it repeatedly can't reset someone's
 * points.
 *
 * Required because Supabase Auth stores accounts in auth.users, but
 * every report/points/redemption in this app hangs off our own
 * public.users table (reports.user_id has a foreign key onto it).
 * Without this endpoint, a freshly signed-up user has no row here and
 * POST /reports, GET /users/:id, and POST /redeem all fail.
 */
router.post("/", async (req, res, next) => {
  try {
    const { id, display_name, neighborhood } = req.body || {};

    if (!id || !UUID_PATTERN.test(id)) {
      return res.status(400).json({
        error: "A valid user id (uuid) is required",
      });
    }

    if (!display_name) {
      return res.status(400).json({
        error: "display_name is required",
      });
    }

    // Upsert on id: creates the row on first login, and on every
    // subsequent login only refreshes display_name/neighborhood —
    // eco_points is never part of this payload, so it's never reset.
    const { data, error } = await supabase
      .from("users")
      .upsert(
        { id, display_name, neighborhood: neighborhood || null },
        { onConflict: "id" }
      )
      .select("id, display_name, neighborhood, eco_points")
      .single();

    if (error) {
      throw new Error(`Failed to create/update user: ${error.message}`);
    }

    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /users/:id
 * Get basic information about a user.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // Validate UUID shape before querying — Postgres rejects a
    // malformed id with a low-level error that's confusing to surface
    // directly, so we catch it here and return a clean 400 instead.
    if (!UUID_PATTERN.test(id)) {
      return res.status(400).json({
        error: "Invalid user id format",
      });
    }

    const { data, error } = await supabase
      .from("users")
      .select("id, display_name, neighborhood, eco_points")
      .eq("id", id)
      .single();

    if (error) {
      // Supabase returns PGRST116 when .single() finds no row
      if (error.code === "PGRST116") {
        return res.status(404).json({
          error: "User not found",
        });
      }

      throw new Error(`Failed to fetch user: ${error.message}`);
    }

    return res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /users/:id/reports
 * A user's own report history — verified AND flagged, since flagged
 * is a normal outcome, not a failure. GET /reports (the public map
 * feed) only returns verified reports and omits user_id, so there was
 * no other way for "My Impact" to show someone their own history
 * without silently under-counting the moment they redeemed points.
 */
router.get("/:id/reports", async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!UUID_PATTERN.test(id)) {
      return res.status(400).json({
        error: "Invalid user id format",
      });
    }

    const { data, error } = await supabase
      .from("reports")
      .select("id, category, status, points_awarded, lat, lng, neighborhood, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch user's reports: ${error.message}`);
    }

    return res.json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;