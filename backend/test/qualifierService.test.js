const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const qs = require('../src/services/qualifierService');
const { persistResult } = qs;

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

async function makeCompany() {
  const list = await List.create({ name: 't', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai' });
  return Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id });
}

test('persistResult: icp Yes -> qualified, tier top-level, rest in sub-doc', async () => {
  const company = await makeCompany();
  const updated = await persistResult(company, {
    icp: 'Yes', tier: 'A', isB2B: 'Yes', isSaaS: 'Yes', isCompliant: 'Not confirmed',
    reasoning: 'B2B SaaS platform',
  });
  assert.equal(updated.status, 'qualified');
  assert.equal(updated.tier, 'A');
  assert.equal(updated.qualification.icp, 'Yes');
  assert.equal(updated.qualification.reasoning, 'B2B SaaS platform');
  assert.equal(updated.qualification.tier, undefined);
});

test('persistResult: Not enough information -> nei', async () => {
  const company = await makeCompany();
  const updated = await persistResult(company, {
    icp: 'Not enough information', isB2B: 'Yes', isSaaS: 'Not enough information',
    isCompliant: 'Not confirmed', reasoning: 'site unreachable',
  });
  assert.equal(updated.status, 'nei');
  assert.equal(updated.tier, undefined);
});

test('persistResult: No -> disqualified', async () => {
  const company = await makeCompany();
  const updated = await persistResult(company, {
    icp: 'No', isB2B: 'No', isSaaS: 'No', isCompliant: 'Not confirmed', reasoning: 'consultancy',
  });
  assert.equal(updated.status, 'disqualified');
});

test('qualifyCompanies routes < 3 companies to sync, >= 3 to batch', async () => {
  const calls = [];
  const deps = {
    sync:  async (c) => { calls.push(['sync', c.length]); return new Map(); },
    batch: async (c) => { calls.push(['batch', c.length]); return new Map(); },
  };
  await qs.qualifyCompanies([{}, {}], () => {}, deps);        // 2 → sync
  await qs.qualifyCompanies([{}, {}, {}], () => {}, deps);    // 3 → batch
  await qs.qualifyCompanies([], () => {}, deps);              // 0 → no-op
  assert.deepEqual(calls, [['sync', 2], ['batch', 3]]);
});
