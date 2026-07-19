const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const PipelineState = require('../src/models/PipelineState');
const { runPull, collectCompanies, logProgress, markStaleListsFailed } =
  require('../src/services/pullService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

// Fake Apollo: 2 pages of 3 orgs each, 6 total.
const org = (id) => ({ id, name: `Co ${id}`, website_url: `https://${id}.com`, primary_domain: `${id}.com` });
const fakeSearch = (pages) => async (profile, region, page) => ({
  organizations: pages[page - 1] || [],
  pagination: { page, totalPages: pages.length, totalEntries: pages.flat().length },
});
const fakeEnrich = async (id) => ({ ...org(id), industry: 'software' });

const makeList = (overrides = {}) =>
  List.create({ name: 't', profile: 'icp1', region: 'uk', requestedCount: 4, ...overrides });

test('collectCompanies saves requestedCount new companies and stops', async () => {
  const list = await makeList();
  const pages = [[org('a'), org('b'), org('c')], [org('d'), org('e'), org('f')]];
  const saved = await collectCompanies(list, { search: fakeSearch(pages), enrich: fakeEnrich });
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
  const pages = [[org('a'), org('b'), org('c')], [org('d')]];
  const saved = await collectCompanies(list, { search: fakeSearch(pages), enrich: fakeEnrich });
  assert.equal(saved, 3);
  // 'a' still belongs to the old list only
  assert.equal(await Company.countDocuments({ listId: list._id }), 3);
  assert.deepEqual(
    (await Company.find({ listId: list._id }).sort('apolloAccountId')).map((c) => c.apolloAccountId),
    ['b', 'c', 'd']
  );
});

test('collectCompanies stops after a full page wrap when not enough new leads exist', async () => {
  const list = await makeList({ requestedCount: 50 });
  const pages = [[org('a'), org('b')], [org('c')]];
  const saved = await collectCompanies(list, { search: fakeSearch(pages), enrich: fakeEnrich });
  assert.equal(saved, 3); // visited both pages once, then stopped — no infinite loop
});

test('collectCompanies stores no-domain companies as disqualified', async () => {
  const list = await makeList({ requestedCount: 1 });
  const noDomain = { id: 'x', name: 'Ghost Co', website_url: null, primary_domain: null };
  const saved = await collectCompanies(list, {
    search: async () => ({ organizations: [noDomain], pagination: { page: 1, totalPages: 1 } }),
    enrich: async () => noDomain,
  });
  assert.equal(saved, 1);
  const doc = await Company.findOne({ apolloAccountId: 'x' });
  assert.equal(doc.status, 'disqualified');
  assert.match(doc.disqualifyReason, /domain/i);
});

test('collectCompanies advances and wraps the page cursor', async () => {
  const list = await makeList({ requestedCount: 50 });
  const pages = [[org('a')], [org('b')]];
  await collectCompanies(list, { search: fakeSearch(pages), enrich: fakeEnrich });
  const state = await PipelineState.findOne({ key: 'apolloPage_icp1_uk' });
  assert.equal(state.value, 1); // wrapped back after last page
});

test('runPull ends with status ready and qualifies pending companies', async () => {
  const list = await makeList({ requestedCount: 2 });
  const pages = [[org('a'), org('b')]];
  const qualified = [];
  await runPull(list._id, {
    search: fakeSearch(pages),
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
