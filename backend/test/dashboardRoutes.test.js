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

const admin = (req) => req.set('X-User-Email', 'yonia@scytale.ai');
const asSdr = (req) => req.set('X-User-Email', 'davidv@scytale.ai');
const asOtherSdr = (req) => req.set('X-User-Email', 'khadym@scytale.ai');

async function seedList(assignedTo = 'davidv@scytale.ai', idPrefix = '') {
  const list = await List.create({ name: 'UK · ICP1 · 19 Jul', profile: 'icp1', region: 'uk', requestedCount: 3, pulledCount: 3, assignedTo, status: 'ready' });
  const mk = (id, status, extra = {}) =>
    Company.create({
      apolloAccountId: `${idPrefix}${id}`, companyName: `Co ${id}`, website: `https://${idPrefix}${id}.com`,
      listId: list._id, status, qualification: { icp: 'Yes', reasoning: `reason ${id}` }, ...extra,
    });
  const a = await mk('a', 'qualified');
  const b = await mk('b', 'nei');
  const c = await mk('c', 'disqualified');
  return { list, a, b, c };
}

test('requests without a recognized X-User-Email are rejected', async () => {
  await seedList();
  const noHeader = await request(app).get('/api/lists');
  assert.equal(noHeader.status, 401);
  const unknown = await request(app).get('/api/lists').set('X-User-Email', 'nobody@scytale.ai');
  assert.equal(unknown.status, 401);
});

test('GET /api/lists returns lists with counts, newest first', async () => {
  await seedList();
  const res = await admin(request(app).get('/api/lists'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  const counts = res.body[0].counts;
  assert.equal(counts.total, 3);
  assert.equal(counts.qualified, 1);
  assert.equal(counts.nei, 1);
  assert.equal(counts.disqualified, 1);
  assert.equal(counts.pendingSdr, 3);
});

test('GET /api/lists scopes SDRs to their own lists; admin sees all', async () => {
  await seedList('davidv@scytale.ai', 'x1-');
  await seedList('khadym@scytale.ai', 'x2-');

  const asDavid = await asSdr(request(app).get('/api/lists'));
  assert.equal(asDavid.status, 200);
  assert.equal(asDavid.body.length, 1);
  assert.equal(asDavid.body[0].assignedTo, 'davidv@scytale.ai');

  const asAdmin = await admin(request(app).get('/api/lists'));
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.body.length, 2);
});

test('GET /api/lists/:id returns one list with counts; 404 on unknown; 403 for a non-owning SDR', async () => {
  const { list } = await seedList('davidv@scytale.ai');
  const res = await admin(request(app).get(`/api/lists/${list._id}`));
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.total, 3);
  const missing = await admin(request(app).get('/api/lists/64b000000000000000000000'));
  assert.equal(missing.status, 404);
  const forbidden = await asOtherSdr(request(app).get(`/api/lists/${list._id}`));
  assert.equal(forbidden.status, 403);
  const allowed = await asSdr(request(app).get(`/api/lists/${list._id}`));
  assert.equal(allowed.status, 200);
});

test('GET /api/lists/:id/leads filters by bucket and validates; 403 for a non-owning SDR', async () => {
  const { list } = await seedList('davidv@scytale.ai');
  const res = await admin(request(app).get(`/api/lists/${list._id}/leads?bucket=qualified`));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].apolloAccountId, 'a');
  assert.equal(res.body[0].qualification.reasoning, 'reason a');
  const bad = await admin(request(app).get(`/api/lists/${list._id}/leads?bucket=everything`));
  assert.equal(bad.status, 400);
  const forbidden = await asOtherSdr(request(app).get(`/api/lists/${list._id}/leads?bucket=qualified`));
  assert.equal(forbidden.status, 403);
});

test('GET /api/lists/:id/leads with no bucket returns all companies', async () => {
  const { list } = await seedList();
  const res = await admin(request(app).get(`/api/lists/${list._id}/leads`));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
  const ids = res.body.map((c) => c.apolloAccountId).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('POST /api/leads/:id/decision records decision and flips list to reviewed', async () => {
  const { list, a, b, c } = await seedList('davidv@scytale.ai');
  for (const [lead, decision] of [[a, 'accepted'], [b, 'rejected'], [c, 'rejected']]) {
    const res = await asSdr(request(app).post(`/api/leads/${lead._id}/decision`)).send({ decision });
    assert.equal(res.status, 200);
    assert.equal(res.body.sdrStatus, decision);
    assert.ok(res.body.sdrReviewedAt);
  }
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'reviewed');
});

test('POST /api/leads/:id/decision is 403 for a non-owning SDR, allowed for admin', async () => {
  const { a } = await seedList('davidv@scytale.ai');
  const forbidden = await asOtherSdr(request(app).post(`/api/leads/${a._id}/decision`)).send({ decision: 'accepted' });
  assert.equal(forbidden.status, 403);
  const allowed = await admin(request(app).post(`/api/leads/${a._id}/decision`)).send({ decision: 'accepted' });
  assert.equal(allowed.status, 200);
});

test('decision undo (pending) reopens the list', async () => {
  const { list, a, b, c } = await seedList('davidv@scytale.ai');
  for (const lead of [a, b, c]) {
    await asSdr(request(app).post(`/api/leads/${lead._id}/decision`)).send({ decision: 'accepted' });
  }
  const res = await asSdr(request(app).post(`/api/leads/${a._id}/decision`)).send({ decision: 'pending' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sdrStatus, 'pending');
  assert.equal(res.body.sdrReviewedAt, null);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
});

test('decision validates input and 404s on unknown lead', async () => {
  const { a } = await seedList('davidv@scytale.ai');
  const bad = await asSdr(request(app).post(`/api/leads/${a._id}/decision`)).send({ decision: 'maybe' });
  assert.equal(bad.status, 400);
  const missing = await admin(request(app).post('/api/leads/64b000000000000000000000/decision')).send({ decision: 'accepted' });
  assert.equal(missing.status, 404);
  const badId = await admin(request(app).post('/api/leads/not-an-id/decision')).send({ decision: 'accepted' });
  assert.equal(badId.status, 404);
});
