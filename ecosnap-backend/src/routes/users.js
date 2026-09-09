const express = require("express");
const supabase = require("../config/supabaseClient");

const router = express.Router();

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /users
 * Create the app-side profile row for a freshly authenticated user.
 *
 * Supabase Auth stores accounts in auth.users, but every EcoPoint, report and
 * redemption in this app hangs off our own public.users table -- and nothing
 * was creating that row. Without it POST /reports fails on the foreign key,
 * and /users/:id and /redeem both 404. The frontend calls this once, right
 * after login.
 *
 * Idempotent: calling it again for an existing id returns the existing
 * profile rather than erroring, so a repeated login is harmless.
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
    if (!uuidPattern.test(id)) {
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

module.exports = router;