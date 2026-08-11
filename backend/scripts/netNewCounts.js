/**
 * One-off report: how many "net new" companies remain in Apollo per region.
 *
 * "Net new" = matches our standard ICP filters (icp1/icp2/icp3) with
 * prospected_by_current_team: 'no' (baked into COMMON_FILTERS), i.e. Apollo's
 * live count of companies in the pool we haven't already worked, for each
 * region. Uses the same buildSearchBody() the real pull path uses, but only
 * requests per_page: 1 and reads pagination.total_entries — no records are
 * saved or enriched.
 *
 * Usage: node scripts/netNewCounts.js
 */
require('dotenv').config();
const axios = require('axios');
const { REGIONS } = require('../src/config/filters');
const { buildSearchBody } = require('../src/services/apolloService');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const PROFILES = ['icp1', 'icp2', 'icp3'];

const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const fetchCount = async (profile, region) => {
  const body = buildSearchBody(profile, region, 1, 1);
  const response = await axios.post(APOLLO_SEARCH_URL, body, {
    headers: apolloHeaders(),
    timeout: 60000,
  });
  return response.data.pagination?.total_entries ?? 0;
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) {
    throw new Error('APOLLO_API_KEY is not set in backend/.env');
  }

  const regions = Object.keys(REGIONS);
  const results = {};
  let grandTotal = 0;

  for (const region of regions) {
    results[region] = {};
    let regionTotal = 0;
    for (const profile of PROFILES) {
      // Sequential to stay well under Apollo rate limits.
      const count = await fetchCount(profile, region);
      results[region][profile] = count;
      regionTotal += count;
    }
    results[region].total = regionTotal;
    grandTotal += regionTotal;
  }

  console.log('\nNet new companies remaining in Apollo (prospected_by_current_team: no)\n');
  console.log('region'.padEnd(10), 'icp1'.padStart(8), 'icp2'.padStart(8), 'icp3'.padStart(8), 'total'.padStart(8));
  for (const region of regions) {
    const r = results[region];
    console.log(
      region.padEnd(10),
      String(r.icp1).padStart(8),
      String(r.icp2).padStart(8),
      String(r.icp3).padStart(8),
      String(r.total).padStart(8)
    );
  }
  console.log('-'.repeat(50));
  console.log('GRAND TOTAL:', grandTotal);
};

main().catch((err) => {
  console.error('Failed to fetch net-new counts:', err.response?.data || err.message);
  process.exitCode = 1;
});
