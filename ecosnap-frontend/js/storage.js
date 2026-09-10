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
 * Phone cameras produce 3-6MB JPEGs, which over a Lagos mobile connection is
 * comfortably the slowest step in the whole flow. A 1280px long edge is far
 * more than the classifier or a map thumbnail needs, and cuts the upload to a
 * fraction of the size. Any failure here returns the original file, because a
 * slow upload beats a broken one.
 */
async function downscale(file, maxEdge = 1280) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], `${file.name.replace(/\.\w+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
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

  const upload = await downscale(file);
  const key = objectKey(userId, upload);

  const { error } = await sb.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .upload(key, upload, { cacheControl: '3600', upsert: false, contentType: upload.type });

  if (error) {
    throw new Error(
      `Photo upload failed: ${error.message}. ` +
        `Check the '${config.SUPABASE_STORAGE_BUCKET}' bucket exists and allows uploads.`
    );
  }

  const { data } = sb.storage.from(config.SUPABASE_STORAGE_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl, simulated: false };
}
