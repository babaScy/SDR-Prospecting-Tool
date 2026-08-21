/**
 * NEW research pass (2026-08-21), read-only. Distinct from the 2026-08-11
 * batch's scripts.
 *
 * With the DB now at 1590 companies (vs 572 on 2026-08-11), re-run
 * industry/technologies correlation against qualify vs disqualify outcomes,
 * specifically sliced for benelux, nordics, and icp2-across-all-regions, to
 * see whether any industry value or technology tag now has enough n to be
 * a usable signal that ISN'T already covered by q_organization_keyword_tags.
 *
 * Usage: node scripts/research_v2_industry_correlation.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const List = require('../src/models/List');
const { ICP1_FILTERS } = require('../src/config/filters');

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const CURRENT_KEYWORDS = new Set(ICP1_FILTERS.q_organization_keyword_tags.map((k) => k.toLowerCase()));

const industryBreakdown = (label, companies) => {
  const byIndustry = {};
  for (const c of companies) {
    const ind = (c.industry || '(none)').toLowerCase().trim();
    byIndustry[ind] = byIndustry[ind] || { total: 0, qualified: 0, disqualified: 0, nei: 0 };
    byIndustry[ind].total++;
    byIndustry[ind][c.status] = (byIndustry[ind][c.status] || 0) + 1;
  }
  const rows = Object.entries(byIndustry).sort((a, b) => b[1].total - a[1].total);
  console.log(`\n=== ${label} — industry breakdown (n=${companies.length}) ===`);
  console.log('industry'.padEnd(45), 'total'.padEnd(7), 'qual'.padEnd(6), 'dq'.padEnd(6), 'nei'.padEnd(5), 'qualRate');
  for (const [ind, s] of rows) {
    const decided = s.qualified + s.disqualified + s.nei;
    console.log(
      ind.padEnd(45),
      String(s.total).padEnd(7),
      String(s.qualified || 0).padEnd(6),
      String(s.disqualified || 0).padEnd(6),
      String(s.nei || 0).padEnd(5),
      `${pct(s.qualified || 0, decided)}%`
    );
  }
  return byIndustry;
};

const tokenFreqBreakdown = (label, companies, field) => {
  const qualFreq = {};
  const dqFreq = {};
  let qualN = 0, dqN = 0;
  for (const c of companies) {
    const toks = (c[field] || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
    if (c.status === 'qualified') {
      qualN++;
      for (const t of toks) qualFreq[t] = (qualFreq[t] || 0) + 1;
    } else if (c.status === 'disqualified') {
      dqN++;
      for (const t of toks) dqFreq[t] = (dqFreq[t] || 0) + 1;
    }
  }
  const allTokens = new Set([...Object.keys(qualFreq), ...Object.keys(dqFreq)]);
  const rows = [];
  for (const t of allTokens) {
    const q = qualFreq[t] || 0;
    const d = dqFreq[t] || 0;
    const total = q + d;
    if (total < 3) continue; // ignore tiny long-tail
    const rateW = total > 0 ? q / total : NaN;
    const qPresentPct = qualN > 0 ? q / qualN : 0;
    const dPresentPct = dqN > 0 ? d / dqN : 0;
    const lift = dPresentPct > 0 ? qPresentPct / dPresentPct : (qPresentPct > 0 ? Infinity : NaN);
    rows.push({ t, q, d, rateW, qPresentPct, dPresentPct, lift, alreadyInFilter: CURRENT_KEYWORDS.has(t) });
  }
  rows.sort((a, b) => (b.lift === Infinity ? 1 : b.lift) - (a.lift === Infinity ? 1 : a.lift));
  console.log(`\n=== ${label} — ${field} token correlation (qualN=${qualN}, dqN=${dqN}), sorted by lift desc, min total=3 ===`);
  console.log('token'.padEnd(35), 'q'.padEnd(4), 'd'.padEnd(4), 'rate'.padEnd(7), 'qPres%'.padEnd(8), 'dPres%'.padEnd(8), 'lift'.padEnd(7), 'inFilter?');
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.t.padEnd(35),
      String(r.q).padEnd(4),
      String(r.d).padEnd(4),
      `${(r.rateW * 100).toFixed(0)}%`.padEnd(7),
      `${(r.qPresentPct * 100).toFixed(1)}%`.padEnd(8),
      `${(r.dPresentPct * 100).toFixed(1)}%`.padEnd(8),
      (r.lift === Infinity ? 'inf' : r.lift.toFixed(2) + 'x').padEnd(7),
      r.alreadyInFilter ? 'yes' : 'NO'
    );
  }
  return rows;
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const lists = await List.find({}).select('region profile').lean();
  const listMeta = new Map(lists.map((l) => [l._id.toString(), { region: l.region, profile: l.profile }]));

  const decided = await Company.find({ status: { $in: ['qualified', 'disqualified'] } })
    .select('listId icpProfile status industry keywords technologies companyName')
    .lean();

  const withMeta = decided.map((c) => {
    const meta = listMeta.get(c.listId?.toString());
    return { ...c, region: meta?.region || 'UNKNOWN', profile: c.icpProfile || meta?.profile || 'UNKNOWN' };
  });

  console.log(`Total qualified+disqualified companies: ${withMeta.length}`);

  const benelux = withMeta.filter((c) => c.region === 'benelux');
  const nordics = withMeta.filter((c) => c.region === 'nordics');
  const icp2All = withMeta.filter((c) => c.profile === 'icp2');
  const beneluxNordicsIcp2 = withMeta.filter((c) => (c.region === 'benelux' || c.region === 'nordics') && c.profile === 'icp2');

  industryBreakdown('BENELUX (all profiles)', benelux);
  industryBreakdown('NORDICS (all profiles)', nordics);
  industryBreakdown('ICP2 (all regions)', icp2All);

  industryBreakdown('BENELUX+NORDICS icp2', beneluxNordicsIcp2);

  tokenFreqBreakdown('BENELUX (all profiles) — technologies', benelux, 'technologies');
  tokenFreqBreakdown('NORDICS (all profiles) — technologies', nordics, 'technologies');
  tokenFreqBreakdown('ICP2 (all regions) — technologies', icp2All, 'technologies');

  // Also check keywords tokens for benelux/nordics specifically vs global filter list,
  // to catch anything region-specific the 08-11 global pass wouldn't have surfaced.
  tokenFreqBreakdown('BENELUX (all profiles) — keywords', benelux, 'keywords');
  tokenFreqBreakdown('NORDICS (all profiles) — keywords', nordics, 'keywords');

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
