/* config.js
 *
 * Every environment-specific value lives here. Nothing else in the app reads a
 * URL or a key directly.
 *
 * To point the app at your own Supabase/Mapbox/model without editing tracked
 * files, copy config.local.example.js to config.local.js and fill it in --
 * config.local.js is gitignored and its values win over everything below.
 */

const defaults = {
  // The EcoSnap backend (Part 1 section 1.1).
  //   local dev:  http://localhost:3000
  //   deployed:   https://ecosnap-blue.vercel.app
  API_BASE_URL: 'http://localhost:3000',

  // Supabase — used for Auth (login) and Storage (photo upload) only.
  // All report/points data goes through the backend API above, not direct.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_STORAGE_BUCKET: 'reports',

  // Mapbox GL JS access token for the map screen.
  MAPBOX_TOKEN: '',

  // Teachable Machine model. The trained export ships with the app under
  // /model, so classification works with nothing configured and does not
  // depend on Teachable Machine's hosting staying up mid-demo. Override with
  // a hosted folder (holding model.json + metadata.json) to swap in a
  // retrained model without redeploying.
  TM_MODEL_URL: '/model',

  // Backend awards points at >= 0.75 confidence. Mirrored here purely so the
  // UI can warn "this may come back flagged" before the user submits -- the
  // backend remains the only thing that actually decides.
  CONFIDENCE_THRESHOLD: 0.75,

  // Fallback map centre: Yaba, Lagos (matches the backend's geoService bounds).
  DEFAULT_CENTER: { lat: 6.5095, lng: 3.3711 },

  // Approximate centres for the neighborhoods the sign-up screen offers. Used
  // only when the device refuses a GPS fix, so a report can still be filed
  // rather than the whole flow dead-ending -- the UI labels it as approximate.
  NEIGHBORHOOD_CENTERS: {
    Yaba: { lat: 6.5095, lng: 3.3711 },
    Surulere: { lat: 6.4926, lng: 3.3543 },
    Ikeja: { lat: 6.6018, lng: 3.3515 },
  },
};

const overrides =
  typeof window !== 'undefined' && window.ECOSNAP_CONFIG ? window.ECOSNAP_CONFIG : {};

export const config = { ...defaults, ...overrides };

/** True when a real Teachable Machine model has been wired up. */
export const hasModel = () => Boolean(config.TM_MODEL_URL);

/** True when Supabase (auth + storage) is configured. */
export const hasSupabase = () =>
  Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);

/** True when the map screen can render real tiles (token AND library present). */
export const hasMapbox = () =>
  Boolean(config.MAPBOX_TOKEN) && typeof window !== 'undefined' && Boolean(window.mapboxgl);
