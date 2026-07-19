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
  const list = await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5 });
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
    List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, status: 'bogus' }),
    /validation/i
  );
});

test('Company requires listId', async () => {
  await assert.rejects(
    Company.create({ apolloAccountId: 'a2', companyName: 'NoList' }),
    /listId/
  );
});
