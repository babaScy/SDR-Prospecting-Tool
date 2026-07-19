const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const { persistResult } = require('../src/services/qualifierService');

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
