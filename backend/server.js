require('dotenv').config();

const REQUIRED_ENV = [
  'MONGODB_URI', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'APOLLO_PEOPLE_KEY', 'SESSION_SECRET',
  'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_REFRESH_TOKEN',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const mongoose = require('mongoose');
const app = require('./src/app');
const { resumeStaleLists } = require('./src/services/pullService');

const PORT = process.env.PORT || 4000;

mongoose
  .connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' })
  .then(async () => {
    console.log('MongoDB connected (db: PROSPECTOR)');
    const { resumed, failed } = await resumeStaleLists();
    if (resumed) console.log(`Resuming ${resumed} interrupted pull/qualify list(s)`);
    if (failed) console.log(`Marked ${failed} interrupted sourcing list(s) as failed`);
    app.listen(PORT, () => console.log(`Prospector API on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
