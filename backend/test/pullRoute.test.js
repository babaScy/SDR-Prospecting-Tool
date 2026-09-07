const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const List = require('../src/models/List');
const pullService = require('../src/services/pullService');
const app = require('../src/app');

// Don't let the route fire a real pull during tests.
const runPullCalls = [];
pullService.runPull = async (listId) => { runPullCalls.push(String(listId)); };

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); runPullCalls.length = 0; });

const admin = (req) => req.set('Cookie', sessionCookie('yonia@scytale.ai'));
const asSdr = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));

test('POST /api/pull creates a list and fires runPull', async () => {
  const res = await admin(request(app).post('/api/pull')).send({ profile: 'icp1', region: 'uk', count: 25, assignedTo: 'davidv@scytale.ai' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pulling');
  assert.equal(res.body.requestedCount, 25);
  assert.equal(res.body.assignedTo, 'davidv@scytale.ai');
  assert.match(res.body.name, /UK · ICP1 · /);
  assert.deepEqual(runPullCalls, [res.body._id]);
});

// davidv's regions are ['dach', 'uk'] per the roster.
test('SDR can pull their own region (region+profile only)', async () => {
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 201);
  assert.equal(res.body.assignedTo, 'davidv@scytale.ai');
  assert.equal(res.body.pullMode, 'quota');
  assert.equal(runPullCalls.length, 1);
});

test('SDR pull ignores body assignedTo/count and forces self', async () => {
  const res = await asSdr(request(app).post('/api/pull'))
    .send({ region: 'uk', profile: 'icp1', assignedTo: 'khadym@scytale.ai', count: 999 });
  assert.equal(res.status, 201);
  assert.equal(res.body.assignedTo, 'davidv@scytale.ai');
});

test('SDR cannot pull a region they do not cover', async () => {
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'aus', profile: 'icp1' });
  assert.equal(res.status, 403);
  assert.equal(runPullCalls.length, 0);
});

test('SDR pull is blocked at the daily quota (429)', async () => {
  // uk's raised cap is 7 (see REGION_DAILY_CAPS) — seed exactly that many.
  const list = await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 7, assignedTo: 'davidv@scytale.ai', status: 'ready' });
  const Company = require('../src/models/Company');
  for (let i = 0; i < 7; i++) {
    await Company.create({ apolloAccountId: `q${i}`, companyName: `q${i}`, listId: list._id, status: 'qualified' });
  }
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 429);
  assert.equal(runPullCalls.length, 0);
});

test('SDR pull is not blocked below a raised region cap (6 qualified in uk, cap is 7)', async () => {
  const list = await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 7, assignedTo: 'davidv@scytale.ai', status: 'ready' });
  const Company = require('../src/models/Company');
  for (let i = 0; i < 6; i++) {
    await Company.create({ apolloAccountId: `q${i}`, companyName: `q${i}`, listId: list._id, status: 'qualified' });
  }
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 201);
});

test('SDR pull is blocked once they already have a self-serve list today, even under quota (429)', async () => {
  // Simulates the pool-exhaustion edge case: a quota-mode list that ended
  // short of the daily quota should still count as "today's pull".
  await List.create({
    name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5,
    assignedTo: 'davidv@scytale.ai', pullMode: 'quota', status: 'ready',
  });
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 429);
  assert.equal(runPullCalls.length, 0);
});

test('an admin-assigned (fixed) pull today does not block the SDR\'s own self-serve pull', async () => {
  await List.create({
    name: 'x', profile: 'icp1', region: 'uk', requestedCount: 25,
    assignedTo: 'davidv@scytale.ai', pullMode: 'fixed', status: 'ready',
  });
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 201);
});

test('POST /api/pull accepts icp3 profile and taiwan region', async () => {
  const res = await admin(request(app).post('/api/pull')).send({ profile: 'icp3', region: 'taiwan', count: 10, assignedTo: 'davidv@scytale.ai' });
  assert.equal(res.status, 201);
  assert.match(res.body.name, /TAIWAN · ICP3 · /);
});

// davidv's regions are ['dach', 'uk'] — both raised-cap regions, so the
// default (no ?region=) resolves to the first, 'dach', at cap 7.
test('GET /api/pull/quota returns the SDR count, defaulting to their first region', async () => {
  const res = await asSdr(request(app).get('/api/pull/quota'));
  assert.equal(res.status, 200);
  assert.equal(res.body.quota, 7);
  assert.equal(res.body.qualifiedToday, 0);
  assert.equal(res.body.pulledToday, false);
});

test('GET /api/pull/quota?region= returns that region\'s cap', async () => {
  const res = await asSdr(request(app).get('/api/pull/quota?region=uk'));
  assert.equal(res.status, 200);
  assert.equal(res.body.quota, 7);
});

test('GET /api/pull/quota rejects a region the SDR does not cover', async () => {
  const res = await asSdr(request(app).get('/api/pull/quota?region=aus'));
  assert.equal(res.status, 400);
});

test('POST /api/pull validates profile, region, count, assignedTo', async () => {
  const bad = [
    { profile: 'icp9', region: 'uk', count: 10, assignedTo: 'davidv@scytale.ai' },
    { profile: 'icp1', region: 'mars', count: 10, assignedTo: 'davidv@scytale.ai' },
    { profile: 'icp1', region: 'uk', count: 0, assignedTo: 'davidv@scytale.ai' },
    { profile: 'icp1', region: 'uk', count: 201, assignedTo: 'davidv@scytale.ai' },
    { profile: 'icp1', region: 'uk', count: 1.5, assignedTo: 'davidv@scytale.ai' },
    { profile: 'icp1', region: 'uk', count: 10 }, // missing assignedTo
    { profile: 'icp1', region: 'uk', count: 10, assignedTo: 'yonia@scytale.ai' }, // admin, not an SDR
    { profile: 'icp1', region: 'uk', count: 10, assignedTo: 'nobody@scytale.ai' },
  ];
  for (const body of bad) {
    const res = await admin(request(app).post('/api/pull')).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(runPullCalls.length, 0);
});

test('POST /api/pull returns 409 while a pull is running', async () => {
  await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai', status: 'qualifying' });
  const res = await admin(request(app).post('/api/pull')).send({ profile: 'icp1', region: 'uk', count: 10, assignedTo: 'davidv@scytale.ai' });
  assert.equal(res.status, 409);
  assert.equal(runPullCalls.length, 0);
});

test('POST /api/pull serializes concurrent requests (TOCTOU race)', async () => {
  const body = { profile: 'icp1', region: 'uk', count: 10, assignedTo: 'davidv@scytale.ai' };
  const [resA, resB] = await Promise.all([
    admin(request(app).post('/api/pull')).send(body),
    admin(request(app).post('/api/pull')).send(body),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(runPullCalls.length, 1);

  // Latch must release after the guarded section completes, allowing a
  // subsequent request through once the running pull is cleared.
  await List.deleteMany({});
  const resC = await admin(request(app).post('/api/pull')).send(body);
  assert.equal(resC.status, 201);
});
