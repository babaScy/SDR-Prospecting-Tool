const List = require('../models/List');
const Company = require('../models/Company');
const PipelineState = require('../models/PipelineState');
const apollo = require('./apolloService');
const { makeLimiter } = require('../util/limiter');
const { APOLLO_PER_PAGE, ENRICH_CONCURRENCY } = require('../config/pullConfig');

const QUALIFY_CHUNK_SIZE = 30;

// Shared across all pulls in this process — bounds concurrent Apollo enrich calls.
const enrichLimiter = makeLimiter(ENRICH_CONCURRENCY);

async function logProgress(listId, message) {
  console.log(`[pull] ${message}`);
  await List.findByIdAndUpdate(listId, {
    $set: { lastMessage: message },
    $push: { progressLog: { $each: [message], $slice: -50 } },
  });
}

const cursorKey = (list) => `apolloPage_${list.profile}_${list.region}`;

// Reshape a legacy integer value (a page number) into the item-index shape.
async function readCursor(key) {
  const doc = await PipelineState.findOne({ key });
  if (!doc) return { next: 0, perPage: APOLLO_PER_PAGE, totalItems: null };
  if (typeof doc.value === 'number') {
    const reshaped = { next: (doc.value - 1) * APOLLO_PER_PAGE, perPage: APOLLO_PER_PAGE, totalItems: null };
    await PipelineState.updateOne({ key }, { $set: { value: reshaped } });
    return reshaped;
  }
  return { perPage: APOLLO_PER_PAGE, totalItems: null, ...doc.value };
}

// Atomically reserve k item indices. Returns half-open [start, end).
async function reserveItems(key, k) {
  await readCursor(key); // reshape legacy docs before $inc on a nested path
  const doc = await PipelineState.findOneAndUpdate(
    { key }, { $inc: { 'value.next': k } }, { upsert: true, new: true }
  );
  const end = doc.value.next;
  return { start: end - k, end };
}

const setTotalItems = (key, totalItems) =>
  PipelineState.updateOne({ key }, { $set: { 'value.totalItems': totalItems, 'value.perPage': APOLLO_PER_PAGE } });

// Reserve exactly k item indices and save the new companies they map to.
// Returns the number of NEW companies saved (may be < k due to dedup/enrich failures).
async function collectBatch(list, k, { search, enrich }) {
  if (k <= 0) return 0;
  const key = cursorKey(list);
  const { start, end } = await reserveItems(key, k);
  let { totalItems } = await readCursor(key);
  const perPage = APOLLO_PER_PAGE;

  const pageCache = new Map();
  const getPage = async (page) => {
    if (!pageCache.has(page)) {
      const res = await search(list.profile, list.region, page, perPage);
      if (res.pagination.totalEntries && !totalItems) {
        totalItems = res.pagination.totalEntries;
        await setTotalItems(key, totalItems);
      }
      pageCache.set(page, res.organizations);
    }
    return pageCache.get(page);
  };

  let saved = 0;
  for (let i = start; i < end; i++) {
    const idx = totalItems ? i % totalItems : i;
    const page = Math.floor(idx / perPage) + 1;
    const offset = idx % perPage;
    const orgs = await getPage(page);
    const org = orgs[offset];
    if (!org) continue; // past the end of available data

    if (await Company.exists({ apolloAccountId: org.id })) continue;

    let enriched;
    try {
      enriched = await enrichLimiter(() => enrich(org.id));
    } catch (err) {
      console.error(`[pull] enrich failed for ${org.id}: ${err.message}`);
      continue;
    }
    if (!enriched) continue;

    const hasDomain = Boolean(enriched.website_url || enriched.primary_domain);
    try {
      await Company.create({
        ...apollo.mapOrganization(enriched),
        icpProfile: list.profile,
        listId: list._id,
        ...(hasDomain ? {} : { status: 'disqualified', disqualifyReason: 'No domain found on Apollo' }),
      });
      saved++;
    } catch (err) {
      if (err.code === 11000) continue; // lost a race — skip, do not fail the pull
      throw err;
    }
  }
  return saved;
}

// Admin path: loop collectBatch toward requestedCount, stopping when a round
// saves 0 (pool exhausted) so we never spin forever on a thin region.
async function collectCompanies(list, { search, enrich }) {
  let saved = 0;
  while (saved < list.requestedCount) {
    const round = await collectBatch(list, list.requestedCount - saved, { search, enrich });
    saved += round;
    await List.findByIdAndUpdate(list._id, { $set: { pulledCount: saved } });
    await logProgress(list._id, `Pulled ${saved}/${list.requestedCount} new companies...`);
    if (round === 0) break; // no new companies available this pass
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

module.exports = { runPull, collectCompanies, collectBatch, reserveItems, readCursor, logProgress, markStaleListsFailed };
