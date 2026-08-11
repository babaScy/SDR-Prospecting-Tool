/**
 * Research script (read-only): pull keyword-tag frequency across QUALIFIED
 * companies, to see what Apollo keyword vocabulary shows up on companies we
 * know are a good fit — useful ground truth for expanding
 * q_organization_keyword_tags without diluting quality.
 *
 * Usage: node scripts/research_keywords_qualified_pull.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const qualified = await Company.find({ status: 'qualified' })
    .select('companyName industry keywords')
    .lean();

  console.log(`Qualified companies: ${qualified.length}`);

  const freq = {};
  for (const c of qualified) {
    for (const kw of c.keywords || []) {
      const k = kw.toLowerCase().trim();
      freq[k] = (freq[k] || 0) + 1;
    }
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  console.log('\nTop 60 keyword tags among QUALIFIED companies:');
  sorted.slice(0, 60).forEach(([k, v]) => console.log(`${v}\t${k}`));

  // Check specific candidate additions' current presence
  const candidates = [
    'software', 'cloud software', 'cybersecurity', 'cyber security', 'compliance software',
    'grc', 'vertical software', 'isv', 'saas platform', 'web application', 'enterprise software',
    'computer software', 'information technology & services', 'security software', 'data security',
    'risk management', 'devops', 'api',
  ];
  console.log('\nCandidate term frequency among QUALIFIED companies keywords:');
  for (const term of candidates) {
    console.log(`${freq[term] || 0}\t${term}`);
  }

  const industryFreq = {};
  for (const c of qualified) {
    const ind = (c.industry || '(none)').toLowerCase();
    industryFreq[ind] = (industryFreq[ind] || 0) + 1;
  }
  console.log('\nQualified companies by industry:');
  Object.entries(industryFreq).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${v}\t${k}`));

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
