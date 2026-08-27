const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const maintenanceGuard = require('../src/middleware/maintenanceGuard');
const { setMaintenanceMode } = require('../src/services/settingsService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function run(req) {
  const res = mockRes();
  let nextCalled = false;
  await maintenanceGuard(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('maintenance off: any user passes through', async () => {
  await setMaintenanceMode(false);
  const { nextCalled, res } = await run({ user: { role: 'sdr' } });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});

test('maintenance on: a non-admin is blocked with 503', async () => {
  await setMaintenanceMode(true);
  const { nextCalled, res } = await run({ user: { role: 'sdr' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('maintenance on: an inbound user is blocked too', async () => {
  await setMaintenanceMode(true);
  const { nextCalled, res } = await run({ user: { role: 'inbound' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('maintenance on: admin always passes through', async () => {
  await setMaintenanceMode(true);
  const { nextCalled } = await run({ user: { role: 'admin' } });
  assert.equal(nextCalled, true);
});
