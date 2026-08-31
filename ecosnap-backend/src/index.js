// src/index.js
// This is the entry point of our backend — the file that starts everything.

require('dotenv').config(); // loads variables from .env into process.env

const express = require('express');
const cors = require('cors');

const app = express(); // create the Express application — this IS our server, before it's "on"

// --- middleware (code that runs on every request, before it reaches a route) ---
app.use(cors());           // allow requests from other origins (like our frontend's dev server)
app.use(express.json());   // automatically parse incoming JSON request bodies into req.body

// --- routes ---
// A simple test route. When someone visits GET /ping, this function runs.
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'EcoSnap backend is alive' });
});

// --- start the server ---
const PORT = process.env.PORT || 3000;

// Vercel runs this file as a serverless function and ignores app.listen() —
// it imports `module.exports` (the app itself) and handles requests directly.
// Locally (npm run dev), app.listen() is what actually starts a server on your machine.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EcoSnap backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

