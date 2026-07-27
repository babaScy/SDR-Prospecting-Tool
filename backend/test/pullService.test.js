const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const PipelineState = require('../src/models/PipelineState');
const { runPull, collectCompanies, collectBatch, reserveItems, readCursor, logProgress, markStaleListsFailed } =
  require('../src/services/pullService');

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

test('collectCompanies stops after pool exhaustion (no infinite loop)', async () => {
  const list = await makeList({ requestedCount: 50 });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c']), enrich: fakeEnrich });
  assert.equal(saved, 3);
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

test('markStaleListsFailed flips pulling/qualifying lists to failed', async () => {
  await makeList({ status: 'pulling' });
  await makeList({ status: 'qualifying' });
  await makeList({ status: 'ready' });
  const n = await markStaleListsFailed();
  assert.equal(n, 2);
  assert.equal(await List.countDocuments({ status: 'failed' }), 2);
  assert.equal(await List.countDocuments({ status: 'ready' }), 1);
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
