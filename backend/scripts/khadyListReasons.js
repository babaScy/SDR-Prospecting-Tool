/**
 * One-off lookup: disqualify reasons for companies on Khady's
 * "BENELUX · ICP2 · 8 Aug" list.
 * Usage: node scripts/khadyListReasons.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const LIST_ID = '6a777691811796c5eff13dda';

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const companies = await Company.find({ listId: LIST_ID })
    .select('companyName status disqualifyReason')
    .sort({ createdAt: 1 })
    .lean();

  for (const c of companies) {
    console.log(`${c.companyName} — ${c.status}`);
    console.log(`  reason: ${c.disqualifyReason || '(none stored)'}`);
    console.log('---');
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
