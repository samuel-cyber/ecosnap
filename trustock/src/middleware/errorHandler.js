// src/middleware/errorHandler.js
// Express treats a four-argument middleware as the error handler. Anything a
// route throws or passes to next() lands here and becomes a clean JSON body.

const config = require('../config/env');

function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode || 500;

  // Unexpected failures are worth the stack trace; expected ones (a 400 for a
  // missing field) would just be noise in the logs.
  if (statusCode >= 500) {
    console.error('Unhandled error:', err.stack || err.message);
  }

  const body = {
    error: statusCode >= 500 && config.nodeEnv === 'production'
      ? 'Something went wrong on our side'
      : err.message,
    code: err.code || 'INTERNAL_ERROR',
  };
  if (err.details) body.details = err.details;

  res.status(statusCode).json(body);
}

module.exports = { errorHandler, notFoundHandler };
