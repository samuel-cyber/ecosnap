// src/middleware/rateLimit.js
// A small in-memory limiter for the credential endpoints. It is per-process,
// so it is a speed bump rather than a wall -- behind more than one instance,
// put a shared store or the platform's own limiter in front of it.

const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${retryAfter} seconds.`,
        code: 'RATE_LIMITED',
      });
    }
    return next();
  };
}

// Keeps the map from growing without bound in a long-running process.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();

module.exports = rateLimit;
