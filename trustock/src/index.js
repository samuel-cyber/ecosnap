// src/index.js -- process entry point.

const app = require('./app');
const config = require('./config/env');
const ecobank = require('./services/ecobank');

const server = app.listen(config.port, () => {
  const provider = ecobank.describe();
  console.log(`Trustock listening on http://localhost:${config.port}`);
  console.log(`Ecobank mode: ${provider.mode.toUpperCase()}`);
  if (provider.simulated) {
    console.log('  ' + provider.notice);
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
