/**
 * Research script (read-only): check how many companies in our DB (any
 * status) carry an Apollo keyword tag containing "software development" —
 * to assess how often the current q_not_organization_keyword_tags entries
 * "software development" / "custom software development" would trigger, and
 * on what kind of companies.
 *
 * Usage: node scripts/research_keywords_softwaredev_check.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const all = await Company.find({ status: { $in: ['qualified', 'disqualified', 'nei'] } })
    .select('companyName status keywords industry qualification.isSaaS qualification.isB2B')
    .lean();

  const hits = all.filter((c) => (c.keywords || []).some((k) => k.toLowerCase().includes('software development')));
  console.log('Total companies (qualified/disqualified/nei):', all.length);
  console.log('Companies with a keyword tag containing "software development":', hits.length);
  hits.forEach((c) =>
    console.log(
      c.status,
      '|',
      c.companyName,
      '|',
      c.industry,
      '| isSaaS:',
      c.qualification?.isSaaS,
      '| isB2B:',
      c.qualification?.isB2B,
      '|',
      (c.keywords || []).filter((k) => k.toLowerCase().includes('software development'))
    )
  );

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
