/**
 * NEW research pass (2026-08-21), read-only. Distinct from the 2026-08-11
 * batch's research_titles_ and research_keywords_ scripts.
 *
 * Part A (DB): qualify rate by employee-count bucket, overall and broken out
 * for icp2, benelux, and nordics specifically, to see whether companies near
 * icp2's current employee_num_ranges boundaries (51-250) that we already have
 * data for (e.g. because a company enriched near the boundary, or an icp1/
 * icp3 pull happened to surface a 41-50 or 251-300 company) qualify at a rate
 * that would justify widening the band.
 *
 * Part B (live Apollo, count-only, GET/POST search with per_page=1 so no
 * records are pulled or saved): compares current icp2 organization_num_
 * employees_ranges against variants that extend the band down to 41,50 or up
 * to 251,300, for benelux and nordics specifically (the two weak segments).
 *
 * Usage: node scripts/research_v2_employee_bands.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Company = require('../src/models/Company');
const List = require('../src/models/List');
const { ICP2_FILTERS, REGIONS } = require('../src/config/filters');

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const bucketFor = (employees) => {
  if (employees == null) return '(none)';
  if (employees <= 10) return '1-10';
  if (employees <= 20) return '11-20';
  if (employees <= 40) return '21-40';
  if (employees <= 50) return '41-50';
  if (employees <= 100) return '51-100';
  if (employees <= 200) return '101-200';
  if (employees <= 250) return '201-250';
  if (employees <= 300) return '251-300';
  if (employees <= 500) return '301-500';
  if (employees <= 1000) return '501-1000';
  return '1001+';
};

const BUCKET_ORDER = ['1-10', '11-20', '21-40', '41-50', '51-100', '101-200', '201-250', '251-300', '301-500', '501-1000', '1001+', '(none)'];

const printBreakdown = (label, companies) => {
  const byBucket = {};
  for (const c of companies) {
    const b = bucketFor(c.employees);
    byBucket[b] = byBucket[b] || { total: 0, qualified: 0, disqualified: 0, nei: 0 };
    byBucket[b].total++;
    if (c.status === 'qualified') byBucket[b].qualified++;
    else if (c.status === 'disqualified') byBucket[b].disqualified++;
    else if (c.status === 'nei') byBucket[b].nei++;
  }
  console.log(`\n=== ${label} — employee bucket vs status ===`);
  console.log('bucket'.padEnd(10), 'total'.padEnd(7), 'qualified'.padEnd(10), 'disqualified'.padEnd(13), 'nei'.padEnd(5), 'qualRate');
  for (const b of BUCKET_ORDER) {
    const s = byBucket[b];
    if (!s) continue;
    const decided = s.qualified + s.disqualified + s.nei;
    console.log(
      b.padEnd(10),
      String(s.total).padEnd(7),
      String(s.qualified).padEnd(10),
      String(s.disqualified).padEnd(13),
      String(s.nei).padEnd(5),
      `${pct(s.qualified, decided)}%`
    );
  }
};

const fetchCount = async (body) => {
  try {
    const response = await axios.post(APOLLO_SEARCH_URL, body, { headers: apolloHeaders(), timeout: 60000 });
    return response.data.pagination?.total_entries ?? 0;
  } catch (err) {
    console.error('Apollo call failed:', err.response?.data || err.message);
    return null;
  }
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const lists = await List.find({}).select('region profile').lean();
  const listMeta = new Map(lists.map((l) => [l._id.toString(), { region: l.region, profile: l.profile }]));

  const all = await Company.find({ status: { $in: ['qualified', 'disqualified', 'nei'] } })
    .select('listId icpProfile status employees companyName')
    .lean();

  const withMeta = all.map((c) => {
    const meta = listMeta.get(c.listId?.toString());
    return { ...c, region: meta?.region || 'UNKNOWN', profile: c.icpProfile || meta?.profile || 'UNKNOWN' };
  });

  console.log('=== PART A: DB employee-bucket vs qualify-rate ===');
  console.log(`(n=${withMeta.length} decided companies overall)`);

  printBreakdown('ALL REGIONS / ALL PROFILES', withMeta);
  printBreakdown('ALL REGIONS / icp2 ONLY', withMeta.filter((c) => c.profile === 'icp2'));
  printBreakdown('BENELUX / ALL PROFILES', withMeta.filter((c) => c.region === 'benelux'));
  printBreakdown('BENELUX / icp2 ONLY', withMeta.filter((c) => c.region === 'benelux' && c.profile === 'icp2'));
  printBreakdown('NORDICS / ALL PROFILES', withMeta.filter((c) => c.region === 'nordics'));
  printBreakdown('NORDICS / icp2 ONLY', withMeta.filter((c) => c.region === 'nordics' && c.profile === 'icp2'));

  // Specifically flag boundary buckets across all regions/profiles, since these are thin.
  console.log('\n=== Boundary-bucket companies (41-50 and 251-300), any region/profile, with names ===');
  const boundary = withMeta.filter((c) => ['41-50', '251-300'].includes(bucketFor(c.employees)));
  console.log(`n=${boundary.length}`);
  for (const c of boundary) {
    console.log(`  [${c.region}/${c.profile}] ${c.companyName} — employees=${c.employees} status=${c.status}`);
  }

  await mongoose.disconnect();

  if (!process.env.APOLLO_API_KEY) {
    console.log('\nAPOLLO_API_KEY not set — skipping Part B live experiment.');
    return;
  }

  console.log('\n=== PART B: live Apollo pool-size, icp2 employee-band variants (count-only, per_page=1) ===');
  const THIN_REGIONS = ['benelux', 'nordics'];
  const VARIANTS = {
    V0_current: ['51,100', '101,200', '201,250'],
    V1_extend_down_41_50: ['41,50', '51,100', '101,200', '201,250'],
    V2_extend_up_251_300: ['51,100', '101,200', '201,250', '251,300'],
    V3_extend_both: ['41,50', '51,100', '101,200', '201,250', '251,300'],
  };

  const results = {};
  for (const region of THIN_REGIONS) {
    results[region] = {};
    for (const [name, ranges] of Object.entries(VARIANTS)) {
      const body = {
        page: 1,
        per_page: 1,
        ...ICP2_FILTERS,
        organization_num_employees_ranges: ranges,
        organization_locations: REGIONS[region],
      };
      results[region][name] = await fetchCount(body);
    }
  }

  const variantNames = Object.keys(VARIANTS);
  console.log('\nregion'.padEnd(10), ...variantNames.map((v) => v.padStart(26)));
  for (const region of THIN_REGIONS) {
    console.log(region.padEnd(10), ...variantNames.map((v) => String(results[region][v]).padStart(26)));
  }

  console.log('\n% lift over V0_current:');
  console.log('region'.padEnd(10), ...variantNames.slice(1).map((v) => v.padStart(26)));
  for (const region of THIN_REGIONS) {
    const base = results[region].V0_current;
    const lifts = variantNames.slice(1).map((v) => {
      const p = base > 0 ? (((results[region][v] - base) / base) * 100).toFixed(0) + '%' : 'n/a';
      return p;
    });
    console.log(region.padEnd(10), ...lifts.map((l) => l.padStart(26)));
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
