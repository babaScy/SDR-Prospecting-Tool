/**
 * Net-new pool status per region/ICP, with companies we've already saved
 * subtracted out.
 *
 * netNewCounts.js reports Apollo's own "prospected_by_current_team: no"
 * count — that's Apollo's tracking, not ours, and can drift out of sync with
 * what's actually in our `Company` collection (the real dedup key the pull
 * path uses is `apolloAccountId`, checked against our own DB — see
 * pullService.js). This report adds our own DB count per region/ICP
 * (Company -> List join, since region lives on List) and nets it against
 * Apollo's count, so "remaining" reflects what we actually still have to
 * pull, not just Apollo's side of the bookkeeping.
 *
 * "Remaining" is Apollo's live net-new count minus our saved count for that
 * region/ICP — an estimate, not an exact per-company ID diff (that would mean
 * paging through Apollo's entire multi-thousand-company pool per region,
 * which isn't practical for a status check). If Apollo's own
 * prospected_by_current_team tracking is already accurate, this and
 * netNewCounts.js should roughly agree; a large gap between them is itself
 * useful signal that the two are out of sync.
 *
 * Usage: node scripts/netNewPoolStatus.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const { REGIONS } = require('../src/config/filters');
const { buildSearchBody } = require('../src/services/apolloService');
const Company = require('../src/models/Company');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const PROFILES = ['icp1', 'icp2', 'icp3'];

const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const fetchApolloCount = async (profile, region) => {
  const body = buildSearchBody(profile, region, 1, 1);
  const response = await axios.post(APOLLO_SEARCH_URL, body, {
    headers: apolloHeaders(),
    timeout: 60000,
  });
  return response.data.pagination?.total_entries ?? 0;
};

// Company doesn't store region directly — it lives on the List it was pulled
// into (companyLinkedinUrl etc. are firmographic, not pipeline metadata).
const dbCountsByRegionProfile = async () => {
  const rows = await Company.aggregate([
    { $lookup: { from: 'lists', localField: 'listId', foreignField: '_id', as: 'list' } },
    { $unwind: '$list' },
    { $group: { _id: { region: '$list.region', profile: '$icpProfile' }, count: { $sum: 1 } } },
  ]);
  const byKey = {};
  for (const row of rows) {
    byKey[`${row._id.region}_${row._id.profile}`] = row.count;
  }
  return byKey;
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set in backend/.env');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in backend/.env');

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });
  const dbCounts = await dbCountsByRegionProfile();

  const regions = Object.keys(REGIONS);
  const results = {};
  let grand = { apollo: 0, db: 0, remaining: 0 };

  for (const region of regions) {
    results[region] = { rows: {}, apollo: 0, db: 0, remaining: 0 };
    for (const profile of PROFILES) {
      // Sequential to stay well under Apollo rate limits.
      const apollo = await fetchApolloCount(profile, region);
      const db = dbCounts[`${region}_${profile}`] || 0;
      const remaining = Math.max(0, apollo - db);
      results[region].rows[profile] = { apollo, db, remaining };
      results[region].apollo += apollo;
      results[region].db += db;
      results[region].remaining += remaining;
    }
    grand.apollo += results[region].apollo;
    grand.db += results[region].db;
    grand.remaining += results[region].remaining;
  }

  const col = (s, w) => String(s).padStart(w);
  console.log('\nNet-new pool status — Apollo count vs. already-in-our-DB vs. estimated remaining\n');
  console.log(
    'region'.padEnd(10), 'icp'.padEnd(6),
    col('apollo', 8), col('in db', 8), col('remaining', 10)
  );
  for (const region of regions) {
    for (const profile of PROFILES) {
      const r = results[region].rows[profile];
      console.log(region.padEnd(10), profile.padEnd(6), col(r.apollo, 8), col(r.db, 8), col(r.remaining, 10));
    }
    console.log(
      `${region} total`.padEnd(16),
      col(results[region].apollo, 8), col(results[region].db, 8), col(results[region].remaining, 10)
    );
    console.log('-'.repeat(48));
  }
  console.log('\nGRAND TOTAL'.padEnd(16), col(grand.apollo, 8), col(grand.db, 8), col(grand.remaining, 10));
  console.log();
};

main()
  .catch((err) => {
    console.error('Failed to build net-new pool status:', err.response?.data || err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
