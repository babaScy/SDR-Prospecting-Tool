/**
 * NEW research pass (2026-08-21), read-only.
 *
 * Re-runs the 08-11 batch's research_keywords_correlation.js methodology
 * against the current, larger DB (1590 companies vs 572 before) for the two
 * candidates that batch explicitly flagged as "cautious, not live-tested"
 * and left out: 'computer systems design and related services' and
 * 'data analytics'. Bigger n may now support a confidence call that wasn't
 * possible before. Also re-confirms the 4 terms already added 2026-08-11 for
 * a sanity check that they still look good at the larger n.
 *
 * Usage: node scripts/research_v2_global_keyword_refresh.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

const CANDIDATES = [
  'computer systems design and related services', 'data analytics',
  'computer software', 'software as a service', 'api integration', 'workflow automation',
];

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });
  const qualified = await Company.find({ status: 'qualified' }).select('keywords').lean();
  const disqualified = await Company.find({ status: 'disqualified' }).select('keywords').lean();
  console.log(`qualified=${qualified.length} disqualified=${disqualified.length}\n`);
  const hasTag = (c, t) => (c.keywords || []).some((k) => k.toLowerCase().trim() === t);
  console.log('tag\tqual_w\tdq_w\trate_w\tqual_wo\tdq_wo\trate_wo\tlift\tqPres%(of qualified)');
  for (const t of CANDIDATES) {
    const qW = qualified.filter((c) => hasTag(c, t)).length;
    const dW = disqualified.filter((c) => hasTag(c, t)).length;
    const qWo = qualified.length - qW;
    const dWo = disqualified.length - dW;
    const rateW = qW + dW > 0 ? qW / (qW + dW) : NaN;
    const rateWo = qWo + dWo > 0 ? qWo / (qWo + dWo) : NaN;
    const lift = rateWo > 0 ? rateW / rateWo : NaN;
    console.log(`${t}\t${qW}\t${dW}\t${(rateW * 100).toFixed(1)}%\t${qWo}\t${dWo}\t${(rateWo * 100).toFixed(1)}%\t${lift.toFixed(2)}x\t${((qW / qualified.length) * 100).toFixed(1)}%`);
  }
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
