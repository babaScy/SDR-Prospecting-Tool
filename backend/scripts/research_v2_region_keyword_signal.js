/**
 * NEW research pass (2026-08-21), read-only.
 *
 * Looks for keyword/tag signal that is disproportionately present in
 * benelux or nordics QUALIFIED companies specifically, vs. the same
 * keyword's behavior globally — i.e. something a region-specific slice
 * would show that a global correlation pass (like the 08-11 batch's
 * research_keywords_correlation.js) would wash out.
 *
 * Method: for each keyword token seen on qualified companies in
 * benelux/nordics, compute:
 *   - regional lift = qualify-rate-given-tag (in-region) / qualify-rate-given-tag (rest of world)
 *   - regional presence = % of in-region qualified companies carrying the tag
 *     vs % of rest-of-world qualified companies carrying the tag
 * A token with high presence in-region but low/absent presence elsewhere is
 * the "region-specific signal" this is looking for.
 *
 * Usage: node scripts/research_v2_region_keyword_signal.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const List = require('../src/models/List');
const { ICP1_FILTERS } = require('../src/config/filters');

const CURRENT_KEYWORDS = new Set(ICP1_FILTERS.q_organization_keyword_tags.map((k) => k.toLowerCase()));
const MIN_N = 3;

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const analyzeRegion = (regionName, regionCompanies, restCompanies) => {
  const regionQualified = regionCompanies.filter((c) => c.status === 'qualified');
  const regionDisqualified = regionCompanies.filter((c) => c.status === 'disqualified');
  const restQualified = restCompanies.filter((c) => c.status === 'qualified');
  const restDisqualified = restCompanies.filter((c) => c.status === 'disqualified');

  console.log(`\n=== ${regionName} — n=${regionCompanies.length} (qualified=${regionQualified.length}, disqualified=${regionDisqualified.length}) ===`);
  console.log(`Rest of world — n=${restCompanies.length} (qualified=${restQualified.length}, disqualified=${restDisqualified.length})`);

  // Build per-token stats for tokens appearing on region-qualified companies.
  const tokenSet = new Set();
  for (const c of regionQualified) for (const k of c.keywords || []) tokenSet.add(k.toLowerCase().trim());

  const rows = [];
  for (const t of tokenSet) {
    if (!t) continue;
    const has = (c) => (c.keywords || []).some((k) => k.toLowerCase().trim() === t);

    const regQ = regionQualified.filter(has).length;
    const regD = regionDisqualified.filter(has).length;
    const restQ = restQualified.filter(has).length;
    const restD = restDisqualified.filter(has).length;

    const regTotal = regQ + regD;
    const restTotal = restQ + restD;
    if (regTotal < MIN_N) continue;

    const regRate = regTotal > 0 ? regQ / regTotal : NaN;
    const restRate = restTotal > 0 ? restQ / restTotal : NaN;

    const regQualPresence = regionQualified.length > 0 ? regQ / regionQualified.length : 0;
    const restQualPresence = restQualified.length > 0 ? restQ / restQualified.length : 0;

    // "Region-specific-ness": how much more this tag shows up among
    // region-qualified companies vs rest-of-world-qualified companies.
    const presenceLift = restQualPresence > 0 ? regQualPresence / restQualPresence : (regQualPresence > 0 ? Infinity : NaN);

    rows.push({
      t, regQ, regD, regRate, restQ, restD, restRate,
      regQualPresence, restQualPresence, presenceLift,
      alreadyInFilter: CURRENT_KEYWORDS.has(t),
    });
  }

  rows.sort((a, b) => (b.presenceLift === Infinity ? 1e9 : b.presenceLift) - (a.presenceLift === Infinity ? 1e9 : a.presenceLift));

  console.log(`\ntoken (min in-region n=${MIN_N}), sorted by region-specific presence-lift desc:`);
  console.log(
    'token'.padEnd(35), 'regQ'.padEnd(6), 'regD'.padEnd(6), 'regRate'.padEnd(9),
    'restQ'.padEnd(7), 'restD'.padEnd(7), 'restRate'.padEnd(10),
    'regQual%'.padEnd(10), 'restQual%'.padEnd(10), 'presLift'.padEnd(9), 'inFilter?'
  );
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.t.padEnd(35),
      String(r.regQ).padEnd(6), String(r.regD).padEnd(6), `${(r.regRate * 100).toFixed(0)}%`.padEnd(9),
      String(r.restQ).padEnd(7), String(r.restD).padEnd(7), `${(r.restRate * 100).toFixed(0)}%`.padEnd(10),
      `${(r.regQualPresence * 100).toFixed(1)}%`.padEnd(10), `${(r.restQualPresence * 100).toFixed(1)}%`.padEnd(10),
      (r.presenceLift === Infinity ? 'inf' : r.presenceLift.toFixed(2) + 'x').padEnd(9),
      r.alreadyInFilter ? 'yes' : 'NO'
    );
  }
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const lists = await List.find({}).select('region profile').lean();
  const listMeta = new Map(lists.map((l) => [l._id.toString(), { region: l.region, profile: l.profile }]));

  const decided = await Company.find({ status: { $in: ['qualified', 'disqualified'] } })
    .select('listId icpProfile status keywords companyName')
    .lean();

  const withMeta = decided.map((c) => {
    const meta = listMeta.get(c.listId?.toString());
    return { ...c, region: meta?.region || 'UNKNOWN', profile: c.icpProfile || meta?.profile || 'UNKNOWN' };
  });

  console.log(`Total qualified+disqualified: ${withMeta.length}`);
  const regionCounts = {};
  for (const c of withMeta) regionCounts[c.region] = (regionCounts[c.region] || 0) + 1;
  console.log('By region:', regionCounts);

  const benelux = withMeta.filter((c) => c.region === 'benelux');
  const nordics = withMeta.filter((c) => c.region === 'nordics');
  const restOfBenelux = withMeta.filter((c) => c.region !== 'benelux');
  const restOfNordics = withMeta.filter((c) => c.region !== 'nordics');

  analyzeRegion('BENELUX', benelux, restOfBenelux);
  analyzeRegion('NORDICS', nordics, restOfNordics);

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
