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

async function seed(assignedTo, companies) {
  const list = await List.create({ name: 't', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo });
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
  assert.equal(await qualifiedToday(sdr, now), 2);
});

test('does not count another SDR\'s qualified leads', async () => {
  await seed('khadym@scytale.ai', [{ id: 'a', status: 'qualified', createdAt: now }]);
  assert.equal(await qualifiedToday(sdr, now), 0);
});

test('quotaReached is true at 5, false at 4', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, status: 'qualified', createdAt: now }));
  await seed(sdr, five);
  assert.equal(await quotaReached(sdr, now), true);

  await db.clear();
  await seed(sdr, five.slice(0, 4));
  assert.equal(await quotaReached(sdr, now), false);
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
