#!/usr/bin/env node
/* scripts/build-config.js
 *
 * Writes config.generated.js from environment variables, so a deployment can
 * be configured without committing anything or hand-editing files.
 *
 * This exists because the app is static: there is no server at runtime to read
 * process.env, so the values have to be baked in while the build is running.
 * Vercel (Settings -> Environment Variables) is the intended source.
 *
 * Only variables that are actually set are written out. Anything absent falls
 * through to the defaults in js/config.js, rather than being clobbered with an
 * empty string.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'config.generated.js');

// Environment variable -> the key js/config.js expects.
const MAPPING = {
  ECOSNAP_API_BASE_URL: 'API_BASE_URL',
  ECOSNAP_SUPABASE_URL: 'SUPABASE_URL',
  ECOSNAP_SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  ECOSNAP_SUPABASE_STORAGE_BUCKET: 'SUPABASE_STORAGE_BUCKET',
  ECOSNAP_MAPBOX_TOKEN: 'MAPBOX_TOKEN',
  ECOSNAP_TM_MODEL_URL: 'TM_MODEL_URL',
};

/**
 * Everything written here ends up readable by anyone who opens the page, so
 * only publishable credentials belong in it. These checks exist to stop a
 * privileged key being shipped to the browser by accident -- a Supabase
 * service_role key in a static bundle hands every visitor full database
 * access, bypassing row-level security entirely.
 */
function assertPublishable(configKey, value) {
  if (configKey === 'SUPABASE_ANON_KEY') {
    if (value.startsWith('sb_secret_')) {
      throw new Error(
        'ECOSNAP_SUPABASE_ANON_KEY looks like a Supabase SECRET key (sb_secret_...). ' +
        'That key must never reach the browser. Use the publishable/anon key instead.'
      );
    }
    const parts = value.split('.');
    if (parts.length === 3) {
      try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (claims.role && claims.role !== 'anon') {
          throw new Error(
            `ECOSNAP_SUPABASE_ANON_KEY is a "${claims.role}" key, not an anon key. ` +
            'A service_role key in a static build gives every visitor full database ' +
            'access. Use the anon/public key from Supabase -> Settings -> API.'
          );
        }
      } catch (error) {
        if (error.message.startsWith('ECOSNAP_')) throw error;
        // Not decodable as a JWT: nothing to assert, let it through.
      }
    }
  }

  if (configKey === 'MAPBOX_TOKEN' && value.startsWith('sk.')) {
    throw new Error(
      'ECOSNAP_MAPBOX_TOKEN is a secret token (sk....). Public tokens start with ' +
      '"pk." -- use one of those, and scope it to your deployed domain.'
    );
  }
}

function main() {
  const resolved = {};
  const missing = [];

  for (const [envName, configKey] of Object.entries(MAPPING)) {
    const raw = process.env[envName];
    if (raw === undefined || raw.trim() === '') {
      missing.push(envName);
      continue;
    }

    let value = raw.trim();
    assertPublishable(configKey, value);

    // A trailing slash here produces "https://api.example.com//reports".
    if (configKey === 'API_BASE_URL' || configKey === 'TM_MODEL_URL') {
      value = value.replace(/\/+$/, '');
    }
    resolved[configKey] = value;
  }

  // A production deploy with no backend URL is a broken deploy: the app would
  // silently fall back to localhost and show "Can't reach the backend" to
  // every visitor. Better to fail here, where someone is watching the logs.
  if (process.env.VERCEL_ENV === 'production' && !resolved.API_BASE_URL) {
    throw new Error(
      'ECOSNAP_API_BASE_URL is not set for this production deployment. Set it in ' +
      'Vercel -> Settings -> Environment Variables to the deployed backend URL, ' +
      'e.g. https://ecosnap-backend.vercel.app'
    );
  }

  const banner =
    '/* config.generated.js -- GENERATED AT BUILD TIME. Do not edit, do not commit.\n' +
    ' * Written by scripts/build-config.js from environment variables.\n' +
    ` * Generated: ${new Date().toISOString()}\n` +
    ' */\n';

  const body = Object.keys(resolved).length === 0
    ? '/* No ECOSNAP_* environment variables were set. */\n'
    : `window.ECOSNAP_CONFIG = Object.assign({}, window.ECOSNAP_CONFIG, ${
        JSON.stringify(resolved, null, 2)});\n`;

  fs.writeFileSync(OUTPUT, banner + body);

  const set = Object.keys(resolved);
  console.log(`config.generated.js written with ${set.length} value(s): ${set.join(', ') || '(none)'}`);
  if (missing.length) {
    console.log(`Not set (falling back to js/config.js defaults): ${missing.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`\nBuild failed: ${error.message}\n`);
  process.exit(1);
}
