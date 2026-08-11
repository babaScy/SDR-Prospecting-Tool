/**
 * Research script (read-only): pull all disqualified companies that were
 * actually evaluated by the AI qualifier (qualification.reasoning populated),
 * excluding auto-disqualifies for missing domain / unreachable site.
 *
 * Writes results to a JSON file under backend/scripts/ for offline analysis.
 *
 * Usage: node scripts/research_keywords_disqualified_pull.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Company = require('../src/models/Company');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const totalDisqualified = await Company.countDocuments({ status: 'disqualified' });

  const companies = await Company.find({
    status: 'disqualified',
    'qualification.reasoning': { $exists: true, $nin: [null, ''] },
  })
    .select(
      'companyName industry keywords technologies shortDescription disqualifyReason qualification listId icpProfile country website'
    )
    .lean();

  // Exclude auto-disqualifies not about keyword filters (missing domain / unreachable site)
  const isAutoDisqualify = (reason) => {
    if (!reason) return false;
    const r = reason.toLowerCase();
    return (
      r.includes('no domain') ||
      r.includes('unreachable') ||
      r.includes('could not reach') ||
      r.includes('website not found') ||
      r.includes('no website') ||
      r.includes('failed to fetch') ||
      r.includes('dns') ||
      r.includes('timeout') ||
      r.includes('timed out')
    );
  };

  const evaluated = companies.filter((c) => !isAutoDisqualify(c.disqualifyReason));
  const autoDisqualified = companies.length - evaluated.length;

  console.log(`Total status=disqualified in DB: ${totalDisqualified}`);
  console.log(`With populated qualification.reasoning: ${companies.length}`);
  console.log(`  of which auto-disqualify (domain/unreachable) excluded: ${autoDisqualified}`);
  console.log(`  Evaluated-by-AI set (final): ${evaluated.length}`);

  // Also grab region via List lookup for context (best-effort)
  const List = require('../src/models/List');
  const listIds = [...new Set(evaluated.map((c) => String(c.listId)))];
  const lists = await List.find({ _id: { $in: listIds } }).select('region profile').lean();
  const listMap = new Map(lists.map((l) => [String(l._id), l]));

  const enriched = evaluated.map((c) => ({
    companyName: c.companyName,
    website: c.website,
    country: c.country,
    region: listMap.get(String(c.listId))?.region,
    profile: listMap.get(String(c.listId))?.profile || c.icpProfile,
    industry: c.industry,
    keywords: c.keywords,
    technologies: c.technologies,
    shortDescription: c.shortDescription,
    disqualifyReason: c.disqualifyReason,
    isB2B: c.qualification?.isB2B,
    isSaaS: c.qualification?.isSaaS,
    icp: c.qualification?.icp,
    reasoning: c.qualification?.reasoning,
  }));

  const outPath = path.join(__dirname, 'research_keywords_disqualified_data.json');
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2));
  console.log(`\nWrote ${enriched.length} records to ${outPath}`);

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
