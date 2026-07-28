const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const { sourceList } = require('../src/services/contactService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

async function seedList() {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 2, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const accepted = await Company.create({ apolloAccountId: 'acc-1', companyName: 'Acme', website: 'https://acme.com', listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'sourcing' });
  const rejected = await Company.create({ apolloAccountId: 'acc-2', companyName: 'Nope', website: 'https://nope.com', listId: list._id, status: 'qualified', sdrStatus: 'rejected' });
  return { list, accepted, rejected };
}

const deps = {
  search: async () => [{ id: 'p1', title: 'CTO' }, { id: 'p2', title: 'CEO' }],
  bulkMatch: async (items) => new Map(items.map((it) => [it.person.id, { id: it.person.id, first_name: 'F', last_name: 'L', title: 'CTO', email: `${it.person.id}@acme.com`, linkedin_url: 'u' }])),
  pick: async (enriched) => enriched.slice(0, 2).map((p, i) => ({ person: p, rank: i + 1, isPrimary: i === 0, reasoning: 'r' })),
};

test('sourceList sources only accepted companies and saves ranked contacts', async () => {
  const { list, accepted, rejected } = await seedList();
  await sourceList(list._id, deps);

  const contacts = await Contact.find({ companyId: accepted._id }).sort('rank');
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].isPrimary, true);
  assert.equal(contacts[0].rank, 1);
  assert.equal(await Contact.countDocuments({ companyId: rejected._id }), 0); // rejected never sourced

  const freshAccepted = await Company.findById(accepted._id);
  assert.equal(freshAccepted.contactStatus, 'found');
  const freshList = await List.findById(list._id);
  assert.equal(freshList.status, 'sourced');
});

test('sourceList sets contactStatus none when no viable contact', async () => {
  const { list, accepted } = await seedList();
  await sourceList(list._id, { ...deps, pick: async () => [] });
  const fresh = await Company.findById(accepted._id);
  assert.equal(fresh.contactStatus, 'none');
  assert.equal(await Contact.countDocuments({ companyId: accepted._id }), 0);
});

test('sourceList sets none when the company has no domain', async () => {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const c = await Company.create({ apolloAccountId: 'nd', companyName: 'NoWeb', website: '', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  await sourceList(list._id, deps);
  const fresh = await Company.findById(c._id);
  assert.equal(fresh.contactStatus, 'none');
});

test('sourceList marks the list failed on a thrown error', async () => {
  const { list } = await seedList();
  await sourceList(list._id, { ...deps, search: async () => { throw new Error('apollo people down'); } });
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /apollo people down/);
});

test('sourceList isolates a per-company failure and finishes the rest', async () => {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 2, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const bad = await Company.create({ apolloAccountId: 'bad', companyName: 'AAA Bad', website: 'https://bad.com', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const good = await Company.create({ apolloAccountId: 'good', companyName: 'ZZZ Good', website: 'https://good.com', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });

  const failing = {
    ...deps,
    search: async (domain) => {
      if (domain === 'bad.com') throw new Error('boom on this one company');
      return [{ id: 'p1', title: 'CTO' }];
    },
  };
  await sourceList(list._id, failing);

  const freshList = await List.findById(list._id);
  assert.equal(freshList.status, 'sourced');            // list still completes
  assert.equal((await Company.findById(bad._id)).contactStatus, 'none');   // bad one marked, not stranded
  assert.equal((await Company.findById(good._id)).contactStatus, 'found'); // good one still sourced
  assert.equal(await Contact.countDocuments({ companyId: good._id }), 1);
});

test('sourceList survives a duplicate person id from the picker', async () => {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const c = await Company.create({ apolloAccountId: 'd', companyName: 'Dup', website: 'https://dup.com', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const dupPick = {
    ...deps,
    pick: async (enriched) => [
      { person: enriched[0], rank: 1, isPrimary: true, reasoning: 'a' },
      { person: enriched[0], rank: 2, isPrimary: false, reasoning: 'b' }, // same person twice
    ],
  };
  await sourceList(list._id, dupPick);
  assert.equal((await List.findById(list._id)).status, 'sourced');
  assert.equal(await Contact.countDocuments({ companyId: c._id }), 1);
  assert.equal((await Company.findById(c._id)).contactStatus, 'found');
});
