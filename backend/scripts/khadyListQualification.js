/**
 * One-off lookup: qualification.reasoning for companies on Khady's
 * "BENELUX · ICP2 · 8 Aug" list.
 * Usage: node scripts/khadyListQualification.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const LIST_ID = '6a777691811796c5eff13dda';

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const companies = await Company.find({ listId: LIST_ID })
    .select('companyName status disqualifyReason qualification')
    .sort({ createdAt: 1 })
    .lean();

  for (const c of companies) {
    console.log(`${c.companyName} — ${c.status}`);
    console.log(`  disqualifyReason: ${c.disqualifyReason || '(none)'}`);
    if (c.qualification) {
      console.log(`  qualification.icp: ${c.qualification.icp}`);
      console.log(`  qualification.isB2B: ${c.qualification.isB2B}`);
      console.log(`  qualification.isSaaS: ${c.qualification.isSaaS}`);
      console.log(`  qualification.reasoning: ${c.qualification.reasoning || '(none)'}`);
    } else {
      console.log('  qualification: (none stored)');
    }
    console.log('---');
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
