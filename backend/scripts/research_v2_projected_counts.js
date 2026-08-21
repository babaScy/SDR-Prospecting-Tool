/**
 * One-off: project net-new pool size across all regions/profiles under the
 * candidate 2026-08-21 filter change (remove organization_industry_tag_ids
 * restriction; add 'computer systems design and related services' and
 * 'data analytics' to q_organization_keyword_tags) vs. current production
 * filters. Count-only (per_page: 1), read-only against Apollo's API.
 *
 * Usage: node scripts/research_v2_projected_counts.js
 */
require('dotenv').config();
const axios = require('axios');
const { ICP1_FILTERS, ICP2_FILTERS, ICP3_FILTERS, REGIONS } = require('../src/config/filters');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const PROFILES = { icp1: ICP1_FILTERS, icp2: ICP2_FILTERS, icp3: ICP3_FILTERS };

const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const candidateFilters = (base) => {
  const { organization_industry_tag_ids, ...rest } = base; // drop the include restriction
  return {
    ...rest,
    q_organization_keyword_tags: [
      ...base.q_organization_keyword_tags,
      'computer systems design and related services',
      'data analytics',
    ],
  };
};

const fetchCount = async (filters, region) => {
  const body = { page: 1, per_page: 1, ...filters, organization_locations: REGIONS[region] };
  const response = await axios.post(APOLLO_SEARCH_URL, body, { headers: apolloHeaders(), timeout: 60000 });
  return response.data.pagination?.total_entries ?? 0;
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set in backend/.env');

  const regions = Object.keys(REGIONS);
  const results = {};
  let currentGrand = 0;
  let candidateGrand = 0;

  for (const region of regions) {
    results[region] = {};
    for (const [profile, base] of Object.entries(PROFILES)) {
      const current = await fetchCount(base, region);
      const candidate = await fetchCount(candidateFilters(base), region);
      results[region][profile] = { current, candidate };
      currentGrand += current;
      candidateGrand += candidate;
    }
  }

  console.log('\nCurrent vs candidate net-new pool size, by region/profile\n');
  console.log(
    'region'.padEnd(10),
    'icp1 cur'.padStart(10), 'icp1 new'.padStart(10),
    'icp2 cur'.padStart(10), 'icp2 new'.padStart(10),
    'icp3 cur'.padStart(10), 'icp3 new'.padStart(10),
  );
  for (const region of regions) {
    const r = results[region];
    console.log(
      region.padEnd(10),
      String(r.icp1.current).padStart(10), String(r.icp1.candidate).padStart(10),
      String(r.icp2.current).padStart(10), String(r.icp2.candidate).padStart(10),
      String(r.icp3.current).padStart(10), String(r.icp3.candidate).padStart(10),
    );
  }
  console.log('-'.repeat(80));
  console.log('GRAND TOTAL current:', currentGrand, '  candidate:', candidateGrand, `  (+${(((candidateGrand - currentGrand) / currentGrand) * 100).toFixed(0)}%)`);
};

main().catch((err) => {
  console.error('Projection failed:', err.response?.data || err.message);
  process.exitCode = 1;
});
