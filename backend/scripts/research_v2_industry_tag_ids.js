/**
 * NEW research pass (2026-08-21), read-only, live Apollo API only (no DB).
 *
 * Resolves the opaque organization_industry_tag_ids /
 * organization_not_industry_tag_ids values in filters.js to human-readable
 * industry names. Apollo's public API has no documented standalone tag
 * typeahead/lookup endpoint, BUT mixed_companies/search echoes back a
 * `breadcrumbs` array in its response for every filter applied, each with a
 * `display_name` — e.g. for organization_industry_tag_ids it returns
 * {"label":"Industry","signal_field_name":"organization_industry_tag_ids",
 *  "value":"<id>","display_name":"information technology & services"}.
 * This is Apollo's own authoritative label for the id (not a guess/proxy),
 * discovered by calling the real search endpoint with per_page=1 for each id
 * individually. Read-only (POST .../search is a query endpoint).
 *
 * Usage: node scripts/research_v2_industry_tag_ids.js
 */
require('dotenv').config();
const axios = require('axios');
const { ICP1_FILTERS } = require('../src/config/filters');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const INCLUDE_IDS = ICP1_FILTERS.organization_industry_tag_ids;
const EXCLUDE_IDS = ICP1_FILTERS.organization_not_industry_tag_ids;

const resolveTag = async (id, field) => {
  try {
    const response = await axios.post(
      APOLLO_SEARCH_URL,
      { page: 1, per_page: 1, [field]: [id] },
      { headers: apolloHeaders(), timeout: 60000 }
    );
    const breadcrumb = (response.data.breadcrumbs || []).find((b) => b.signal_field_name === field && b.value === id);
    return {
      id,
      ok: true,
      displayName: breadcrumb?.display_name ?? '(no breadcrumb found)',
      totalEntries: response.data.pagination?.total_entries ?? 0,
    };
  } catch (err) {
    return { id, ok: false, error: err.response?.data || err.message };
  }
};

const main = async () => {
  if (!process.env.APOLLO_API_KEY) {
    console.error('APOLLO_API_KEY not set — cannot run live resolution.');
    process.exitCode = 1;
    return;
  }

  console.log('=== organization_industry_tag_ids (INCLUDE list, 4 ids) ===\n');
  for (const id of INCLUDE_IDS) {
    const r = await resolveTag(id, 'organization_industry_tag_ids');
    if (!r.ok) {
      console.log(`${id} -> ERROR: ${JSON.stringify(r.error)}`);
      continue;
    }
    console.log(`${id} -> "${r.displayName}"  (total_entries with only this filter=${r.totalEntries})`);
  }

  console.log('\n=== organization_not_industry_tag_ids (EXCLUDE list, 6 ids) ===');
  console.log('(resolved the same way — using organization_industry_tag_ids as the sole INCLUDE filter for the id, since the breadcrumb display_name for a given tag id is the same regardless of whether it is used as an include or exclude filter)\n');
  for (const id of EXCLUDE_IDS) {
    const r = await resolveTag(id, 'organization_industry_tag_ids');
    if (!r.ok) {
      console.log(`${id} -> ERROR: ${JSON.stringify(r.error)}`);
      continue;
    }
    console.log(`${id} -> "${r.displayName}"  (total_entries with only this filter=${r.totalEntries})`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
