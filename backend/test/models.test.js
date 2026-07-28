const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

test('GET /api/health returns ok', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('Company defaults: status pending, sdrStatus pending', async () => {
  const list = await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai' });
  const company = await Company.create({
    apolloAccountId: 'a1',
    companyName: 'Acme',
    listId: list._id,
  });
  assert.equal(company.status, 'pending');
  assert.equal(company.sdrStatus, 'pending');
});

test('List rejects invalid status', async () => {
  await assert.rejects(
    List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai', status: 'bogus' }),
    /validation/i
  );
});

test('Company requires listId', async () => {
  await assert.rejects(
    Company.create({ apolloAccountId: 'a2', companyName: 'NoList' }),
    /listId/
  );
});

test('List.pullMode defaults to fixed and accepts quota', async () => {
  const List = require('../src/models/List');
  const a = await List.create({ name: 'a', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai' });
  assert.equal(a.pullMode, 'fixed');
  const b = await List.create({ name: 'b', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai', pullMode: 'quota' });
  assert.equal(b.pullMode, 'quota');
});

test('Contact model persists ranked contact fields', async () => {
  const Contact = require('../src/models/Contact');
  const mongoose = require('mongoose');
  const companyId = new mongoose.Types.ObjectId();
  const listId = new mongoose.Types.ObjectId();
  const c = await Contact.create({
    companyId, listId, apolloPersonId: 'p1', firstName: 'Ada', lastName: 'Lovelace',
    title: 'CTO', email: 'ada@acme.com', rank: 1, isPrimary: true, reasoning: 'owns eng',
  });
  assert.equal(c.rank, 1);
  assert.equal(c.isPrimary, true);
  assert.equal(c.email, 'ada@acme.com');
});

test('Company.contactStatus defaults to pending and accepts the enum', async () => {
  const mongoose = require('mongoose');
  const c = await Company.create({ apolloAccountId: 'x-cs', companyName: 'X', listId: new mongoose.Types.ObjectId() });
  assert.equal(c.contactStatus, 'pending');
  c.contactStatus = 'sourcing'; await c.save(); assert.equal(c.contactStatus, 'sourcing');
});

test('List accepts sourcing/sourced status and reviewConfirmedAt', async () => {
  const l = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  assert.equal(l.status, 'sourcing');
  const when = new Date();
  l.status = 'sourced'; l.reviewConfirmedAt = when; await l.save();
  assert.equal(l.status, 'sourced');
  assert.equal(l.reviewConfirmedAt.getTime(), when.getTime());
});
