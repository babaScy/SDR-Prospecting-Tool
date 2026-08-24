const { test } = require('node:test');
const assert = require('node:assert/strict');
const USERS = require('../src/config/users');
const { REGIONS } = require('../src/config/filters');

const sdrs = USERS.filter((u) => u.role === 'sdr');
const inbound = USERS.filter((u) => u.role === 'inbound');

test('roster has one admin, 17 SDRs, and 2 inbound reps', () => {
  assert.equal(USERS.filter((u) => u.role === 'admin').length, 1);
  assert.equal(sdrs.length, 17);
  assert.equal(inbound.length, 2);
  assert.equal(USERS.length, 20);
});

// Inbound reps get no prospecting access, Objection Handler only — see
// routes/lists.js, leads.js, contacts.js, which scope non-admins to their own
// data by email (i.e. none, for a role that never owns a list).
test('inbound reps are millicentd and ivonne, with no regions', () => {
  const emails = inbound.map((u) => u.email).sort();
  assert.deepEqual(emails, ['ivonne@scytale.ai', 'millicentd@scytale.ai']);
  for (const u of inbound) assert.deepEqual(u.regions, [], `${u.email} should have no regions`);
});

// danielp@scytale.ai was dropped from the roster on 2026-07-27 (guarded by a
// test here ever since) and re-added intentionally on 2026-08-20.
test('danielp is an SDR in dach', () => {
  const danielp = USERS.find((u) => u.email === 'danielp@scytale.ai');
  assert.ok(danielp, 'danielp@scytale.ai should be present');
  assert.equal(danielp.role, 'sdr');
  assert.deepEqual(danielp.regions, ['dach']);
});

test('every email is lowercase', () => {
  for (const u of USERS) assert.equal(u.email, u.email.toLowerCase(), u.email);
});

test('every SDR has at least one valid region; admin has none', () => {
  const admin = USERS.find((u) => u.role === 'admin');
  assert.deepEqual(admin.regions, []);
  for (const u of sdrs) {
    assert.ok(u.regions.length >= 1, `${u.email} has no region`);
    for (const r of u.regions) assert.ok(REGIONS[r], `${u.email} has unknown region ${r}`);
  }
});

test('aus roster is correct', () => {
  const aus = sdrs.filter((u) => u.regions.includes('aus')).map((u) => u.email).sort();
  assert.deepEqual(aus, ['darrent@scytale.ai', 'katiem@scytale.ai', 'simonn@scytale.ai', 'veronicat@scytale.ai']);
});

test('taiwan roster is correct', () => {
  const taiwan = sdrs.filter((u) => u.regions.includes('taiwan')).map((u) => u.email).sort();
  assert.deepEqual(taiwan, ['darrent@scytale.ai', 'katiem@scytale.ai', 'simonn@scytale.ai', 'veronicat@scytale.ai']);
});
