const { test } = require('node:test');
const assert = require('node:assert/strict');
const USERS = require('../src/config/users');
const { REGIONS } = require('../src/config/filters');

const sdrs = USERS.filter((u) => u.role === 'sdr');
const inbound = USERS.filter((u) => u.role === 'inbound');
const admins = USERS.filter((u) => u.role === 'admin');

test('roster has two admins, 18 SDRs, and 2 inbound reps', () => {
  assert.equal(admins.length, 2);
  assert.equal(sdrs.length, 18);
  assert.equal(inbound.length, 2);
  assert.equal(USERS.length, 22);
});

// karlm@scytale.ai added as admin on 2026-09-03.
test('karlm is an admin with no regions', () => {
  const karlm = USERS.find((u) => u.email === 'karlm@scytale.ai');
  assert.ok(karlm, 'karlm@scytale.ai should be present');
  assert.equal(karlm.role, 'admin');
  assert.deepEqual(karlm.regions, []);
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

test('sandilen is an SDR in uk and aus', () => {
  const sandilen = USERS.find((u) => u.email === 'sandilen@scytale.ai');
  assert.ok(sandilen, 'sandilen@scytale.ai should be present');
  assert.equal(sandilen.role, 'sdr');
  assert.deepEqual(sandilen.regions, ['uk', 'aus']);
});

test('every email is lowercase', () => {
  for (const u of USERS) assert.equal(u.email, u.email.toLowerCase(), u.email);
});

test('every SDR has at least one valid region; admins have none', () => {
  for (const admin of admins) assert.deepEqual(admin.regions, [], `${admin.email} should have no regions`);
  for (const u of sdrs) {
    assert.ok(u.regions.length >= 1, `${u.email} has no region`);
    for (const r of u.regions) assert.ok(REGIONS[r], `${u.email} has unknown region ${r}`);
  }
});

test('aus roster is correct', () => {
  const aus = sdrs.filter((u) => u.regions.includes('aus')).map((u) => u.email).sort();
  assert.deepEqual(aus, ['darrent@scytale.ai', 'katiem@scytale.ai', 'sandilen@scytale.ai', 'simonn@scytale.ai', 'veronicat@scytale.ai']);
});

test('taiwan roster is correct', () => {
  const taiwan = sdrs.filter((u) => u.regions.includes('taiwan')).map((u) => u.email).sort();
  assert.deepEqual(taiwan, ['darrent@scytale.ai', 'katiem@scytale.ai', 'simonn@scytale.ai', 'veronicat@scytale.ai']);
});
