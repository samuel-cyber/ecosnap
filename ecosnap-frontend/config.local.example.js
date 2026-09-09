/* config.local.example.js
 *
 * Copy this to config.local.js (gitignored) and fill in your own values.
 * Anything set here overrides the defaults in js/config.js.
 */
window.ECOSNAP_CONFIG = {
  // Backend. Use the deployed URL for a phone demo; localhost for dev.
  API_BASE_URL: 'http://localhost:3000',
  // API_BASE_URL: 'https://ecosnap-blue.vercel.app',

  // Supabase project — Settings → API in the Supabase dashboard.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_STORAGE_BUCKET: 'reports',

  // Mapbox → Account → Tokens.
  MAPBOX_TOKEN: '',

  // From the PM: Teachable Machine → Export → TensorFlow.js → Upload.
  // Paste the shared model URL (the folder, not model.json itself).
  TM_MODEL_URL: '',
};
