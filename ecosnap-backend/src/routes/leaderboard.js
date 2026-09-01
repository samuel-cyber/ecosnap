const express = require("express");
const supabase = require("../config/supabaseClient");

const router = express.Router();

/**
 * GET /leaderboard
 * Returns neighborhoods ranked by total EcoPoints.
 */
router.get("/", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("neighborhood, eco_points");

    if (error) {
      throw new Error(`Failed to fetch leaderboard: ${error.message}`);
    }

    // Group users' EcoPoints by their neighborhood
    const totals = {};

    for (const user of data) {
      const neighborhood = user.neighborhood || "Unknown";

      if (!totals[neighborhood]) {
        totals[neighborhood] = 0;
      }

      totals[neighborhood] += user.eco_points || 0;
    }

    // Convert object into sorted array
    const leaderboard = Object.entries(totals)
      .map(([neighborhood, total_points]) => ({
        neighborhood,
        total_points,
      }))
      .sort((a, b) => b.total_points - a.total_points);

    return res.json(leaderboard);
  } catch (error) {
    next(error);
  }
});

module.exports = router;