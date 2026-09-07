const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const { qualifiedToday, quotaReached, pulledToday } = require('../src/services/quotaService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const sdr = 'davidv@scytale.ai';
const now = new Date('2026-07-27T12:00:00Z');

// Region defaults to 'nordics' (default 5 cap, not one of the raised
// regions) so tests about the counting logic itself aren't coupled to any
// particular region's cap.
async function seed(assignedTo, companies, region = 'nordics') {
  const list = await List.create({ name: 't', profile: 'icp1', region, requestedCount: 5, assignedTo });
  for (const c of companies) {
    await Company.create({ apolloAccountId: `${assignedTo}-${c.id}`, companyName: c.id, listId: list._id, status: c.status, createdAt: c.createdAt });
  }
  return list;
}

test('counts only qualified companies created today in the SDR\'s lists', async () => {
  await seed(sdr, [
    { id: 'a', status: 'qualified', createdAt: new Date('2026-07-27T09:00:00Z') }, // today
    { id: 'b', status: 'qualified', createdAt: new Date('2026-07-27T10:00:00Z') }, // today
    { id: 'c', status: 'nei',       createdAt: new Date('2026-07-27T10:00:00Z') }, // not qualified
    { id: 'd', status: 'qualified', createdAt: new Date('2026-07-20T10:00:00Z') }, // old
  ]);
  assert.equal(await qualifiedToday(sdr, 'nordics', now), 2);
});

test('does not count another SDR\'s qualified leads', async () => {
  await seed('khadym@scytale.ai', [{ id: 'a', status: 'qualified', createdAt: now }]);
  assert.equal(await qualifiedToday(sdr, 'nordics', now), 0);
});

test('does not count qualified leads from a different region\'s list', async () => {
  await seed(sdr, [{ id: 'a', status: 'qualified', createdAt: now }], 'uk');
  assert.equal(await qualifiedToday(sdr, 'nordics', now), 0);
});

test('quotaReached is true at 5, false at 4 (default region cap)', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, status: 'qualified', createdAt: now }));
  await seed(sdr, five);
  assert.equal(await quotaReached(sdr, 'nordics', now), true);

  await db.clear();
  await seed(sdr, five.slice(0, 4));
  assert.equal(await quotaReached(sdr, 'nordics', now), false);
});

test('quotaReached uses the raised cap for a region in REGION_DAILY_CAPS (uk: true at 7, false at 6)', async () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, status: 'qualified', createdAt: now }));
  await seed(sdr, seven, 'uk');
  assert.equal(await quotaReached(sdr, 'uk', now), true);

  await db.clear();
  await seed(sdr, seven.slice(0, 6), 'uk');
  assert.equal(await quotaReached(sdr, 'uk', now), false);
});

test('pulledToday is false with no lists yet', async () => {
  assert.equal(await pulledToday(sdr, now), false);
});

test('pulledToday is true after today\'s self-serve (quota-mode) list — even short of quota', async () => {
  await List.create({
    name: 't', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: sdr,
    pullMode: 'quota', status: 'ready', createdAt: now,
  });
  assert.equal(await pulledToday(sdr, now), true);
});

test('pulledToday ignores an admin-assigned (fixed) pull', async () => {
  await List.create({
    name: 't', profile: 'icp1', region: 'uk', requestedCount: 25, assignedTo: sdr,
    pullMode: 'fixed', status: 'ready', createdAt: now,
  });
  assert.equal(await pulledToday(sdr, now), false);
});

test('pulledToday ignores a quota-mode list from a previous day', async () => {
  await List.create({
    name: 't', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: sdr,
    pullMode: 'quota', status: 'ready', createdAt: new Date('2026-07-20T10:00:00Z'),
  });
  assert.equal(await pulledToday(sdr, now), false);
});
