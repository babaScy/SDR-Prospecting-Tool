const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const List = require('../src/models/List');
const pullService = require('../src/services/pullService');
const app = require('../src/app');

// Don't let the route fire a real pull during tests.
const runPullCalls = [];
pullService.runPull = async (listId) => { runPullCalls.push(String(listId)); };

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); runPullCalls.length = 0; });

test('POST /api/pull creates a list and fires runPull', async () => {
  const res = await request(app).post('/api/pull').send({ profile: 'icp1', region: 'uk', count: 25 });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pulling');
  assert.equal(res.body.requestedCount, 25);
  assert.match(res.body.name, /UK · ICP1 · /);
  assert.deepEqual(runPullCalls, [res.body._id]);
});

test('POST /api/pull validates profile, region, count', async () => {
  const bad = [
    { profile: 'icp9', region: 'uk', count: 10 },
    { profile: 'icp1', region: 'mars', count: 10 },
    { profile: 'icp1', region: 'uk', count: 0 },
    { profile: 'icp1', region: 'uk', count: 201 },
    { profile: 'icp1', region: 'uk', count: 1.5 },
  ];
  for (const body of bad) {
    const res = await request(app).post('/api/pull').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(runPullCalls.length, 0);
});

test('POST /api/pull returns 409 while a pull is running', async () => {
  await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, status: 'qualifying' });
  const res = await request(app).post('/api/pull').send({ profile: 'icp1', region: 'uk', count: 10 });
  assert.equal(res.status, 409);
  assert.equal(runPullCalls.length, 0);
});

test('POST /api/pull serializes concurrent requests (TOCTOU race)', async () => {
  const body = { profile: 'icp1', region: 'uk', count: 10 };
  const [resA, resB] = await Promise.all([
    request(app).post('/api/pull').send(body),
    request(app).post('/api/pull').send(body),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(runPullCalls.length, 1);

  // Latch must release after the guarded section completes, allowing a
  // subsequent request through once the running pull is cleared.
  await List.deleteMany({});
  const resC = await request(app).post('/api/pull').send(body);
  assert.equal(resC.status, 201);
});
