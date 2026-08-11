/**
 * Research script (read-only): for candidate keyword-tag additions, compute
 * qualify-rate-given-tag-present vs qualify-rate-given-tag-absent, across the
 * union of {qualified, disqualified-with-reasoning} companies. Both sets
 * already passed Apollo's current filter, so this measures how much a given
 * Apollo tag correlates with ending up qualified vs disqualified — a proxy
 * for whether adding that tag as an OR'd include keyword would likely bring
 * in more fits than misses.
 *
 * Usage: node scripts/research_keywords_correlation.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const CANDIDATES = [
  'computer software', 'enterprise software', 'software', 'computer & network security',
  'data security', 'cybersecurity', 'cyber security', 'fintech', 'financial technology',
  'software as a service', 'cloud computing', 'computer systems design and related services',
  'workflow automation', 'regulatory compliance', 'api integration', 'digital transformation',
  'data analytics', 'automation', 'saas', 'platform', 'cloud', 'ai', 'b2b software', 'data platform',
];

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const qualified = await Company.find({ status: 'qualified' }).select('keywords').lean();
  const disqualified = await Company.find({
    status: 'disqualified',
    'qualification.reasoning': { $exists: true, $nin: [null, ''] },
  }).select('keywords').lean();

  console.log(`qualified=${qualified.length} disqualified(evaluated)=${disqualified.length}\n`);

  const hasTag = (c, t) => (c.keywords || []).some((k) => k.toLowerCase().trim() === t);

  console.log('tag\tqual_w\tdq_w\trate_w\tqual_wo\tdq_wo\trate_wo\tlift');
  for (const t of CANDIDATES) {
    const qW = qualified.filter((c) => hasTag(c, t)).length;
    const dW = disqualified.filter((c) => hasTag(c, t)).length;
    const qWo = qualified.length - qW;
    const dWo = disqualified.length - dW;
    const rateW = qW + dW > 0 ? (qW / (qW + dW)) : NaN;
    const rateWo = qWo + dWo > 0 ? (qWo / (qWo + dWo)) : NaN;
    const lift = rateWo > 0 ? (rateW / rateWo) : NaN;
    console.log(
      `${t}\t${qW}\t${dW}\t${(rateW * 100).toFixed(1)}%\t${qWo}\t${dWo}\t${(rateWo * 100).toFixed(1)}%\t${lift.toFixed(2)}x`
    );
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
