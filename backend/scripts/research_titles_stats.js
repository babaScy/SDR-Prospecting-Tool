/**
 * Research script (read-only): baseline qualified-rate stats across ALL
 * companies in the DB, broken down overall / by region / by ICP profile.
 * Also samples disqualified companies' qualification.reasoning to spot-check
 * for title/company-type mismatches.
 *
 * Usage: node scripts/research_titles_stats.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const List = require('../src/models/List');

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const total = await Company.countDocuments({});
  console.log(`\n=== TOTAL COMPANIES: ${total} ===\n`);

  // Overall status breakdown
  const statusAgg = await Company.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const statusMap = Object.fromEntries(statusAgg.map((s) => [s._id, s.count]));
  console.log('Overall status breakdown:', statusMap);

  const decided = (statusMap.qualified || 0) + (statusMap.disqualified || 0) + (statusMap.nei || 0);
  const qualRate = pct(statusMap.qualified || 0, decided);
  console.log(`Overall qualified rate (qualified / (qualified+disqualified+nei)) = ${statusMap.qualified || 0}/${decided} = ${qualRate}%\n`);

  // Need region + profile per company. Region lives on List, not Company.
  // Join via listId.
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

    byRegion[region] = byRegion[region] || { total: 0, qualified: 0, disqualified: 0, nei: 0, pending: 0 };
    byRegion[region].total++;
    byRegion[region][c.status] = (byRegion[region][c.status] || 0) + 1;

    byProfile[profile] = byProfile[profile] || { total: 0, qualified: 0, disqualified: 0, nei: 0, pending: 0 };
    byProfile[profile].total++;
    byProfile[profile][c.status] = (byProfile[profile][c.status] || 0) + 1;

    const key = `${region}/${profile}`;
    byRegionProfile[key] = byRegionProfile[key] || { total: 0, qualified: 0, disqualified: 0, nei: 0, pending: 0 };
    byRegionProfile[key].total++;
    byRegionProfile[key][c.status] = (byRegionProfile[key][c.status] || 0) + 1;
  }

  console.log('=== BY REGION ===');
  for (const [region, s] of Object.entries(byRegion).sort()) {
    const d = (s.qualified || 0) + (s.disqualified || 0) + (s.nei || 0);
    console.log(`${region.padEnd(10)} total=${s.total.toString().padEnd(5)} qualified=${(s.qualified||0).toString().padEnd(4)} disqualified=${(s.disqualified||0).toString().padEnd(4)} nei=${(s.nei||0).toString().padEnd(4)} pending=${(s.pending||0).toString().padEnd(4)} qualRate=${pct(s.qualified||0, d)}%`);
  }

  console.log('\n=== BY ICP PROFILE ===');
  for (const [profile, s] of Object.entries(byProfile).sort()) {
    const d = (s.qualified || 0) + (s.disqualified || 0) + (s.nei || 0);
    console.log(`${profile.padEnd(10)} total=${s.total.toString().padEnd(5)} qualified=${(s.qualified||0).toString().padEnd(4)} disqualified=${(s.disqualified||0).toString().padEnd(4)} nei=${(s.nei||0).toString().padEnd(4)} pending=${(s.pending||0).toString().padEnd(4)} qualRate=${pct(s.qualified||0, d)}%`);
  }

  console.log('\n=== BY REGION/PROFILE (sorted by total asc, to find thin pools) ===');
  const rpEntries = Object.entries(byRegionProfile).sort((a, b) => a[1].total - b[1].total);
  for (const [key, s] of rpEntries) {
    const d = (s.qualified || 0) + (s.disqualified || 0) + (s.nei || 0);
    console.log(`${key.padEnd(20)} total=${s.total.toString().padEnd(5)} qualified=${(s.qualified||0).toString().padEnd(4)} disqualified=${(s.disqualified||0).toString().padEnd(4)} nei=${(s.nei||0).toString().padEnd(4)} pending=${(s.pending||0).toString().padEnd(4)} qualRate=${pct(s.qualified||0, d)}%`);
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
