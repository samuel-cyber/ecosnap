/* api.js
 *
 * The one place that talks to the EcoSnap backend. Endpoints and payload
 * shapes follow section 1.2 of the Frontend & PM report exactly.
 */

import { config } from './config.js';

/** Error carrying the backend's status code and message, so screens can react. */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const url = `${config.API_BASE_URL.replace(/\/$/, '')}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // fetch() only rejects on genuine network/CORS failure. Section 1.4 of the
    // report calls this out: a CORS error is a backend fix, not a frontend bug.
    throw new ApiError(
      `Could not reach the backend at ${config.API_BASE_URL}. ` +
        'Check it is running, and check the browser console for a CORS error.',
      0,
      null
    );
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      (payload && payload.error) || `Request failed (${response.status})`,
      response.status,
      payload
    );
  }

  return payload;
}

/** GET /ping — health check. */
export const ping = () => request('/ping');

/**
 * POST /users — create this user's app profile.
 * Idempotent; safe to call on every login.
 */
export const createUser = ({ id, displayName, neighborhood }) =>
  request('/users', {
    method: 'POST',
    body: { id, display_name: displayName, neighborhood },
  });

/** GET /users/:id — profile + points. 400 on bad uuid, 404 if absent. */
export const getUser = (id) => request(`/users/${id}`);

/** GET /users/:id/reports — this user's own reports, verified and flagged. */
export const getUserReports = (id) => request(`/users/${id}/reports`);

/**
 * POST /reports — submit a report.
 *
 * category MUST be exactly 'burning' or 'blocked_drain', and confidence MUST
 * be 0..1 rather than a percentage (report section 1.4) -- both are enforced
 * here so a bad value fails loudly on our side instead of as an opaque 400.
 */
export function createReport({ userId, imageUrl, category, lat, lng, aiLabel, aiConfidence }) {
  if (!['burning', 'blocked_drain'].includes(category)) {
    throw new ApiError(`category must be 'burning' or 'blocked_drain', got '${category}'`, 0, null);
  }
  if (typeof aiConfidence !== 'number' || aiConfidence < 0 || aiConfidence > 1) {
    throw new ApiError(
      `ai_confidence must be a number between 0 and 1, got ${aiConfidence}. ` +
        'Send 0.91, not 91.',
      0,
      null
    );
  }

  return request('/reports', {
    method: 'POST',
    body: {
      user_id: userId,
      image_url: imageUrl,
      category,
      lat,
      lng,
      ai_label: aiLabel,
      ai_confidence: aiConfidence,
    },
  });
}

/**
 * GET /reports — verified reports for the map.
 * Pass map bounds to use the backend's bounding-box filter.
 */
export function getReports(bounds) {
  if (!bounds) return request('/reports');

  const query = new URLSearchParams({
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
    minLng: bounds.minLng,
    maxLng: bounds.maxLng,
  });
  return request(`/reports?${query}`);
}

/** GET /leaderboard — neighborhoods ranked by points, already sorted. */
export const getLeaderboard = () => request('/leaderboard');

/** POST /redeem — spend points. 400 with a message if the balance is short. */
export const redeem = ({ userId, pointsSpent, rewardType }) =>
  request('/redeem', {
    method: 'POST',
    body: { user_id: userId, points_spent: pointsSpent, reward_type: rewardType },
  });
