const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const admin = (req) => req.set('Cookie', sessionCookie('yonia@scytale.ai'));
const asSdr = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));

const sampleEvent = (overrides = {}) => ({
  id: 'evt_test_1',
  sourceId: 'test-source',
  tier: 'primary',
  sourceUrl: 'https://example.com/a',
  fetchedAt: '2026-09-01T00:00:00.000Z',
  changeType: 'new-deadline',
  frameworks: ['gdpr'],
  regions: ['eu'],
  whatsHappening: 'Something happened.',
  talkingPoint: 'Here is the pitch.',
  outreachWorthy: true,
  whoToTarget: 'EU companies.',
  confidence: 'high',
  ...overrides,
});

test('GET /api/intel is empty with nothing synced yet, any signed-in user', async () => {
  const res = await asSdr(request(app).get('/api/intel'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/intel/sync is admin-only', async () => {
  const res = await asSdr(request(app).post('/api/intel/sync')).send({ events: [sampleEvent()] });
  assert.equal(res.status, 403);
});

test('POST /api/intel/sync stores events, visible on GET /api/intel', async () => {
  const sync = await admin(request(app).post('/api/intel/sync')).send({ events: [sampleEvent()] });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.upserted, 1);
  assert.equal(sync.body.total, 1);

  const get = await asSdr(request(app).get('/api/intel'));
  assert.equal(get.status, 200);
  assert.equal(get.body.length, 1);
  assert.equal(get.body[0].id, 'evt_test_1');
  assert.equal(get.body[0].sourceId, 'test-source');
  assert.deepEqual(get.body[0].frameworks, ['gdpr']);
});

test('POST /api/intel/sync upserts on re-sync — same id updates rather than duplicates', async () => {
  await admin(request(app).post('/api/intel/sync')).send({ events: [sampleEvent()] });
  const resync = await admin(request(app).post('/api/intel/sync')).send({
    events: [sampleEvent({ whatsHappening: 'Updated text.' })],
  });
  assert.equal(resync.status, 200);
  assert.equal(resync.body.total, 1);

  const get = await asSdr(request(app).get('/api/intel'));
  assert.equal(get.body.length, 1);
  assert.equal(get.body[0].whatsHappening, 'Updated text.');
});

test('POST /api/intel/sync rejects a non-array events field', async () => {
  const res = await admin(request(app).post('/api/intel/sync')).send({ events: 'nope' });
  assert.equal(res.status, 400);
});

test('POST /api/intel/sync rejects an empty events array', async () => {
  const res = await admin(request(app).post('/api/intel/sync')).send({ events: [] });
  assert.equal(res.status, 400);
});

test('POST /api/intel/sync rejects an event missing required fields', async () => {
  const res = await admin(request(app).post('/api/intel/sync')).send({ events: [{ id: 'evt_bad' }] });
  assert.equal(res.status, 400);
});

test('POST /api/intel/sync rejects an event with an invalid tier', async () => {
  const res = await admin(request(app).post('/api/intel/sync')).send({
    events: [sampleEvent({ tier: 'bogus' })],
  });
  assert.equal(res.status, 400);
});

test('POST /api/intel/sync accepts a payload bigger than Express\'s 100kb JSON default', async () => {
  // A real framework-intel events.json sync is already >100kb and grows every
  // pipeline run — this is the exact shape that motivated raising the limit.
  const events = Array.from({ length: 400 }, (_, i) => sampleEvent({ id: `evt_bulk_${i}` }));
  const res = await admin(request(app).post('/api/intel/sync')).send({ events });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 400);
});

test('GET /api/intel sorts most-recent fetchedAt first', async () => {
  await admin(request(app).post('/api/intel/sync')).send({
    events: [
      sampleEvent({ id: 'evt_old', fetchedAt: '2026-08-01T00:00:00.000Z' }),
      sampleEvent({ id: 'evt_new', fetchedAt: '2026-09-01T00:00:00.000Z' }),
    ],
  });
  const res = await asSdr(request(app).get('/api/intel'));
  assert.deepEqual(res.body.map((e) => e.id), ['evt_new', 'evt_old']);
});
