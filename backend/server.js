require('dotenv').config();

const REQUIRED_ENV = ['MONGODB_URI', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const mongoose = require('mongoose');
const app = require('./src/app');
const { markStaleListsFailed } = require('./src/services/pullService');

const PORT = process.env.PORT || 4000;

mongoose
  .connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' })
  .then(async () => {
    console.log('MongoDB connected (db: PROSPECTOR)');
    const stale = await markStaleListsFailed();
    if (stale) console.log(`Marked ${stale} interrupted list(s) as failed`);
    app.listen(PORT, () => console.log(`Prospector API on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
