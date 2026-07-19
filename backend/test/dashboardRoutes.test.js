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

async function seedList() {
  const list = await List.create({ name: 'UK · ICP1 · 19 Jul', profile: 'icp1', region: 'uk', requestedCount: 3, pulledCount: 3, status: 'ready' });
  const mk = (id, status, extra = {}) =>
    Company.create({
      apolloAccountId: id, companyName: `Co ${id}`, website: `https://${id}.com`,
      listId: list._id, status, qualification: { icp: 'Yes', reasoning: `reason ${id}` }, ...extra,
    });
  const a = await mk('a', 'qualified', { tier: 'A' });
  const b = await mk('b', 'nei');
  const c = await mk('c', 'disqualified');
  return { list, a, b, c };
}

test('GET /api/lists returns lists with counts, newest first', async () => {
  await seedList();
  const res = await request(app).get('/api/lists');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  const counts = res.body[0].counts;
  assert.equal(counts.total, 3);
  assert.equal(counts.qualified, 1);
  assert.equal(counts.nei, 1);
  assert.equal(counts.disqualified, 1);
  assert.equal(counts.pendingSdr, 3);
});

test('GET /api/lists/:id returns one list with counts; 404 on unknown', async () => {
  const { list } = await seedList();
  const res = await request(app).get(`/api/lists/${list._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.total, 3);
  const missing = await request(app).get('/api/lists/64b000000000000000000000');
  assert.equal(missing.status, 404);
});

test('GET /api/lists/:id/leads filters by bucket and validates', async () => {
  const { list } = await seedList();
  const res = await request(app).get(`/api/lists/${list._id}/leads?bucket=qualified`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].apolloAccountId, 'a');
  assert.equal(res.body[0].qualification.reasoning, 'reason a');
  const bad = await request(app).get(`/api/lists/${list._id}/leads?bucket=everything`);
  assert.equal(bad.status, 400);
});

test('POST /api/leads/:id/decision records decision and flips list to reviewed', async () => {
  const { list, a, b, c } = await seedList();
  for (const [lead, decision] of [[a, 'accepted'], [b, 'rejected'], [c, 'rejected']]) {
    const res = await request(app).post(`/api/leads/${lead._id}/decision`).send({ decision });
    assert.equal(res.status, 200);
    assert.equal(res.body.sdrStatus, decision);
    assert.ok(res.body.sdrReviewedAt);
  }
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'reviewed');
});

test('decision undo (pending) reopens the list', async () => {
  const { list, a, b, c } = await seedList();
  for (const lead of [a, b, c]) {
    await request(app).post(`/api/leads/${lead._id}/decision`).send({ decision: 'accepted' });
  }
  const res = await request(app).post(`/api/leads/${a._id}/decision`).send({ decision: 'pending' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sdrStatus, 'pending');
  assert.equal(res.body.sdrReviewedAt, null);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
});

test('decision validates input and 404s on unknown lead', async () => {
  const { a } = await seedList();
  const bad = await request(app).post(`/api/leads/${a._id}/decision`).send({ decision: 'maybe' });
  assert.equal(bad.status, 400);
  const missing = await request(app).post('/api/leads/64b000000000000000000000/decision').send({ decision: 'accepted' });
  assert.equal(missing.status, 404);
  const badId = await request(app).post('/api/leads/not-an-id/decision').send({ decision: 'accepted' });
  assert.equal(badId.status, 404);
});
