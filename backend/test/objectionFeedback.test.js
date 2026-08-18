const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const ObjectionFeedback = require('../src/models/ObjectionFeedback');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const asSdr = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));

test('POST /api/objection-feedback creates an entry with the session email as author', async () => {
  const res = await asSdr(request(app).post('/api/objection-feedback')).send({
    objection: 'Not Interested',
    text: 'Response 2 lands better with a pause',
    authorEmail: 'someone-else@scytale.ai', // must be ignored — the route derives it from the session
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.objection, 'Not Interested');
  assert.equal(res.body.text, 'Response 2 lands better with a pause');
  assert.equal(res.body.authorEmail, 'davidv@scytale.ai');
});

test('POST /api/objection-feedback trims text and 400s on missing objection or empty text', async () => {
  const trimmed = await asSdr(request(app).post('/api/objection-feedback')).send({
    objection: 'Not Interested', text: '  needs trimming  ',
  });
  assert.equal(trimmed.status, 201);
  assert.equal(trimmed.body.text, 'needs trimming');

  const noObjection = await asSdr(request(app).post('/api/objection-feedback')).send({ text: 'hi' });
  assert.equal(noObjection.status, 400);

  const emptyText = await asSdr(request(app).post('/api/objection-feedback')).send({ objection: 'Not Interested', text: '   ' });
  assert.equal(emptyText.status, 400);
});

test('GET /api/objection-feedback returns entries newest first', async () => {
  await ObjectionFeedback.create({ objection: 'A', text: 'first', authorEmail: 'davidv@scytale.ai', createdAt: new Date('2026-01-01') });
  await ObjectionFeedback.create({ objection: 'B', text: 'second', authorEmail: 'davidv@scytale.ai', createdAt: new Date('2026-01-02') });

  const res = await asSdr(request(app).get('/api/objection-feedback'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].text, 'second');
  assert.equal(res.body[1].text, 'first');
});

test('GET /api/objection-feedback is 401 without a session', async () => {
  const res = await request(app).get('/api/objection-feedback');
  assert.equal(res.status, 401);
});
