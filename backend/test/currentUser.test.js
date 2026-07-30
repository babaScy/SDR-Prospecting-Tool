const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/auth'); // sets SESSION_SECRET before the middleware signs/verifies
const currentUser = require('../src/middleware/currentUser');
const { signSession } = require('../src/services/authService');

const withSession = (email) => ({ cookies: { prospector_session: signSession({ email }) } });

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function run(req) {
  const res = mockRes();
  let nextCalled = false;
  currentUser(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('a request with no session is rejected', () => {
  const { res, nextCalled } = run({ cookies: {} });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('a tampered session cookie is rejected', () => {
  const { res, nextCalled } = run({ cookies: { prospector_session: 'not.a.valid.jwt' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('a validly signed session for an unknown address is rejected', () => {
  const { res, nextCalled } = run(withSession('nobody@scytale.ai'));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

// The whole point of the change: this header used to be the identity.
test('X-User-Email no longer grants access', () => {
  const req = { cookies: {}, header: (name) => (name === 'X-User-Email' ? 'yonia@scytale.ai' : undefined) };
  const { res, nextCalled } = run(req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(req.user, undefined);
});

test('a session signed for an admin sets req.user and calls next', () => {
  const req = withSession('yonia@scytale.ai');
  const { nextCalled } = run(req);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { email: 'yonia@scytale.ai', role: 'admin', regions: [] });
});

test('a session signed for an sdr sets req.user and calls next', () => {
  const req = withSession('davidv@scytale.ai');
  const { nextCalled } = run(req);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { email: 'davidv@scytale.ai', role: 'sdr', regions: ['dach', 'uk'] });
});
