const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const PipelineState = require('../src/models/PipelineState');
const { runPull, collectCompanies, collectBatch, reserveItems, readCursor, logProgress, resumeStaleLists } =
  require('../src/services/pullService');
const { SESSION_MAX_PULLED } = require('../src/config/pullConfig');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

// Flat pool of orgs, paginated by perPage — matches the item-index cursor.
const org = (id) => ({ id, name: `Co ${id}`, website_url: `https://${id}.com`, primary_domain: `${id}.com` });
const fakeSearchFlat = (ids) => async (profile, region, page, perPage) => {
  const all = ids.map(org);
  const startIdx = (page - 1) * perPage;
  return {
    organizations: all.slice(startIdx, startIdx + perPage),
    pagination: { page, totalPages: Math.ceil(all.length / perPage), totalEntries: all.length },
  };
};
const fakeEnrich = async (id) => ({ ...org(id), industry: 'software' });

const makeList = (overrides = {}) =>
  List.create({ name: 't', profile: 'icp1', region: 'uk', requestedCount: 4, assignedTo: 'davidv@scytale.ai', ...overrides });

test('reserveItems hands out disjoint, contiguous ranges (atomic)', async () => {
  const key = 'apolloPage_icp1_uk';
  const [a, b, c] = await Promise.all([
    reserveItems(key, 10), reserveItems(key, 10), reserveItems(key, 5),
  ]);
  const ranges = [a, b, c].sort((x, y) => x.start - y.start);
  assert.equal(ranges[0].start, 0);
  // no gaps, no overlaps
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  assert.equal((await readCursor(key)).next, 25);
});

test('reserveItems handles a legacy integer cursor under concurrency without overlap', async () => {
  const key = 'apolloPage_icp1_uk';
  await PipelineState.create({ key, value: 3 }); // legacy page-number cursor
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveItems(key, 10)));
  const ranges = results.sort((a, b) => a.start - b.start);
  assert.equal(ranges[0].start, 50); // seed (3-1)*25 = 50
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i].start, ranges[i - 1].end); // contiguous — no overlap, no gap
  }
  assert.equal((await readCursor(key)).next, 100); // 50 + 5*10
});

test('reserveItems retries once on a transient duplicate-key create race', async () => {
  // Two pulls creating the same brand-new cursor doc at the same instant: one
  // upsert wins, the other gets a transient E11000. Simulate by throwing 11000
  // on the first findOneAndUpdate, then delegating to the real one.
  const key = 'apolloPage_icp1_uk';
  const realFOU = PipelineState.findOneAndUpdate.bind(PipelineState);
  let calls = 0;
  PipelineState.findOneAndUpdate = (...args) => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      return Promise.reject(err);
    }
    return realFOU(...args);
  };
  try {
    const { start, end } = await reserveItems(key, 10);
    assert.equal(start, 0);
    assert.equal(end, 10);
    assert.ok(calls >= 2, 'should have retried after the simulated E11000');
  } finally {
    PipelineState.findOneAndUpdate = realFOU;
  }
});

test('collectBatch does not skip: a top-up resumes at the next item', async () => {
  const list = await makeList();
  const deps = { search: fakeSearchFlat(['a', 'b', 'c', 'd', 'e']), enrich: fakeEnrich };
  const first = await collectBatch(list, 3, deps);   // items 0,1,2 → a,b,c
  const next = await collectBatch(list, 2, deps);    // items 3,4 → d,e (NOT skipping any)
  assert.equal(first, 3);
  assert.equal(next, 2);
  const ids = (await Company.find({ listId: list._id }).sort('apolloAccountId')).map((c) => c.apolloAccountId);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
});

test('collectBatch is non-fatal on a duplicate-key race', async () => {
  const list = await makeList();
  // Pre-insert 'a' globally (simulates another pull winning the race).
  await Company.create({ apolloAccountId: 'a', companyName: 'Co a', listId: list._id });
  // Force the exists() dedup to miss so create() hits the unique index.
  const origExists = Company.exists.bind(Company);
  Company.exists = async () => false;
  try {
    const saved = await collectBatch(list, 2, { search: fakeSearchFlat(['a', 'b']), enrich: fakeEnrich });
    assert.equal(saved, 1); // 'a' dup-guarded, 'b' saved — no throw
  } finally {
    Company.exists = origExists;
  }
});

test('collectCompanies still saves requestedCount new companies (item model)', async () => {
  const list = await makeList(); // requestedCount 4
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c', 'd', 'e', 'f']), enrich: fakeEnrich });
  assert.equal(saved, 4);
  assert.equal(await Company.countDocuments({ listId: list._id }), 4);
  const doc = await Company.findOne({ apolloAccountId: 'a' });
  assert.equal(doc.status, 'pending');
  assert.equal(doc.sdrStatus, 'pending');
  assert.equal(doc.icpProfile, 'icp1');
});

test('collectCompanies skips companies that already exist (dedup)', async () => {
  const oldList = await makeList();
  await Company.create({ apolloAccountId: 'a', companyName: 'Co a', listId: oldList._id });
  const list = await makeList({ requestedCount: 3 });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c', 'd']), enrich: fakeEnrich });
  assert.equal(saved, 3);
  // 'a' still belongs to the old list only
  assert.equal(await Company.countDocuments({ listId: list._id }), 3);
  assert.deepEqual(
    (await Company.find({ listId: list._id }).sort('apolloAccountId')).map((c) => c.apolloAccountId),
    ['b', 'c', 'd']
  );
});

test('collectCompanies resumes from list.pulledCount instead of restarting the count', async () => {
  // Simulates a crash-and-restart mid-job: 2 companies already saved from an
  // earlier (interrupted) run of this same list.
  const list = await makeList({ requestedCount: 4, pulledCount: 2 });
  await Company.create({ apolloAccountId: 'x', companyName: 'X', listId: list._id });
  await Company.create({ apolloAccountId: 'y', companyName: 'Y', listId: list._id });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c', 'd']), enrich: fakeEnrich });
  assert.equal(saved, 4); // resumed total, not 2 (already) + 4 (fresh) = 6
  assert.equal(await Company.countDocuments({ listId: list._id }), 4);
});

test('collectCompanies stops after pool exhaustion (no infinite loop)', async () => {
  const list = await makeList({ requestedCount: 50 });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c']), enrich: fakeEnrich });
  assert.equal(saved, 3);
});

// 2026-09-09 — reproduces the benelux/icp1 false "pool exhausted" bug: the
// shared cursor has already lapped this region/profile's pool once (next
// wrapped back to position 0), and the first ~40 of 60 positions were fully
// saved on that earlier pass. A round-count budget (the old
// MAX_CONSECUTIVE_EMPTY_ROUNDS: 3, ~15 items at this k) gives up long before
// reaching the 20 genuinely fresh companies at positions 40-59. The item-count
// budget (MAX_CONSECUTIVE_EMPTY_ITEMS: 200) has enough runway to walk past
// the covered stretch and find them.
test('collectCompanies walks past an already-covered wrapped stretch instead of giving up early', async () => {
  const key = 'apolloPage_icp1_uk';
  const pool = Array.from({ length: 60 }, (_, i) => `w${i}`);

  const oldList = await makeList({ name: 'earlier pass' });
  for (let i = 0; i < 40; i++) {
    await Company.create({ apolloAccountId: `w${i}`, companyName: `Co w${i}`, listId: oldList._id });
  }
  // Cursor already lapped once: next=60 on a totalItems=60 pool wraps to
  // position 0 — right at the start of the already-covered 0-39 stretch.
  await PipelineState.create({ key, value: { next: 60, perPage: 25, totalItems: 60 } });

  const list = await makeList({ requestedCount: 5 });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(pool), enrich: fakeEnrich });
  assert.equal(saved, 5);
  const domains = (await Company.find({ listId: list._id })).map((c) => c.apolloAccountId).sort();
  for (const d of domains) assert.ok(Number(d.slice(1)) >= 40, `expected a fresh (>=40) company, got ${d}`);
});

test('collectCompanies stores no-domain companies as disqualified', async () => {
  const list = await makeList({ requestedCount: 1 });
  const noDomain = { id: 'x', name: 'Ghost Co', website_url: null, primary_domain: null };
  const saved = await collectCompanies(list, {
    search: async () => ({ organizations: [noDomain], pagination: { page: 1, totalPages: 1, totalEntries: 1 } }),
    enrich: async () => noDomain,
  });
  assert.equal(saved, 1);
  const doc = await Company.findOne({ apolloAccountId: 'x' });
  assert.equal(doc.status, 'disqualified');
  assert.match(doc.disqualifyReason, /domain/i);
});

test('runPull ends with status ready and qualifies pending companies', async () => {
  const list = await makeList({ requestedCount: 2 });
  const qualified = [];
  await runPull(list._id, {
    search: fakeSearchFlat(['a', 'b']),
    enrich: fakeEnrich,
    qualifyBatch: async (companies) => { qualified.push(...companies.map((c) => c.apolloAccountId)); },
  });
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.pulledCount, 2);
  assert.deepEqual(qualified.sort(), ['a', 'b']);
});

test('runPull marks list failed and stores error when a step throws', async () => {
  const list = await makeList();
  await runPull(list._id, {
    search: async () => { throw new Error('apollo exploded'); },
    enrich: fakeEnrich,
    qualifyBatch: async () => {},
  });
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /apollo exploded/);
});

test('logProgress caps progressLog at 50 entries', async () => {
  const list = await makeList();
  for (let i = 1; i <= 55; i++) await logProgress(list._id, `msg ${i}`);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.progressLog.length, 50);
  assert.equal(fresh.progressLog[0], 'msg 6');
  assert.equal(fresh.lastMessage, 'msg 55');
});

test('resumeStaleLists resumes pulling/qualifying lists instead of failing them', async () => {
  const stranded = await makeList({ pullMode: 'quota', requestedCount: 5, status: 'qualifying', pulledCount: 3 });
  await makeList({ status: 'ready' }); // untouched control

  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async (companies) => {
      for (const c of companies) await Company.findByIdAndUpdate(c._id, { $set: { status: 'qualified' } });
      return new Map();
    },
  };
  const { resumed } = await resumeStaleLists(deps);
  assert.equal(resumed, 1);

  // Let the fire-and-forget resumed run finish.
  await new Promise((r) => setTimeout(r, 50));

  const fresh = await List.findById(stranded._id);
  assert.equal(fresh.status, 'ready'); // resumed to completion, not left as 'failed'
  assert.equal(await List.countDocuments({ status: 'ready' }), 2);
});

test('resumeStaleLists still flips sourcing lists to failed (not resumable yet)', async () => {
  await makeList({ status: 'sourcing' });
  const { failed } = await resumeStaleLists();
  assert.ok(failed >= 1);
  assert.equal(await List.countDocuments({ status: 'sourcing' }), 0);
  assert.equal(await List.countDocuments({ status: 'failed' }), 1);
});

test('runQuotaPull: first batch is 10, tops up by (5 - qualifiedToday), stops at 5', async () => {
  // 'nordics' keeps the default 5 cap (uk is now a raised-cap region — see
  // the dedicated test below for that path).
  const list = await makeList({ pullMode: 'quota', requestedCount: 5, region: 'nordics' });
  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const reserved = [];        // record k per round
  const qualifiedByRound = [3, 1, 1]; // round outcomes → cumulative 3,4,5
  let round = 0;
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    // qualify: mark the round's new pending companies as qualified per the script
    qualify: async (companies) => {
      const n = qualifiedByRound[round] ?? 0;
      for (let i = 0; i < n && i < companies.length; i++) {
        await Company.findByIdAndUpdate(companies[i]._id, { $set: { status: 'qualified' } });
      }
      round++;
      return new Map();
    },
  };
  // Spy on collectBatch sizing via reserveItems is covered elsewhere; here assert end state.
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 5);
});

test('runQuotaPull tops up to a region\'s raised cap (uk: 7, not the default 5)', async () => {
  const list = await makeList({ pullMode: 'quota', requestedCount: 7, region: 'uk' });
  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const qualifiedByRound = [3, 2, 1, 1]; // round outcomes → cumulative 3,5,6,7
  let round = 0;
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async (companies) => {
      const n = qualifiedByRound[round] ?? 0;
      for (let i = 0; i < n && i < companies.length; i++) {
        await Company.findByIdAndUpdate(companies[i]._id, { $set: { status: 'qualified' } });
      }
      round++;
      return new Map();
    },
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 7);
});

test('runQuotaPull resumes from list.pulledCount instead of restarting the first batch', async () => {
  // Simulates a crash-and-restart mid-job: 3 companies already pulled and
  // qualified in an earlier (interrupted) run of this same list.
  const list = await makeList({ pullMode: 'quota', requestedCount: 5, pulledCount: 3, assignedTo: 'davidv@scytale.ai', region: 'nordics' });
  for (let i = 0; i < 3; i++) {
    await Company.create({ apolloAccountId: `pre${i}`, companyName: `Pre ${i}`, listId: list._id, status: 'qualified' });
  }
  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async (companies) => {
      for (const c of companies) await Company.findByIdAndUpdate(c._id, { $set: { status: 'qualified' } });
      return new Map();
    },
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 5);
  // Only 2 NEW companies pulled to top up 3 -> 5 — not a fresh 10-item first
  // batch stacked on top of the 3 that already existed.
  assert.equal(await Company.countDocuments({ listId: list._id }), 5);
});

test('runQuotaPull: respects SESSION_MAX_PULLED when nothing qualifies', async () => {
  const list = await makeList({ pullMode: 'quota', requestedCount: 5, region: 'nordics' });
  const pool = Array.from({ length: 200 }, (_, i) => `z${i}`);
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async () => new Map(), // never qualifies anyone
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.ok(fresh.pulledCount <= SESSION_MAX_PULLED, `pulled ${fresh.pulledCount}`);
  assert.ok(fresh.pulledCount >= 10, 'at least the first batch');
});

test('runQuotaPull: a single empty round does not give up early when the pool has more left', async () => {
  const list = await makeList({ pullMode: 'quota', requestedCount: 5, region: 'nordics' });
  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  // c10 is what the next 1-item top-up round would reserve — pre-existing, so
  // that round dedups to 0 saved even though c11+ are still fresh and available.
  await Company.create({ apolloAccountId: 'c10', companyName: 'Existing dup', listId: list._id, sdrStatus: 'pending' });

  let round = 0;
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async (companies) => {
      const n = round === 0 ? 4 : 1; // round 0 (batch of 10) qualifies 4; any later round qualifies 1
      // Resolve every company to a definitive verdict — nothing stays 'pending'
      // after qualification, matching the real qualifier's behavior.
      for (let i = 0; i < companies.length; i++) {
        await Company.findByIdAndUpdate(companies[i]._id, { $set: { status: i < n ? 'qualified' : 'disqualified' } });
      }
      round++;
      return new Map();
    },
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 5);
});

// 2026-09-09 — the real Katie/benelux failure, reproduced exactly: shared
// cursor already lapped this region/profile once (wraps to position 0 on a
// totalItems=60 pool), the first 40 of 60 positions were fully covered on an
// earlier pass, and quota-mode's own round sizes match what actually
// happened (10, then 5, then 5, ...). The old MAX_CONSECUTIVE_EMPTY_ROUNDS:3
// gives up after exactly those first 3 rounds (only 20 items checked) —
// before ever reaching the 20 genuinely fresh companies starting at index
// 40. The item-count budget walks past them instead.
test('runQuotaPull walks past an already-covered wrapped stretch instead of falsely reporting the pool exhausted', async () => {
  const key = 'apolloPage_icp1_nordics';
  const pool = Array.from({ length: 60 }, (_, i) => `n${i}`);

  const oldList = await makeList({ name: 'earlier pass', region: 'nordics' });
  for (let i = 0; i < 40; i++) {
    await Company.create({ apolloAccountId: `n${i}`, companyName: `Co n${i}`, listId: oldList._id });
  }
  await PipelineState.create({ key, value: { next: 60, perPage: 25, totalItems: 60 } });

  const list = await makeList({ pullMode: 'quota', requestedCount: 5, region: 'nordics' });
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async (companies) => {
      for (const c of companies) await Company.findByIdAndUpdate(c._id, { $set: { status: 'qualified' } });
      return new Map();
    },
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 5);
  assert.ok(!fresh.progressLog.some((m) => /pool exhausted/.test(m)), 'should not have given up early');
});

test('runQuotaPull still gives up (bounded, no infinite loop) once genuinely no fresh companies remain', async () => {
  const key = 'apolloPage_icp1_nordics';
  const TOTAL = 250; // comfortably past MAX_CONSECUTIVE_EMPTY_ITEMS (200)
  const pool = Array.from({ length: TOTAL }, (_, i) => `x${i}`);

  const oldList = await makeList({ name: 'fully covered', region: 'nordics' });
  for (let i = 0; i < TOTAL; i++) {
    await Company.create({ apolloAccountId: `x${i}`, companyName: `Co x${i}`, listId: oldList._id });
  }
  await PipelineState.create({ key, value: { next: TOTAL, perPage: 25, totalItems: TOTAL } });

  const list = await makeList({ pullMode: 'quota', requestedCount: 5, region: 'nordics' });
  const deps = { search: fakeSearchFlat(pool), enrich: fakeEnrich, qualify: async () => new Map() };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id }), 0);
  assert.ok(fresh.progressLog.some((m) => /pool exhausted/.test(m)), 'should have reported exhaustion');
});

test('collectBatch refreshes a stale cached totalItems instead of wrapping into already-pulled items', async () => {
  const list = await makeList();
  const key = 'apolloPage_icp1_uk';

  // First pull sees a small live pool (totalEntries 3) — caches totalItems=3.
  await collectBatch(list, 3, { search: fakeSearchFlat(['a', 'b', 'c']), enrich: fakeEnrich });
  assert.equal((await readCursor(key)).totalItems, 3);

  // Apollo's live pool later grows (e.g. a sourcing-filter broadening) to 10.
  // A later top-up must pick up the new, larger total rather than staying
  // stuck on the stale cached value — otherwise the modulo cursor wraps into
  // indices it already consumed (all dedup-skipped) and falsely reports the
  // pool as exhausted while thousands of real net-new companies remain.
  const biggerPool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  await collectBatch(list, 2, { search: fakeSearchFlat(biggerPool), enrich: fakeEnrich });
  assert.equal((await readCursor(key)).totalItems, 10);
});

test('collectCompanies skips orgs when enrich throws, continues with others', async () => {
  const list = await makeList({ requestedCount: 3 });
  // enrich throws for 'b', succeeds for others
  const enrichWithFailure = async (id) => {
    if (id === 'b') throw new Error('enrich boom');
    return fakeEnrich(id);
  };
  // Stub console.error to avoid test output noise
  const originalError = console.error;
  console.error = () => {};
  try {
    const saved = await collectCompanies(list, {
      search: fakeSearchFlat(['a', 'b', 'c', 'd']),
      enrich: enrichWithFailure,
    });
    assert.equal(saved, 3, 'should save 3 companies (a, c, d; b skipped)');
    assert.equal(await Company.countDocuments({ listId: list._id }), 3);
    const ids = (await Company.find({ listId: list._id }).sort('apolloAccountId'))
      .map((c) => c.apolloAccountId);
    assert.deepEqual(ids, ['a', 'c', 'd'], 'should save a, c, d but not b');
    assert.equal(await Company.countDocuments({ apolloAccountId: 'b', listId: list._id }), 0);
  } finally {
    console.error = originalError;
  }
});
