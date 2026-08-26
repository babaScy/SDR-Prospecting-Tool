const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const { getQualificationMode, setQualificationMode, getMaintenanceMode, setMaintenanceMode } = require('../src/services/settingsService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

test('getQualificationMode defaults to batch when unset', async () => {
  assert.equal(await getQualificationMode(), 'batch');
});

test('setQualificationMode persists and getQualificationMode reflects it', async () => {
  await setQualificationMode('single');
  assert.equal(await getQualificationMode(), 'single');

  await setQualificationMode('batch');
  assert.equal(await getQualificationMode(), 'batch');
});

test('setQualificationMode rejects an invalid mode', async () => {
  await assert.rejects(() => setQualificationMode('bogus'));
  assert.equal(await getQualificationMode(), 'batch'); // unchanged
});

test('getMaintenanceMode defaults to false (off) when unset', async () => {
  assert.equal(await getMaintenanceMode(), false);
});

test('setMaintenanceMode persists and getMaintenanceMode reflects it', async () => {
  await setMaintenanceMode(true);
  assert.equal(await getMaintenanceMode(), true);

  await setMaintenanceMode(false);
  assert.equal(await getMaintenanceMode(), false);
});
