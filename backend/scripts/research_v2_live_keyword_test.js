/**
 * NEW research pass (2026-08-21), read-only, live Apollo (count-only,
 * per_page=1, no records saved). Tests live pool-size impact of adding the
 * two candidates re-surfaced by research_v2_global_keyword_refresh.js
 * ('computer systems design and related services', 'data analytics') to
 * q_organization_keyword_tags, for icp2 on benelux/nordics (the weak
 * segments) plus poland/dach for comparability with the 08-11 experiment.
 *
 * Usage: node scripts/research_v2_live_keyword_test.js
 */
require('dotenv').config();
const axios = require('axios');
const { ICP2_FILTERS, REGIONS } = require('../src/config/filters');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const REGIONS_TO_TEST = ['benelux', 'nordics', 'poland', 'dach'];
const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const VARIANTS = {
  V0_current: (region) => ({ ...ICP2_FILTERS, organization_locations: REGIONS[region] }),
  V1_plus_csd: (region) => ({
    ...ICP2_FILTERS,
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, 'computer systems design and related services'],
    organization_locations: REGIONS[region],
  }),
  V2_plus_dataAnalytics: (region) => ({
    ...ICP2_FILTERS,
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, 'data analytics'],
    organization_locations: REGIONS[region],
  }),
  V3_plus_both: (region) => ({
    ...ICP2_FILTERS,
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, 'computer systems design and related services', 'data analytics'],
    organization_locations: REGIONS[region],
  }),
};

const fetchCount = async (body) => {
  try {
    const response = await axios.post(APOLLO_SEARCH_URL, { page: 1, per_page: 1, ...body }, { headers: apolloHeaders(), timeout: 60000 });
    return response.data.pagination?.total_entries ?? 0;
  } catch (err) {
    console.error('Apollo call failed:', err.response?.data || err.message);
    return null;
  }
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY not set');
  const results = {};
  for (const region of REGIONS_TO_TEST) {
    results[region] = {};
    for (const [name, build] of Object.entries(VARIANTS)) {
      results[region][name] = await fetchCount(build(region));
    }
  }
  const variantNames = Object.keys(VARIANTS);
  console.log('region'.padEnd(10), ...variantNames.map((v) => v.padStart(20)));
  for (const region of REGIONS_TO_TEST) {
    console.log(region.padEnd(10), ...variantNames.map((v) => String(results[region][v]).padStart(20)));
  }
  console.log('\n% lift over V0_current:');
  console.log('region'.padEnd(10), ...variantNames.slice(1).map((v) => v.padStart(20)));
  for (const region of REGIONS_TO_TEST) {
    const base = results[region].V0_current;
    const lifts = variantNames.slice(1).map((v) => (base > 0 ? (((results[region][v] - base) / base) * 100).toFixed(0) + '%' : 'n/a'));
    console.log(region.padEnd(10), ...lifts.map((l) => l.padStart(20)));
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
