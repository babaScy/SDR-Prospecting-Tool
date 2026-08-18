const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const asSdr = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));
const asOtherSdr = (req) => req.set('Cookie', sessionCookie('khadym@scytale.ai'));

test('POST /api/objection-responses/star toggles the caller\'s star on then off', async () => {
  const on = await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  assert.equal(on.status, 200);
  assert.equal(on.body.myStarred, true);
  assert.equal(on.body.netScore, 0);

  const off = await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  assert.equal(off.status, 200);
  assert.equal(off.body.myStarred, false);
});

test('POST /api/objection-responses/vote sets, clears on repeat, switches on opposite value', async () => {
  const up = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  assert.equal(up.status, 200);
  assert.equal(up.body.myVote, 1);
  assert.equal(up.body.netScore, 1);

  const upAgain = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  assert.equal(upAgain.body.myVote, 0);
  assert.equal(upAgain.body.netScore, 0);

  const down = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: -1 });
  assert.equal(down.body.myVote, -1);
  assert.equal(down.body.netScore, -1);
});

test('POST /api/objection-responses/vote 400s on missing fields or an invalid value', async () => {
  const noTitle = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', value: 1 });
  assert.equal(noTitle.status, 400);

  const badValue = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 2 });
  assert.equal(badValue.status, 400);
});

test('netScore sums votes across multiple SDRs; GET never exposes another SDR\'s own vote/star', async () => {
  await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  await asOtherSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });

  const asDavid = await asSdr(request(app).get('/api/objection-responses'));
  assert.equal(asDavid.status, 200);
  const davidRow = asDavid.body.find((r) => r.boxTitle === 'Initial Response 1');
  assert.equal(davidRow.netScore, 2);
  assert.equal(davidRow.myVote, 1);
  assert.equal(davidRow.myStarred, true);

  const asKhady = await asOtherSdr(request(app).get('/api/objection-responses'));
  const khadyRow = asKhady.body.find((r) => r.boxTitle === 'Initial Response 1');
  assert.equal(khadyRow.netScore, 2);
  assert.equal(khadyRow.myVote, 1);
  assert.equal(khadyRow.myStarred, false);
});

test('objection-responses routes are 401 without a session', async () => {
  const res = await request(app).get('/api/objection-responses');
  assert.equal(res.status, 401);
});
