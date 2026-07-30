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

test('GET /api/settings/qualification-mode defaults to batch, any signed-in user', async () => {
  const res = await asSdr(request(app).get('/api/settings/qualification-mode'));
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'batch');
});

test('PUT /api/settings/qualification-mode is admin-only', async () => {
  const res = await asSdr(request(app).put('/api/settings/qualification-mode')).send({ mode: 'single' });
  assert.equal(res.status, 403);
});

test('PUT /api/settings/qualification-mode updates the global mode as admin', async () => {
  const put = await admin(request(app).put('/api/settings/qualification-mode')).send({ mode: 'single' });
  assert.equal(put.status, 200);
  assert.equal(put.body.mode, 'single');

  const get = await asSdr(request(app).get('/api/settings/qualification-mode'));
  assert.equal(get.body.mode, 'single');
});

test('PUT /api/settings/qualification-mode rejects an invalid mode', async () => {
  const res = await admin(request(app).put('/api/settings/qualification-mode')).send({ mode: 'bogus' });
  assert.equal(res.status, 400);
});
