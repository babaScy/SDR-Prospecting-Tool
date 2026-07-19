const { test } = require('node:test');
const assert = require('node:assert/strict');
const currentUser = require('../src/middleware/currentUser');

function mockReq(email) {
  return { header: (name) => (name === 'X-User-Email' ? email : undefined) };
}

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('missing X-User-Email is rejected', () => {
  const req = mockReq(undefined);
  const res = mockRes();
  let nextCalled = false;
  currentUser(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('unrecognized X-User-Email is rejected', () => {
  const req = mockReq('nobody@scytale.ai');
  const res = mockRes();
  let nextCalled = false;
  currentUser(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('recognized admin email sets req.user and calls next', () => {
  const req = mockReq('yonia@scytale.ai');
  const res = mockRes();
  let nextCalled = false;
  currentUser(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { email: 'yonia@scytale.ai', role: 'admin' });
});

test('recognized sdr email sets req.user and calls next', () => {
  const req = mockReq('davidv@scytale.ai');
  const res = mockRes();
  let nextCalled = false;
  currentUser(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { email: 'davidv@scytale.ai', role: 'sdr' });
});
