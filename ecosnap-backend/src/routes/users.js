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