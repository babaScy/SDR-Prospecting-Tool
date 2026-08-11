/**
 * One-off lookup: companies on Khady's "BENELUX · ICP2 · 8 Aug" list.
 * Usage: node scripts/khadyListCompanies.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const LIST_ID = '6a777691811796c5eff13dda';

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const companies = await Company.find({ listId: LIST_ID }).sort({ createdAt: 1 }).lean();

  console.log(`Found ${companies.length} companies on list ${LIST_ID}:\n`);
  for (const c of companies) {
    console.log(JSON.stringify({
      id: c._id.toString(),
      companyName: c.companyName,
      website: c.website,
      country: c.country,
      employees: c.employees,
      icpProfile: c.icpProfile,
      status: c.status,
      sdrStatus: c.sdrStatus,
      contactStatus: c.contactStatus,
      hubspotCompanyId: c.hubspotCompanyId || null,
      createdAt: c.createdAt,
    }, null, 2));
    console.log('---');
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
