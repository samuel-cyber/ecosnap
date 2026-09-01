const express = require("express");
const { processReport } = require("../services/reportService");
const { getNeighborhood } = require("../services/geoService");
const supabase = require("../config/supabaseClient");

const router = express.Router();

/**
 * POST /reports
 * Create a new environmental report.
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      user_id,
      image_url,
      category,
      lat,
      lng,
      ai_label,
      ai_confidence,
    } = req.body || {};

    // Basic validation
    if (
      !user_id ||
      !image_url ||
      !category ||
      lat === undefined ||
      lng === undefined ||
      ai_label === undefined ||
      ai_confidence === undefined
    ) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    if (!["burning", "blocked_drain"].includes(category)) {
      return res.status(400).json({
        error: "Category must be 'burning' or 'blocked_drain'",
      });
    }

    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return res.status(400).json({
        error: "lat and lng must be valid numbers",
      });
    }

    if (
      typeof ai_confidence !== "number" ||
      !Number.isFinite(ai_confidence) ||
      ai_confidence < 0 ||
      ai_confidence > 1
    ) {
      return res.status(400).json({
        error: "ai_confidence must be a number between 0 and 1",
      });
    }

    // Determine neighborhood from coordinates
    const neighborhood = getNeighborhood(lat, lng);

    // Process report and apply verification/points rules
    const report = await processReport({
      user_id,
      image_url,
      category,
      lat,
      lng,
      neighborhood,
      ai_label,
      ai_confidence,
    });

    return res.status(201).json(report);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports
 * Return verified reports for the map.
 *
 * Optional query params:
 * minLat, maxLat, minLng, maxLng
 */
router.get("/", async (req, res, next) => {
  try {
    const { minLat, maxLat, minLng, maxLng } = req.query;

    let query = supabase
      .from("reports")
      .select("id, lat, lng, category, created_at")
      .eq("status", "verified");

    // Apply bounding box if all four values are provided
    if (
      minLat !== undefined &&
      maxLat !== undefined &&
      minLng !== undefined &&
      maxLng !== undefined
    ) {
      const bounds = [minLat, maxLat, minLng, maxLng].map(Number);

      if (bounds.some((value) => !Number.isFinite(value))) {
        return res.status(400).json({
          error: "Bounding box values must be valid numbers",
        });
      }

      query = query
        .gte("lat", bounds[0])
        .lte("lat", bounds[1])
        .gte("lng", bounds[2])
        .lte("lng", bounds[3]);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      throw new Error(`Failed to fetch reports: ${error.message}`);
    }

    return res.json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;