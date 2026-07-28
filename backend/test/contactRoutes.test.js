const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const contactService = require('../src/services/contactService');
const app = require('../src/app');

// Don't fire real sourcing.
const sourceCalls = [];
contactService.sourceList = async (listId) => { sourceCalls.push(String(listId)); };

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); sourceCalls.length = 0; });

const asDavid = (req) => req.set('X-User-Email', 'davidv@scytale.ai');
const asKhadym = (req) => req.set('X-User-Email', 'khadym@scytale.ai');

const makeReviewed = async (over = {}) =>
  List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 2, assignedTo: 'davidv@scytale.ai', status: 'reviewed', ...over });

test('confirm-review on a reviewed list with accepted → sourcing + fires job', async () => {
  const list = await makeReviewed();
  await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sourcing');
  assert.ok(res.body.reviewConfirmedAt);
  assert.deepEqual(sourceCalls, [String(list._id)]);
});

test('confirm-review with zero accepted → sourced immediately, no job', async () => {
  const list = await makeReviewed();
  await Company.create({ apolloAccountId: 'r1', companyName: 'No', listId: list._id, status: 'qualified', sdrStatus: 'rejected' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sourced');
  assert.equal(sourceCalls.length, 0);
});

test('confirm-review rejects a not-fully-reviewed list (409)', async () => {
  const list = await makeReviewed({ status: 'ready' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 409);
});

test('confirm-review 403 for a non-owning SDR', async () => {
  const list = await makeReviewed();
  const res = await asKhadym(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 403);
});

test('decision is locked (409) once review is confirmed', async () => {
  const list = await makeReviewed({ status: 'sourcing', reviewConfirmedAt: new Date() });
  const c = await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const res = await asDavid(request(app).post(`/api/leads/${c._id}/decision`)).send({ decision: 'rejected' });
  assert.equal(res.status, 409);
});

test('GET contacts returns accepted companies with ranked contacts', async () => {
  const list = await makeReviewed({ status: 'sourced', reviewConfirmedAt: new Date() });
  const acc = await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'found' });
  await Contact.create({ companyId: acc._id, listId: list._id, apolloPersonId: 'p2', firstName: 'B', title: 'CEO', rank: 2 });
  await Contact.create({ companyId: acc._id, listId: list._id, apolloPersonId: 'p1', firstName: 'A', title: 'CTO', rank: 1, isPrimary: true });
  const res = await asDavid(request(app).get(`/api/lists/${list._id}/contacts`));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].contacts[0].rank, 1); // sorted by rank
  assert.equal(res.body[0].contacts.length, 2);
});
