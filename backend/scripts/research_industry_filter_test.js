/**
 * One-off filter experiment (throwaway, matches backend/scripts/research_v2_*.js
 * convention) — requested 2026-09-09.
 *
 * Pulls a real sample of companies from Apollo using ONLY four filter
 * categories from a saved Apollo search screenshot: employee size, Industry
 * include-list, Industry exclude-list, and Market Segments. Deliberately
 * drops everything else the production filters normally send (person_titles,
 * q_organization_keyword_tags / q_not_organization_keyword_tags,
 * prospected_by_current_team, REGION_KEYWORD_EXCLUDES) so this is a clean
 * read on what these four filters alone admit.
 *
 * organization_industry_tag_ids values were NOT guessable from anything in
 * this repo (only the exclude-list ids were already known, from filters.js).
 * "information technology & services" and "computer software" were read
 * straight out of Apollo's own UI network request (a live saved search),
 * not assumed — see the ids' inline comments below.
 *
 * Runs a fixed number of NEW companies (dedup by apolloAccountId, same as
 * the real pull path) through the real qualifierService pipeline — same
 * Claude rubric, same tools — so the qualify rate is directly comparable to
 * qualifiedRateReport.js's baseline methodology used in prior filter changes
 * (see docs/superpowers/specs/2026-08-11 and 2026-08-21).
 *
 * Deliberately does NOT touch the shared apolloPage_icp1_benelux
 * PipelineState cursor — that cursor's index math is keyed to the
 * PRODUCTION filter body (different result ordering/count from this
 * experiment's filters), so reusing it here would corrupt it further. This
 * script walks pages 1..N directly instead.
 *
 * Creates one real List (assignedTo: yonia@scytale.ai, name prefixed
 * "[TEST]") and real Company docs, so the AI qualifier sees genuine sites —
 * consistent with how every previous filter change in this repo was
 * evaluated. These DO count toward future net-new pool stats for
 * benelux/icp1 (they're now "in DB"), same as a real pull would.
 *
 * Usage: node scripts/research_industry_filter_test.js [targetCount]
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const apollo = require('../src/services/apolloService');
const { qualifyCompanies } = require('../src/services/qualifierService');

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const TARGET = Number(process.argv[2]) || 30;
const PER_PAGE = 25;

// Only the four categories from the screenshot, plus the geo scope
// ("benelux" isn't itself one of the four — it's just where we're told to
// run this). Nothing else from COMMON_FILTERS.
const TEST_FILTERS = {
  organization_locations: ['Luxembourg', 'Netherlands', 'Belgium'], // REGIONS.benelux
  organization_num_employees_ranges: ['1,10', '11,20', '21,50'],    // matches ICP1 bands
  organization_industry_tag_ids: [
    '5567cd4773696439b10b0000', // "information technology & services" — confirmed via Apollo UI network request
    '5567cd4e7369643b70010000', // "computer software" — confirmed via Apollo UI network request
  ],
  organization_not_industry_tag_ids: [ // identical to current production COMMON_FILTERS — unchanged, not part of the test
    '5567cd467369644d39040000',
    '5567e09973696410db020800',
    '5567cdd47369643dbf260000',
    '5567cd8e7369645409450000',
    '5567d1127261697f2b1d0000',
    '5567ce987369643b789e0000',
  ],
  market_segments: ['b2b', 'saas'],
};

async function fetchPage(page) {
  const res = await axios.post(
    APOLLO_SEARCH_URL,
    { page, per_page: PER_PAGE, ...TEST_FILTERS },
    { headers: apolloHeaders(), timeout: 60000 }
  );
  // Without prospected_by_current_team, Apollo splits matches across two
  // arrays — `organizations` (never prospected) and `accounts` (already
  // prospected by someone on the team) — instead of the single
  // `organizations` array production's search returns. Confirmed live: a
  // page-1 check on this exact filter body returned organizations.length=1,
  // accounts.length=24 for the same total_entries. Merge both so no match
  // is silently dropped.
  //
  // An `accounts` entry's own `id` is Apollo's internal CRM account-record
  // id (team/user-specific), NOT the organization id — the org id there is
  // `organization_id`. Using the account id against the enrich endpoint
  // (which expects an organization id) 404s/returns garbage, which is what
  // crashed the first fixed run. Remap so every entry's `.id` is uniformly
  // the organization id, matching what `organizations` entries already are.
  const accounts = (res.data.accounts || [])
    .filter((a) => a.organization_id)
    .map((a) => ({ ...a, id: a.organization_id }));
  return {
    organizations: [...(res.data.organizations || []), ...accounts],
    totalEntries: res.data.pagination?.total_entries ?? null,
  };
}

async function main() {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set in backend/.env');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in backend/.env');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const list = await List.create({
    name: `[TEST] industry-tag filter experiment — benelux/icp1 (${new Date().toISOString().slice(0, 10)})`,
    profile: 'icp1',
    region: 'benelux',
    requestedCount: TARGET,
    assignedTo: 'yonia@scytale.ai',
    pullMode: 'fixed',
    status: 'pulling',
  });
  console.log(`Test list: ${list._id.toString()}`);
  console.log(`Filters used: employee size (1-10/11-20/21-50), industry include (IT & services, computer software), industry exclude (6 ids, same as production), market segments (b2b, saas). Region: benelux.`);

  let page = 1;
  let saved = 0;
  let totalEntries = null;
  let exhausted = false;
  const savedCompanies = [];

  while (saved < TARGET && !exhausted) {
    const { organizations, totalEntries: te } = await fetchPage(page);
    if (te != null) totalEntries = te;
    if (organizations.length === 0) { exhausted = true; break; }

    for (const org of organizations) {
      if (saved >= TARGET) break;
      if (await Company.exists({ apolloAccountId: org.id })) continue; // already in our DB (any list)

      let enriched;
      try {
        enriched = await apollo.enrichOrganization(org.id);
      } catch (err) {
        console.log(`enrich failed for ${org.id}: ${err.message}`);
        continue;
      }
      if (!enriched) continue;

      const hasDomain = Boolean(enriched.website_url || enriched.primary_domain);
      const company = await Company.create({
        ...apollo.mapOrganization(enriched),
        icpProfile: 'icp1',
        listId: list._id,
        ...(hasDomain ? {} : { status: 'disqualified', disqualifyReason: 'No domain found on Apollo' }),
      });
      savedCompanies.push(company);
      saved++;
      console.log(`[${saved}/${TARGET}] saved ${company.companyName}${hasDomain ? '' : ' (no domain — auto-disqualified)'}`);
    }

    page++;
    if (totalEntries != null && (page - 1) * PER_PAGE >= totalEntries) exhausted = true;
  }

  console.log(`\nApollo total_entries for this filter set (benelux/icp1-size): ${totalEntries}`);
  console.log(`Collected ${saved} new companies (target ${TARGET}).`);
  await List.findByIdAndUpdate(list._id, { $set: { pulledCount: saved, status: 'qualifying' } });

  const pending = savedCompanies.filter((c) => c.status !== 'disqualified');
  console.log(`\nQualifying ${pending.length} companies with the real ICP rubric (sync mode, one at a time)...`);
  await qualifyCompanies(pending, async (msg) => console.log(`[qualify] ${msg}`));

  const finalCompanies = await Company.find({ listId: list._id });
  const counts = { qualified: 0, nei: 0, disqualified: 0, pending: 0 };
  for (const c of finalCompanies) counts[c.status] = (counts[c.status] || 0) + 1;
  await List.findByIdAndUpdate(list._id, { $set: { status: 'ready' } });

  console.log('\n=== RESULTS ===');
  console.log(`Total collected: ${finalCompanies.length}`);
  console.log(JSON.stringify(counts, null, 2));
  const rate = finalCompanies.length ? ((counts.qualified / finalCompanies.length) * 100).toFixed(1) : '0.0';
  console.log(`Qualify rate: ${rate}%`);
  console.log(`List id (for review in the app): ${list._id.toString()}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
