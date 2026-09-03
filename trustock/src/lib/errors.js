// src/lib/errors.js
// Errors that carry an HTTP status, so routes can just `throw` and let the
// central error handler turn it into the right response.

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) => new AppError(message, 400, 'BAD_REQUEST', details);
const unauthorized = (message = 'Authentication required') => new AppError(message, 401, 'UNAUTHORIZED');
const forbidden = (message = 'You are not allowed to do that') => new AppError(message, 403, 'FORBIDDEN');
const notFound = (message = 'Not found') => new AppError(message, 404, 'NOT_FOUND');
const conflict = (message, details) => new AppError(message, 409, 'CONFLICT', details);
const badGateway = (message, details) => new AppError(message, 502, 'PROVIDER_ERROR', details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, badGateway };
