/* storage.js
 *
 * Uploads the captured photo to Supabase Storage and returns the public URL
 * (report section 1.3 step 4). The backend never receives the file itself --
 * only the resulting image_url.
 */

import { config, hasSupabase } from './config.js';

let supabase = null;

function client() {
  if (!hasSupabase() || !window.supabase) return null;
  if (!supabase) {
    supabase = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  }
  return supabase;
}

/** Keeps object keys tidy and collision-free. */
function objectKey(userId, file) {
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
  return `${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
}

/**
 * Uploads and returns { url, simulated }.
 *
 * When Supabase is not configured the file cannot be uploaded anywhere, so we
 * return a local object URL and mark it `simulated: true`. The UI surfaces
 * that plainly rather than pretending the photo was stored -- the rest of the
 * flow still works so the team isn't blocked waiting on storage credentials.
 */
export async function uploadPhoto(file, userId) {
  const sb = client();

  if (!sb) {
    return {
      url: URL.createObjectURL(file),
      simulated: true,
      notice:
        'Supabase Storage is not configured, so this photo was not uploaded. ' +
        'The report will reference a temporary local URL.',
    };
  }

  const key = objectKey(userId, file);

  const { error } = await sb.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .upload(key, file, { cacheControl: '3600', upsert: false, contentType: file.type });

  if (error) {
    throw new Error(
      `Photo upload failed: ${error.message}. ` +
        `Check the '${config.SUPABASE_STORAGE_BUCKET}' bucket exists and allows uploads.`
    );
  }

  const { data } = sb.storage.from(config.SUPABASE_STORAGE_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl, simulated: false };
}
