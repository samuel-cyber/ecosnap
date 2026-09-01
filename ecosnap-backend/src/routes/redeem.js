const express = require("express");
const supabase = require("../config/supabaseClient");

const router = express.Router();

/**
 * POST /redeem
 * Redeem EcoPoints for a reward.
 */
router.post("/", async (req, res, next) => {
  try {
    const { user_id, points_spent, reward_type } = req.body;

    // Basic validation
    if (!user_id || points_spent === undefined || !reward_type) {
      return res.status(400).json({
        error: "user_id, points_spent and reward_type are required",
      });
    }

    if (
      typeof points_spent !== "number" ||
      !Number.isInteger(points_spent) ||
      points_spent <= 0
    ) {
      return res.status(400).json({
        error: "points_spent must be a positive whole number",
      });
    }

    // Get current user balance
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, eco_points")
      .eq("id", user_id)
      .single();

    if (userError) {
      if (userError.code === "PGRST116") {
        return res.status(404).json({
          error: "User not found",
        });
      }

      throw new Error(`Failed to fetch user: ${userError.message}`);
    }

    // Check balance
    if (points_spent > user.eco_points) {
      return res.status(400).json({
        error: "Insufficient EcoPoints",
        current_points: user.eco_points,
        requested_points: points_spent,
      });
    }

    const newBalance = user.eco_points - points_spent;

    // Deduct points
    const { error: updateError } = await supabase
      .from("users")
      .update({ eco_points: newBalance })
      .eq("id", user_id);

    if (updateError) {
      throw new Error(`Failed to deduct EcoPoints: ${updateError.message}`);
    }

    // Record redemption
    const { error: redemptionError } = await supabase
      .from("redemptions")
      .insert({
        user_id,
        points_spent,
        reward_type,
        status: "fulfilled",
      });

    if (redemptionError) {
      throw new Error(
        `Failed to create redemption: ${redemptionError.message}`
      );
    }

    return res.json({
      success: true,
      message: "Reward Sent",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;