const supabase = require("../config/supabaseClient");

const POINTS_PER_REPORT = 10;
const CONFIDENCE_THRESHOLD = 0.75;

// Roughly 50 meters in latitude/longitude.
// This is intentionally simple for the hackathon MVP.
const LAT_DELTA = 0.00045;
const LNG_DELTA = 0.00045;

async function findDuplicate(category, lat, lng) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("reports")
    .select("id")
    .eq("category", category)
    .gte("lat", lat - LAT_DELTA)
    .lte("lat", lat + LAT_DELTA)
    .gte("lng", lng - LNG_DELTA)
    .lte("lng", lng + LNG_DELTA)
    .gte("created_at", oneHourAgo)
    .limit(1);

  if (error) {
    throw new Error(`Failed to check for duplicate report: ${error.message}`);
  }

  return data && data.length > 0;
}

async function processReport({
  user_id,
  image_url,
  category,
  lat,
  lng,
  neighborhood,
  ai_label,
  ai_confidence,
}) {
  // 1. Check for duplicate
  const isDuplicate = await findDuplicate(category, lat, lng);

  // 2. Decide whether the report is verified
  const isVerified =
    !isDuplicate &&
    typeof ai_confidence === "number" &&
    ai_confidence >= CONFIDENCE_THRESHOLD;

  const status = isVerified ? "verified" : "flagged";
  const points_awarded = isVerified ? POINTS_PER_REPORT : 0;

  // 3. Insert the report
  const { data: report, error: reportError } = await supabase
    .from("reports")
    .insert({
      user_id,
      image_url,
      category,
      lat,
      lng,
      neighborhood,
      ai_label,
      ai_confidence,
      status,
      points_awarded,
    })
    .select("id, status, points_awarded, neighborhood")
    .single();

  if (reportError) {
    throw new Error(`Failed to create report: ${reportError.message}`);
  }

  // 4. Award points if verified
  if (isVerified) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("eco_points")
      .eq("id", user_id)
      .single();

    if (userError) {
      throw new Error(`Failed to fetch user points: ${userError.message}`);
    }

    const newPoints = user.eco_points + points_awarded;

    const { error: updateError } = await supabase
      .from("users")
      .update({ eco_points: newPoints })
      .eq("id", user_id);

    if (updateError) {
      throw new Error(`Failed to update user points: ${updateError.message}`);
    }
  }

  return report;
}

module.exports = {
  processReport,
};