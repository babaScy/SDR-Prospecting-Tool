/**
 * Research script (read-only): qualified/disqualified/nei counts by Apollo
 * `industry` field, to see which industries are noisiest (i.e. likely
 * surfaced only via generic titles like "director"/"general manager" rather
 * than software-specific signals) and thus candidates for tighter title
 * targeting rather than looser.
 *
 * Usage: node scripts/research_titles_industry_breakdown.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const companies = await Company.find({ status: { $in: ['qualified', 'disqualified', 'nei'] } })
    .select('industry status')
    .lean();

  const byIndustry = {};
  for (const c of companies) {
    const ind = c.industry || '(none)';
    byIndustry[ind] = byIndustry[ind] || { total: 0, qualified: 0, disqualified: 0, nei: 0 };
    byIndustry[ind].total++;
    byIndustry[ind][c.status]++;
  }

  const rows = Object.entries(byIndustry)
    .filter(([, s]) => s.total >= 5) // ignore tiny long-tail industries
    .sort((a, b) => a[1].total - b[1].total ? pct(a[1].qualified, a[1].total) - pct(b[1].qualified, b[1].total) : 0)
    .sort((a, b) => pct(a[1].qualified, a[1].total) - pct(b[1].qualified, b[1].total));

  console.log('=== INDUSTRIES WITH >=5 COMPANIES, SORTED BY QUALIFIED RATE ASC (noisiest first) ===\n');
  for (const [ind, s] of rows) {
    console.log(`${ind.padEnd(45)} total=${s.total.toString().padEnd(4)} qualified=${s.qualified.toString().padEnd(3)} disqualified=${s.disqualified.toString().padEnd(3)} nei=${s.nei.toString().padEnd(3)} qualRate=${pct(s.qualified, s.total)}%`);
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
