const List = require('../models/List');
const Company = require('../models/Company');
const PipelineState = require('../models/PipelineState');
const apollo = require('./apolloService');

const QUALIFY_CHUNK_SIZE = 30;

async function logProgress(listId, message) {
  console.log(`[pull] ${message}`);
  await List.findByIdAndUpdate(listId, {
    $set: { lastMessage: message },
    $push: { progressLog: { $each: [message], $slice: -50 } },
  });
}

async function getCursor(key) {
  const state = await PipelineState.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, value: 1 } },
    { upsert: true, new: true }
  );
  return state.value;
}

const setCursor = (key, value) => PipelineState.findOneAndUpdate({ key }, { $set: { value } });

// Pull Apollo pages until requestedCount NEW companies are saved, every page
// has been visited once (full wrap), or an empty page arrives with no totals.
async function collectCompanies(list, { search, enrich }) {
  const stateKey = `apolloPage_${list.profile}_${list.region}`;
  let page = await getCursor(stateKey);
  let saved = 0;
  let pagesVisited = 0;
  let totalPages = Infinity;

  while (saved < list.requestedCount && pagesVisited < totalPages) {
    const { organizations, pagination } = await search(list.profile, list.region, page);
    if (pagination.totalPages) totalPages = pagination.totalPages;
    pagesVisited++;

    if (!organizations.length && !pagination.totalPages) break;

    for (const org of organizations) {
      if (saved >= list.requestedCount) break;
      if (await Company.exists({ apolloAccountId: org.id })) continue;

      let enriched;
      try {
        enriched = await enrich(org.id);
      } catch (err) {
        console.error(`[pull] enrich failed for ${org.id}: ${err.message}`);
        continue;
      }
      if (!enriched) continue;

      const hasDomain = Boolean(enriched.website_url || enriched.primary_domain);
      await Company.create({
        ...apollo.mapOrganization(enriched),
        icpProfile: list.profile,
        listId: list._id,
        ...(hasDomain ? {} : { status: 'disqualified', disqualifyReason: 'No domain found on Apollo' }),
      });
      saved++;
    }

    page = totalPages !== Infinity && page >= totalPages ? 1 : page + 1;
    await setCursor(stateKey, page);
    await List.findByIdAndUpdate(list._id, { $set: { pulledCount: saved } });
    await logProgress(list._id, `Pulled ${saved}/${list.requestedCount} new companies...`);
  }

  return saved;
}

async function runPull(listId, deps = {}) {
  const search = deps.search || apollo.searchCompaniesPage;
  const enrich = deps.enrich || apollo.enrichOrganization;
  // Lazy default: qualifierService is built in Task 4 and needs ANTHROPIC_API_KEY.
  const qualifyBatch =
    deps.qualifyBatch || ((...args) => require('./qualifierService').qualifyCompaniesBatch(...args));

  try {
    const list = await List.findById(listId);
    if (!list) throw new Error(`List ${listId} not found`);

    const saved = await collectCompanies(list, { search, enrich });
    await List.findByIdAndUpdate(listId, { $set: { pulledCount: saved, status: 'qualifying' } });
    await logProgress(listId, `Pull complete — ${saved} new companies. Starting qualification...`);

    const pending = await Company.find({ listId, status: 'pending' });
    const chunks = Math.ceil(pending.length / QUALIFY_CHUNK_SIZE) || 0;
    for (let i = 0; i < pending.length; i += QUALIFY_CHUNK_SIZE) {
      const chunk = pending.slice(i, i + QUALIFY_CHUNK_SIZE);
      await logProgress(
        listId,
        `Qualifying batch ${i / QUALIFY_CHUNK_SIZE + 1}/${chunks} (${chunk.length} companies)...`
      );
      await qualifyBatch(chunk, (msg) => logProgress(listId, msg));
    }

    await List.findByIdAndUpdate(listId, { $set: { status: 'ready' } });
    await logProgress(listId, 'List is ready for review.');
  } catch (err) {
    console.error(`[pull] list ${listId} failed: ${err.message}`);
    await List.findByIdAndUpdate(listId, { $set: { status: 'failed', error: err.message } });
    await logProgress(listId, `Pull failed: ${err.message}`);
  }
}

// Startup recovery: the job runs in-process, so a restart strands running lists.
async function markStaleListsFailed() {
  const result = await List.updateMany(
    { status: { $in: ['pulling', 'qualifying'] } },
    { $set: { status: 'failed', error: 'Server restarted mid-pull' } }
  );
  return result.modifiedCount;
}

module.exports = { runPull, collectCompanies, logProgress, markStaleListsFailed };
