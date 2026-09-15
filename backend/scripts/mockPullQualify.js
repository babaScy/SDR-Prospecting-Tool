/**
 * Mock pull+qualify: pulls a sample of companies for a given profile/region
 * straight from Apollo, runs them through the real AI qualifier, and reports
 * the qualification rate — WITHOUT creating a List or persisting any Company
 * documents. Useful for sanity-checking a profile/region combo (e.g. a
 * not-yet-live region like "us") before turning it on for real pulls.
 *
 * How the "don't persist" part works: qualifierService.persistResult writes
 * via Company.findByIdAndUpdate(fakeObjectId, ...). Mongoose still needs a
 * live connection for that call to resolve (buffered queries hang forever
 * otherwise), but since the fake id matches no real document and we never
 * pass { upsert: true }, the write is a genuine no-op — nothing is created,
 * updated, or read. The qualifier itself (the real Anthropic call, the real
 * prompt) is exercised exactly as it would be in production.
 *
 * Usage: node scripts/mockPullQualify.js <profile> <region> [sampleSize=10] [page=1]
 * Example: node scripts/mockPullQualify.js icp2 us 10
 * Example: node scripts/mockPullQualify.js icp1 benelux 10 73   (sample page 73, to probe deep-pool quality)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const apollo = require('../src/services/apolloService');
const { qualifyCompaniesSync } = require('../src/services/qualifierService');

const [, , profile = 'icp2', region = 'us', sampleSizeArg, pageArg] = process.argv;
const SAMPLE_SIZE = Number(sampleSizeArg) || 10;
const PAGE = Number(pageArg) || 1;

const main = async () => {
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY not set');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');

  console.log(`\n=== MOCK pull+qualify: profile=${profile} region=${region} sample=${SAMPLE_SIZE} ===`);
  console.log('(no List or Company documents will be created — this is read-only against Apollo/Anthropic)\n');

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const { organizations, pagination } = await apollo.searchCompaniesPage(profile, region, PAGE, SAMPLE_SIZE);
  console.log(`Apollo pool for ${profile}/${region}: ${pagination.totalEntries} total, sampling ${organizations.length} from page ${PAGE}\n`);

  const candidates = [];
  for (const org of organizations) {
    let enriched;
    try {
      enriched = await apollo.enrichOrganization(org.id);
    } catch (err) {
      console.error(`  enrich failed for ${org.name} (${org.id}): ${err.message}`);
      continue;
    }
    const mapped = apollo.mapOrganization(enriched || org);
    candidates.push({ _id: new mongoose.Types.ObjectId(), ...mapped });
  }

  const withDomain = candidates.filter((c) => c.website);
  const noDomain = candidates.length - withDomain.length;
  console.log(`${withDomain.length}/${candidates.length} resolved a domain` +
    (noDomain ? ` (${noDomain} auto-disqualified for no domain, same as a real pull)` : '') + '\n');

  const results = await qualifyCompaniesSync(withDomain, (msg) => console.log(`  ${msg}`));

  const tally = { qualified: 0, disqualified: 0, nei: 0, error: 0 };
  const rows = [];
  for (const c of withDomain) {
    const r = results.get(c._id.toString());
    let bucket;
    if (!r || !r.ok) bucket = 'error';
    else if (r.data.icp === 'Yes') bucket = 'qualified';
    else if (r.data.icp === 'Not enough information') bucket = 'nei';
    else bucket = 'disqualified';
    tally[bucket]++;
    rows.push({ name: c.companyName, website: c.website, verdict: bucket, error: r?.error });
  }
  tally.disqualified += noDomain;

  console.log('\nPer-company verdicts:');
  rows.forEach((r) =>
    console.log(`  ${r.verdict.padEnd(12)} ${r.name}  (${r.website})${r.error ? `  [${r.error}]` : ''}`)
  );
  if (noDomain) console.log(`  ${'disqualified'.padEnd(12)} [${noDomain} companies with no resolvable domain]`);

  const total = candidates.length;
  console.log(`\n=== ${profile}/${region} mock results ===`);
  console.log(`total=${total} qualified=${tally.qualified} disqualified=${tally.disqualified} nei=${tally.nei} error=${tally.error}`);
  console.log(`qualify rate = ${tally.qualified}/${total} = ${total ? ((tally.qualified / total) * 100).toFixed(1) : 0}%`);
  console.log('\nNothing was persisted — no List or Company documents were created for this run.');

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
