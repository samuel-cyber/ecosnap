// src/middleware/errorHandler.js
//
// Express recognizes this as an "error-handling middleware" specifically
// because it takes FOUR arguments (err, req, res, next) instead of three.
// Any route that calls next(error) — like every route we've built — sends
// its error here instead of crashing the whole server.

function errorHandler(err, req, res, next) {
  console.error('Unhandled error:', err.message);

  // If a route already set a specific status code on the error, use it.
  // Otherwise default to 500 (generic server error).
  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    error: err.message || 'Something went wrong on the server',
  });
}

module.exports = errorHandler;