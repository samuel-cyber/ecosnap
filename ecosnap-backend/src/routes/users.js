const express = require("express");
const supabase = require("../config/supabaseClient");

const router = express.Router();

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
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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