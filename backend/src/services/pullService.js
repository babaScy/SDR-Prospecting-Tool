const List = require('../models/List');
const Company = require('../models/Company');
const PipelineState = require('../models/PipelineState');
const apollo = require('./apolloService');
const quotaService = require('./quotaService');
const { makeLimiter } = require('../util/limiter');
const {
  APOLLO_PER_PAGE, ENRICH_CONCURRENCY, FIRST_BATCH_SIZE, getDailyQuota, SESSION_MAX_PULLED,
  MAX_CONSECUTIVE_EMPTY_ITEMS,
} = require('../config/pullConfig');

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
    // Conditional: only reshape while still numeric, so a concurrent reshape or $inc is never clobbered.
    await PipelineState.updateOne({ key, value: { $type: 'number' } }, { $set: { value: reshaped } });
    const fresh = await PipelineState.findOne({ key });
    return { perPage: APOLLO_PER_PAGE, totalItems: null, ...fresh.value };
  }
  return { perPage: APOLLO_PER_PAGE, totalItems: null, ...doc.value };
}

// Atomically reserve k item indices. Returns half-open [start, end).
async function reserveItems(key, k) {
  await readCursor(key); // reshape legacy docs before $inc on a nested path
  // The upsert can throw a transient E11000 when two pulls create the same
  // brand-new cursor doc at the same instant. On retry the doc exists, so the
  // $inc simply updates it — no create, no collision.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const doc = await PipelineState.findOneAndUpdate(
        { key }, { $inc: { 'value.next': k } }, { upsert: true, new: true }
      );
      const end = doc.value.next;
      return { start: end - k, end };
    } catch (err) {
      if (err.code === 11000 && attempt === 0) continue; // racing create — retry once
      throw err;
    }
  }
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
      // Refresh on every fetch, not just once — Apollo's live total for this
      // region/profile query grows over time as sourcing filters broaden.
      // A totalItems cached once and never updated makes the modulo cursor
      // wrap into already-pulled indices and falsely report the pool as
      // exhausted long before it actually is (see 2026-09-03 investigation:
      // benelux/icp1 was cached at 382 from 2026-08-03, while the live pool
      // had grown to 2936). The apolloAccountId dedup check already guards
      // against double-saving, so it's safe to let this value move.
      if (res.pagination.totalEntries && res.pagination.totalEntries !== totalItems) {
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

// Admin path: loop collectBatch toward requestedCount, giving up once
// MAX_CONSECUTIVE_EMPTY_ITEMS candidates in a row turned out to already
// exist, so we never spin forever on a thin region. A single all-dupe round
// isn't proof of exhaustion by itself — see MAX_CONSECUTIVE_EMPTY_ITEMS'
// comment in pullConfig.js (the shared cursor wraps once a region/profile's
// pool has been fully walked, and dedup-skips on a wrapped, re-walked
// stretch look identical to a genuinely dry pool unless given enough items
// to walk past it).
async function collectCompanies(list, { search, enrich }) {
  // Seeded from list.pulledCount (not 0) so a resumed run after a server
  // restart tops up toward requestedCount instead of over-pulling on top of
  // whatever an earlier, interrupted run already saved.
  let saved = list.pulledCount || 0;
  let consecutiveEmptyItems = 0;
  while (saved < list.requestedCount) {
    const want = list.requestedCount - saved;
    const round = await collectBatch(list, want, { search, enrich });
    saved += round;
    await List.findByIdAndUpdate(list._id, { $set: { pulledCount: saved } });
    await logProgress(list._id, `Pulled ${saved}/${list.requestedCount} new companies...`);
    if (round === 0) {
      consecutiveEmptyItems += want;
      if (consecutiveEmptyItems >= MAX_CONSECUTIVE_EMPTY_ITEMS) {
        await logProgress(list._id, `No new companies after checking ${consecutiveEmptyItems} candidates — pool exhausted for this region/profile.`);
        break;
      }
    } else {
      consecutiveEmptyItems = 0;
    }
  }
  return saved;
}

// SDR self-serve path: first batch of FIRST_BATCH_SIZE, then top-ups of
// (region's daily quota - qualifiedToday), qualifying each round's new
// pending companies, until quota reached / safety cap / pool exhausted.
async function runQuotaPull(list, deps = {}) {
  const search = deps.search || apollo.searchCompaniesPage;
  const enrich = deps.enrich || apollo.enrichOrganization;
  // Lazy default: qualifierService is built in Task 6 and needs ANTHROPIC_API_KEY.
  const qualify = deps.qualify || ((...args) => require('./qualifierService').qualifyCompanies(...args));
  const qualifiedToday = deps.qualifiedToday || quotaService.qualifiedToday;

  const sdr = list.assignedTo;
  const quota = getDailyQuota(list.region);
  // Seeded from list.pulledCount (not 0) so a resumed run after a server
  // restart tops up from where an earlier, interrupted run left off, instead
  // of redoing the FIRST_BATCH_SIZE first-batch round on top of it.
  let pulledThisSession = list.pulledCount || 0;
  let round = pulledThisSession > 0 ? 1 : 0;
  let consecutiveEmptyItems = 0;

  while (true) {
    const already = await qualifiedToday(sdr, list.region);
    if (already >= quota) break;
    if (pulledThisSession >= SESSION_MAX_PULLED) break;

    const want = round === 0 ? FIRST_BATCH_SIZE : quota - already;
    const k = Math.min(want, SESSION_MAX_PULLED - pulledThisSession);
    if (k <= 0) break;

    await List.findByIdAndUpdate(list._id, { $set: { status: 'pulling' } });
    await logProgress(list._id, `Round ${round + 1}: pulling ${k} companies...`);
    const saved = await collectBatch(list, k, { search, enrich });
    pulledThisSession += saved;
    await List.findByIdAndUpdate(list._id, { $set: { status: 'qualifying', pulledCount: pulledThisSession } });

    const pending = await Company.find({ listId: list._id, status: 'pending' });
    if (pending.length) {
      await logProgress(list._id, `Round ${round + 1}: qualifying ${pending.length} companies...`);
      await qualify(pending, (msg) => logProgress(list._id, msg));
    }

    round++;
    if (saved === 0) {
      // A single empty round just means the handful of items reserved this
      // round happened to be dupes/enrich failures — not proof the pool is
      // dry, especially near quota where a round can be as small as 1 item.
      // Tracked in items checked (k), not rounds — see MAX_CONSECUTIVE_EMPTY_ITEMS'
      // comment in pullConfig.js for why a round-count budget isn't enough
      // once the shared cursor has wrapped into an already-covered stretch.
      consecutiveEmptyItems += k;
      if (consecutiveEmptyItems >= MAX_CONSECUTIVE_EMPTY_ITEMS) {
        await logProgress(list._id, `No new companies after checking ${consecutiveEmptyItems} candidates — pool exhausted for this region/profile.`);
        break;
      }
    } else {
      consecutiveEmptyItems = 0;
    }
  }

  await List.findByIdAndUpdate(list._id, { $set: { status: 'ready' } });
  await logProgress(list._id, 'List is ready for review.');
}

async function runPull(listId, deps = {}) {
  const search = deps.search || apollo.searchCompaniesPage;
  const enrich = deps.enrich || apollo.enrichOrganization;
  // Mode-aware dispatcher (same one runQuotaPull uses) — picks sync vs. the
  // Batches API per the admin-configured qualification-mode setting (and
  // always sync under SYNC_THRESHOLD regardless of that setting). This used
  // to hardcode qualifyCompaniesBatch directly, which ignored the setting
  // entirely — an admin/fixed pull always went to the (slow) Batches API no
  // matter what "single mode" was set to. Lazy default: qualifierService
  // needs ANTHROPIC_API_KEY.
  const qualify = deps.qualify || ((...args) => require('./qualifierService').qualifyCompanies(...args));

  try {
    const list = await List.findById(listId);
    if (!list) throw new Error(`List ${listId} not found`);

    if (list.pullMode === 'quota') {
      await runQuotaPull(list, deps);
      return;
    }

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
      await qualify(chunk, (msg) => logProgress(listId, msg));
    }

    await List.findByIdAndUpdate(listId, { $set: { status: 'ready' } });
    await logProgress(listId, 'List is ready for review.');
  } catch (err) {
    console.error(`[pull] list ${listId} failed: ${err.message}`);
    await List.findByIdAndUpdate(listId, { $set: { status: 'failed', error: err.message } });
    await logProgress(listId, `Pull failed: ${err.message}`);
  }
}

// Startup recovery: the job runs in-process, so a restart (a crash, a deploy,
// or — in dev — nodemon restarting on a source-file edit while a pull is
// mid-flight) strands running lists. Pull/qualify jobs are resumable: both
// collectCompanies and runQuotaPull now seed their running counts from
// list.pulledCount (already persisted after every round) instead of 0, so
// re-running them from here just continues where the crash left off — a
// crash only costs whichever single company was mid-flight at that instant,
// not the whole list (see 2026-09-07 investigation: a Benelux SDR's list hit
// this exact path and lost nothing — it had already reached quota). Contact
// sourcing ('sourcing' status) isn't resumable yet, so those are still
// flipped to failed as before.
async function resumeStaleLists(deps = {}) {
  const stranded = await List.find({ status: { $in: ['pulling', 'qualifying'] } });
  for (const list of stranded) {
    runPull(list._id, deps).catch((err) => console.error(`[pull] resume failed for ${list._id}: ${err.message}`));
  }

  const sourcingResult = await List.updateMany(
    { status: 'sourcing' },
    { $set: { status: 'failed', error: 'Server restarted mid-job' } }
  );

  return { resumed: stranded.length, failed: sourcingResult.modifiedCount };
}

module.exports = {
  runPull,
  runQuotaPull,
  collectCompanies,
  collectBatch,
  reserveItems,
  readCursor,
  logProgress,
  resumeStaleLists,
};
