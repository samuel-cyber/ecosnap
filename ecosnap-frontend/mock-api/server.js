#!/usr/bin/env node
/* mock-api/server.js
 *
 * A dependency-free stand-in for the EcoSnap backend, plus a static server for
 * the frontend. It exists so the frontend can be built, demoed and tested
 * without Supabase credentials.
 *
 * It mirrors the contracts in ecosnap-backend/src/routes/* exactly -- the same
 * validation, the same 0.75 confidence threshold, the same duplicate window,
 * the same neighborhood boxes. The real backend remains the source of truth;
 * if the two ever disagree, this file is the one that's wrong.
 *
 *   node mock-api/server.js          → http://localhost:3000 (API + frontend)
 *   node mock-api/server.js --seed   → start with demo data already in place
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');
const SEED = process.argv.includes('--seed');

// --- in-memory tables, mirroring supabase/schema.sql ------------------------
const db = { users: [], reports: [], redemptions: [] };

// Mirrors src/services/reportService.js
const POINTS_PER_REPORT = 10;
const CONFIDENCE_THRESHOLD = 0.75;
const LAT_DELTA = 0.00045;
const LNG_DELTA = 0.00045;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors src/services/geoService.js
function getNeighborhood(lat, lng) {
  if (lat >= 6.48 && lat <= 6.53 && lng >= 3.36 && lng <= 3.40) return 'Yaba';
  if (lat >= 6.47 && lat <= 6.52 && lng >= 3.32 && lng <= 3.36) return 'Surulere';
  if (lat >= 6.57 && lat <= 6.65 && lng >= 3.32 && lng <= 3.39) return 'Ikeja';
  return 'Unknown';
}

function findDuplicate(category, lat, lng) {
  const oneHourAgo = Date.now() - 3600_000;
  return db.reports.some(
    (r) =>
      r.category === category &&
      Math.abs(r.lat - lat) <= LAT_DELTA &&
      Math.abs(r.lng - lng) <= LNG_DELTA &&
      new Date(r.created_at).getTime() >= oneHourAgo
  );
}

// --- tiny http helpers ------------------------------------------------------
const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, rel);

  // Never serve outside the project directory.
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'Forbidden' });

  fs.readFile(file, (error, content) => {
    if (error) {
      // config.local.js is optional; a 404 for it is expected, not an error.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

// --- routes -----------------------------------------------------------------
async function api(req, res, pathname, query) {
  const { method } = req;

  if (method === 'OPTIONS') return send(res, 204, {});

  if (pathname === '/ping') {
    return send(res, 200, { status: 'ok', message: 'EcoSnap backend is alive (MOCK)' });
  }

  // POST /users
  if (pathname === '/users' && method === 'POST') {
    const { id, display_name, neighborhood } = await readBody(req);
    if (!id || !display_name) {
      return send(res, 400, { error: 'id and display_name are required' });
    }
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid user id format' });

    const existing = db.users.find((u) => u.id === id);
    if (existing) return send(res, 200, existing);

    const user = { id, display_name, neighborhood: neighborhood || null, eco_points: 0 };
    db.users.push(user);
    return send(res, 201, user);
  }

  // GET /users/:id
  if (pathname.startsWith('/users/') && method === 'GET') {
    const id = pathname.slice('/users/'.length);
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid user id format' });

    const user = db.users.find((u) => u.id === id);
    if (!user) return send(res, 404, { error: 'User not found' });
    return send(res, 200, user);
  }

  // POST /reports
  if (pathname === '/reports' && method === 'POST') {
    const body = await readBody(req);
    const { user_id, image_url, category, lat, lng, ai_label, ai_confidence } = body;

    if (!user_id || !image_url || !category || lat === undefined || lng === undefined ||
        ai_label === undefined || ai_confidence === undefined) {
      return send(res, 400, { error: 'Missing required fields' });
    }
    if (!['burning', 'blocked_drain'].includes(category)) {
      return send(res, 400, { error: "Category must be 'burning' or 'blocked_drain'" });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number' ||
        !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return send(res, 400, { error: 'lat and lng must be valid numbers' });
    }
    if (typeof ai_confidence !== 'number' || !Number.isFinite(ai_confidence) ||
        ai_confidence < 0 || ai_confidence > 1) {
      return send(res, 400, { error: 'ai_confidence must be a number between 0 and 1' });
    }

    const user = db.users.find((u) => u.id === user_id);
    if (!user) return send(res, 500, { error: 'Failed to fetch user points: user not found' });

    const neighborhood = getNeighborhood(lat, lng);
    const isVerified = !findDuplicate(category, lat, lng) && ai_confidence >= CONFIDENCE_THRESHOLD;
    const status = isVerified ? 'verified' : 'flagged';
    const points_awarded = isVerified ? POINTS_PER_REPORT : 0;

    const report = {
      id: crypto.randomUUID(),
      user_id, image_url, category, lat, lng, neighborhood,
      ai_label, ai_confidence, status, points_awarded,
      created_at: new Date().toISOString(),
    };
    db.reports.push(report);

    if (isVerified) user.eco_points += points_awarded;

    return send(res, 201, {
      id: report.id, status, points_awarded, neighborhood,
    });
  }

  // GET /reports
  if (pathname === '/reports' && method === 'GET') {
    let rows = db.reports.filter((r) => r.status === 'verified');

    const { minLat, maxLat, minLng, maxLng } = query;
    if ([minLat, maxLat, minLng, maxLng].every((v) => v !== undefined)) {
      const bounds = [minLat, maxLat, minLng, maxLng].map(Number);
      if (bounds.some((v) => !Number.isFinite(v))) {
        return send(res, 400, { error: 'Bounding box values must be valid numbers' });
      }
      rows = rows.filter(
        (r) => r.lat >= bounds[0] && r.lat <= bounds[1] && r.lng >= bounds[2] && r.lng <= bounds[3]
      );
    }

    return send(res, 200,
      rows
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(({ id, lat, lng, category, created_at }) => ({ id, lat, lng, category, created_at }))
    );
  }

  // GET /leaderboard
  if (pathname === '/leaderboard' && method === 'GET') {
    const totals = {};
    for (const user of db.users) {
      const key = user.neighborhood || 'Unknown';
      totals[key] = (totals[key] || 0) + (user.eco_points || 0);
    }
    return send(res, 200,
      Object.entries(totals)
        .map(([neighborhood, total_points]) => ({ neighborhood, total_points }))
        .sort((a, b) => b.total_points - a.total_points)
    );
  }

  // POST /redeem
  if (pathname === '/redeem' && method === 'POST') {
    const { user_id, points_spent, reward_type } = await readBody(req);

    if (!user_id || points_spent === undefined || !reward_type) {
      return send(res, 400, { error: 'user_id, points_spent and reward_type are required' });
    }
    if (typeof points_spent !== 'number' || !Number.isInteger(points_spent) || points_spent <= 0) {
      return send(res, 400, { error: 'points_spent must be a positive whole number' });
    }

    const user = db.users.find((u) => u.id === user_id);
    if (!user) return send(res, 404, { error: 'User not found' });

    if (points_spent > user.eco_points) {
      return send(res, 400, {
        error: 'Insufficient EcoPoints',
        current_points: user.eco_points,
        requested_points: points_spent,
      });
    }

    user.eco_points -= points_spent;
    db.redemptions.push({
      id: crypto.randomUUID(), user_id, points_spent, reward_type,
      status: 'fulfilled', created_at: new Date().toISOString(),
    });

    return send(res, 200, { success: true, message: 'Reward Sent' });
  }

  return send(res, 404, { error: `No route for ${method} ${pathname}` });
}

// --- seed data --------------------------------------------------------------
function seed() {
  const people = [
    ['Amaka O.', 'Yaba', 40], ['Tunde B.', 'Yaba', 30],
    ['Zainab Y.', 'Surulere', 25], ['Chidi N.', 'Ikeja', 10],
  ];
  for (const [display_name, neighborhood, eco_points] of people) {
    db.users.push({ id: crypto.randomUUID(), display_name, neighborhood, eco_points });
  }

  const spots = [
    [6.5095, 3.3711, 'burning'], [6.5142, 3.3785, 'blocked_drain'],
    [6.5051, 3.3689, 'burning'], [6.4952, 3.3441, 'blocked_drain'],
    [6.4981, 3.3502, 'burning'], [6.6018, 3.3515, 'blocked_drain'],
  ];
  spots.forEach(([lat, lng, category], index) => {
    db.reports.push({
      id: crypto.randomUUID(),
      user_id: db.users[index % db.users.length].id,
      image_url: 'https://example.invalid/seed.jpg',
      category, lat, lng,
      neighborhood: getNeighborhood(lat, lng),
      ai_label: category, ai_confidence: 0.88,
      status: 'verified', points_awarded: 10,
      // Spread over the past days so they fall outside the duplicate window.
      created_at: new Date(Date.now() - (index + 1) * 7200_000).toISOString(),
    });
  });
}

if (SEED) seed();

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    const isApi =
      pathname === '/ping' ||
      ['/users', '/reports', '/leaderboard', '/redeem'].some(
        (p) => pathname === p || pathname.startsWith(`${p}/`)
      );

    if (isApi) return api(req, res, pathname, query);
    return serveStatic(req, res, pathname);
  })
  .listen(PORT, () => {
    console.log(`\n  EcoSnap MOCK backend + frontend → http://localhost:${PORT}`);
    console.log('  This is a stand-in for ecosnap-backend, for local development only.');
    if (SEED) console.log(`  Seeded ${db.users.length} users and ${db.reports.length} reports.\n`);
    else console.log('  Start with --seed for demo data.\n');
  });
