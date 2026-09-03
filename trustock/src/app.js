// src/app.js
// Wires the Express application together. Kept separate from src/index.js so
// tests can import the app without starting a listener.

const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const poolRoutes = require('./routes/pools');
const supplierRoutes = require('./routes/suppliers');
const transactionRoutes = require('./routes/transactions');
const systemRoutes = require('./routes/system');
const rateLimit = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// The dashboard is a plain static front end served by the same process, so
// there is one thing to run and nothing to build.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 20 }), authRoutes);
app.use('/api/pools', poolRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/system', systemRoutes);

app.use('/api', notFoundHandler);

// Must come last: Express only treats a four-argument function as the error
// handler when it is registered after everything else.
app.use(errorHandler);

module.exports = app;
