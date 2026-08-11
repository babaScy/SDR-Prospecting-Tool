/**
 * Monitoring report: AI-qualifier pass rate (qualified rate), overall / by
 * region / by ICP profile / by region+profile. Used to compare against the
 * pre-change baseline after broadening the Apollo sourcing filters (see
 * docs/superpowers/specs/2026-08-11-broaden-apollo-sourcing-filters-design.md).
 *
 * Baseline captured 2026-08-11 (before the filter change), for reference:
 *   Overall: 40.3% (230 qualified / 252 disqualified / 89 nei / 1 pending, n=572)
 *   By region: aus 45.5%, benelux 32.6%, dach 40.9%, nordics 40.3%,
 *              poland 16.7%, taiwan 90% (n=10), uk 58.2%. us: no data yet.
 *   By profile: icp1 42.0%, icp2 31.6%. icp3: no data yet.
 *
 * Re-run this after a batch of new pulls under the broadened filters
 * completes. If any region/profile's qualified rate drops meaningfully below
 * its baseline above, the response per the design doc is to revert the
 * `q_not_organization_keyword_tags` change specifically (the highest-
 * uncertainty change in that batch) rather than the title/keyword additions.
 *
 * Usage: node scripts/qualifiedRateReport.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const List = require('../src/models/List');

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const summarize = (s) => {
  const d = (s.qualified || 0) + (s.disqualified || 0) + (s.nei || 0);
  return `total=${s.total.toString().padEnd(5)} qualified=${(s.qualified || 0).toString().padEnd(4)} disqualified=${(s.disqualified || 0).toString().padEnd(4)} nei=${(s.nei || 0).toString().padEnd(4)} pending=${(s.pending || 0).toString().padEnd(4)} qualRate=${pct(s.qualified || 0, d)}%`;
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const total = await Company.countDocuments({});
  const statusAgg = await Company.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const statusMap = Object.fromEntries(statusAgg.map((s) => [s._id, s.count]));
  const decided = (statusMap.qualified || 0) + (statusMap.disqualified || 0) + (statusMap.nei || 0);

  console.log(`\n=== TOTAL COMPANIES: ${total} ===`);
  console.log(`Overall qualified rate = ${statusMap.qualified || 0}/${decided} = ${pct(statusMap.qualified || 0, decided)}%\n`);

  // Region lives on List, not Company — join via listId.
  const lists = await List.find({}).select('region profile').lean();
  const listMeta = new Map(lists.map((l) => [l._id.toString(), { region: l.region, profile: l.profile }]));
  const companies = await Company.find({}).select('listId icpProfile status').lean();

  const byRegion = {};
  const byProfile = {};
  const byRegionProfile = {};

  for (const c of companies) {
    const meta = listMeta.get(c.listId?.toString());
    const region = meta?.region || 'UNKNOWN';
    const profile = c.icpProfile || meta?.profile || 'UNKNOWN';

    for (const [bucket, key] of [[byRegion, region], [byProfile, profile], [byRegionProfile, `${region}/${profile}`]]) {
      bucket[key] = bucket[key] || { total: 0, qualified: 0, disqualified: 0, nei: 0, pending: 0 };
      bucket[key].total++;
      bucket[key][c.status] = (bucket[key][c.status] || 0) + 1;
    }
  }

  console.log('=== BY REGION ===');
  for (const [region, s] of Object.entries(byRegion).sort()) console.log(`${region.padEnd(10)} ${summarize(s)}`);

  console.log('\n=== BY ICP PROFILE ===');
  for (const [profile, s] of Object.entries(byProfile).sort()) console.log(`${profile.padEnd(10)} ${summarize(s)}`);

  console.log('\n=== BY REGION/PROFILE (sorted by total asc, to find thin pools) ===');
  for (const [key, s] of Object.entries(byRegionProfile).sort((a, b) => a[1].total - b[1].total)) {
    console.log(`${key.padEnd(20)} ${summarize(s)}`);
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
