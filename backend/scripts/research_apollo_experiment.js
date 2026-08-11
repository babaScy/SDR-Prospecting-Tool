/**
 * One-off experiment: measure live Apollo pool-size (pagination.total_entries)
 * for candidate broadened person_titles / keyword filters vs. the current
 * production filters, on the thinnest icp2 regions. Count-only (per_page: 1),
 * no records saved or enriched. Read-only against Apollo's API.
 *
 * Usage: node scripts/research_apollo_experiment.js
 */
require('dotenv').config();
const axios = require('axios');
const { ICP2_FILTERS, REGIONS } = require('../src/config/filters');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const THIN_REGIONS = ['poland', 'nordics', 'benelux', 'dach'];

const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

// ── Candidate additions, grouped by risk tier per research findings ─────────
const SAFE_TITLES = [
  'chief information security officer', 'cio', 'chief information officer',
  'vp security', 'head of information security', 'director of information security',
  'head of product security', 'head of trust', 'vp trust and safety',
];
const COMPLIANCE_TITLES = ['head of compliance', 'compliance manager', 'vp compliance'];

const SAFE_KEYWORDS = ['computer software', 'software as a service', 'api integration', 'workflow automation'];

// Split the bare 'software development' negative keyword into more specific phrases.
const NARROWED_NOT_KEYWORDS = (list) => [
  ...list.filter((k) => k !== 'software development'),
  'software development services', 'software development agency', 'outsourced software development',
  'software development consultancy',
];

const buildVariant = (region, overrides = {}) => {
  const locations = REGIONS[region];
  const base = { ...ICP2_FILTERS, organization_locations: locations };
  return { page: 1, per_page: 1, ...base, ...overrides };
};

const VARIANTS = {
  V0_baseline: (region) => buildVariant(region),
  V1_safeTitles: (region) => buildVariant(region, {
    person_titles: [...ICP2_FILTERS.person_titles, ...SAFE_TITLES],
  }),
  V2_safeKeywords: (region) => buildVariant(region, {
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, ...SAFE_KEYWORDS],
  }),
  V3_titlesPlusKeywords: (region) => buildVariant(region, {
    person_titles: [...ICP2_FILTERS.person_titles, ...SAFE_TITLES],
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, ...SAFE_KEYWORDS],
  }),
  V4_plusComplianceTitles: (region) => buildVariant(region, {
    person_titles: [...ICP2_FILTERS.person_titles, ...SAFE_TITLES, ...COMPLIANCE_TITLES],
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, ...SAFE_KEYWORDS],
  }),
  V5_plusNarrowedExcludes: (region) => buildVariant(region, {
    person_titles: [...ICP2_FILTERS.person_titles, ...SAFE_TITLES],
    q_organization_keyword_tags: [...ICP2_FILTERS.q_organization_keyword_tags, ...SAFE_KEYWORDS],
    q_not_organization_keyword_tags: NARROWED_NOT_KEYWORDS(ICP2_FILTERS.q_not_organization_keyword_tags),
  }),
};

const fetchCount = async (body) => {
  const response = await axios.post(APOLLO_SEARCH_URL, body, { headers: apolloHeaders(), timeout: 60000 });
  return response.data.pagination?.total_entries ?? 0;
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set in backend/.env');

  const results = {};
  for (const region of THIN_REGIONS) {
    results[region] = {};
    for (const [variantName, build] of Object.entries(VARIANTS)) {
      // Sequential to stay well under Apollo rate limits.
      const count = await fetchCount(build(region));
      results[region][variantName] = count;
    }
  }

  const variantNames = Object.keys(VARIANTS);
  console.log('\nLive Apollo pool size (icp2) — current filters vs. candidate broadened filters\n');
  console.log('region'.padEnd(10), ...variantNames.map((v) => v.padStart(24)));
  for (const region of THIN_REGIONS) {
    console.log(
      region.padEnd(10),
      ...variantNames.map((v) => String(results[region][v]).padStart(24))
    );
  }

  console.log('\n% lift over baseline:');
  console.log('region'.padEnd(10), ...variantNames.slice(1).map((v) => v.padStart(24)));
  for (const region of THIN_REGIONS) {
    const base = results[region].V0_baseline;
    const lifts = variantNames.slice(1).map((v) => {
      const pct = base > 0 ? (((results[region][v] - base) / base) * 100).toFixed(0) + '%' : 'n/a';
      return pct;
    });
    console.log(region.padEnd(10), ...lifts.map((l) => l.padStart(24)));
  }
};

main().catch((err) => {
  console.error('Experiment failed:', err.response?.data || err.message);
  process.exitCode = 1;
});
