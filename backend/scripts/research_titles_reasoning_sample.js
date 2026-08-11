/**
 * Research script (read-only): sample disqualified companies' qualification.reasoning
 * to spot-check whether disqualification correlates with title/company-type mismatch
 * (e.g. a "Director" at a non-software company).
 *
 * Usage: node scripts/research_titles_reasoning_sample.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const disqualified = await Company.find({
    status: 'disqualified',
    'qualification.reasoning': { $exists: true, $ne: '' },
  })
    .select('companyName industry keywords qualification.reasoning qualification.isB2B qualification.isSaaS disqualifyReason')
    .limit(30)
    .lean();

  console.log(`Sampling ${disqualified.length} disqualified companies with reasoning populated:\n`);
  for (const c of disqualified) {
    console.log(`### ${c.companyName} (industry: ${c.industry || 'n/a'})`);
    console.log(`isB2B=${c.qualification?.isB2B}  isSaaS=${c.qualification?.isSaaS}`);
    console.log(`reasoning: ${c.qualification?.reasoning}`);
    console.log('---');
  }

  // Also grab count of disqualified with NO reasoning, for context
  const noReasoning = await Company.countDocuments({
    status: 'disqualified',
    $or: [{ 'qualification.reasoning': { $exists: false } }, { 'qualification.reasoning': '' }],
  });
  console.log(`\n(${noReasoning} disqualified companies have no reasoning text populated)`);

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
