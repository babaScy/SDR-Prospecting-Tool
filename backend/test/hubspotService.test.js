const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/hubspotService');

beforeEach(() => svc.clearCaches());

// In-memory stand-in for the Company model, so these tests never need a real
// Mongo connection. Mirrors just enough of findById/findOneAndUpdate/updateOne
// semantics for resolveOrCreateCompany's claim dance: findOneAndUpdate only
// "matches" (and thus claims) a doc whose hubspotCompanyId is unset, or is a
// PENDING claim old enough to count as abandoned.
const PENDING = 'PENDING';
function fakeCompanyModel(seed) {
  const docs = new Map();
  if (seed) docs.set(String(seed._id), { ...seed });
  return {
    _docs: docs,
    async findById(id) {
      const doc = docs.get(String(id));
      return doc ? { ...doc } : null;
    },
    async findOneAndUpdate(filter, update) {
      const id = String(filter._id);
      const existing = docs.get(id) || null;
      const currentId = existing?.hubspotCompanyId;
      const matches = filter.$or.some((clause) => {
        if (clause.hubspotCompanyId?.$exists === false) return currentId === undefined;
        if (clause.hubspotCompanyId === PENDING) {
          return currentId === PENDING
            && existing.hubspotCompanyClaimedAt
            && existing.hubspotCompanyClaimedAt < clause.hubspotCompanyClaimedAt.$lt;
        }
        return false;
      });
      if (!matches) return null;
      docs.set(id, { ...(existing || { _id: id }), ...update.$set });
      return existing || {};
    },
    async updateOne(filter, update) {
      const id = String(filter._id);
      const doc = docs.get(id) || { _id: id };
      const matches = Object.entries(filter).every(([k, v]) => k === '_id' || doc[k] === v);
      if (!matches) return;
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
      docs.set(id, doc);
    },
  };
}

test('normalizeDomain strips protocol, www, and path', () => {
  assert.equal(svc.normalizeDomain('https://www.acme.com/pricing'), 'acme.com');
  assert.equal(svc.normalizeDomain('acme.io'), 'acme.io');
  assert.equal(svc.normalizeDomain(''), null);
  assert.equal(svc.normalizeDomain(null), null);
});

test('normalizeEmail lowercases and rejects non-emails', () => {
  assert.equal(svc.normalizeEmail('Jane@Acme.COM'), 'jane@acme.com');
  assert.equal(svc.normalizeEmail('not-an-email'), null);
  assert.equal(svc.normalizeEmail(null), null);
});

test('normalizeLinkedIn canonicalizes to https, no www, no trailing slash', () => {
  assert.equal(svc.normalizeLinkedIn('http://www.linkedin.com/in/jane/'), 'https://linkedin.com/in/jane');
  assert.equal(svc.normalizeLinkedIn('not linkedin'), null);
});

test('linkedinVariants covers protocol/www/trailing-slash combinations', () => {
  const variants = svc.linkedinVariants('linkedin.com/in/jane');
  assert.ok(variants.includes('https://linkedin.com/in/jane'));
  assert.ok(variants.includes('https://www.linkedin.com/in/jane/'));
  assert.equal(svc.linkedinVariants(null).length, 0);
});

test('getOwnerIdByEmail returns the matching owner id', async () => {
  const request = async () => ({ data: { results: [{ id: 'owner-1' }] } });
  const id = await svc.getOwnerIdByEmail('davidv@scytale.ai', { request });
  assert.equal(id, 'owner-1');
});

test('getOwnerIdByEmail returns null when no HubSpot user matches', async () => {
  const request = async () => ({ data: { results: [] } });
  const id = await svc.getOwnerIdByEmail('nobody@scytale.ai', { request });
  assert.equal(id, null);
});

test('getOwnerIdByEmail caches by email (case-insensitive) — second call skips the request', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { data: { results: [{ id: 'owner-2' }] } }; };
  await svc.getOwnerIdByEmail('davidv@scytale.ai', { request });
  await svc.getOwnerIdByEmail('DavidV@Scytale.ai', { request });
  assert.equal(calls, 1);
});

test('getOwnerIdByEmail never caches a negative result — a later call re-checks HubSpot', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { data: { results: [] } }; };
  const first = await svc.getOwnerIdByEmail('nobody@scytale.ai', { request });
  const second = await svc.getOwnerIdByEmail('nobody@scytale.ai', { request });
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 2, 'a "not found" result must not be cached, so the SDR can be added to HubSpot later without a restart');
});

test('findCompanyByDomain: no match, single match, ambiguous', async () => {
  const none = await svc.findCompanyByDomain('acme.com', { request: async () => ({ data: { total: 0, results: [] } }) });
  assert.equal(none, null);
  const one = await svc.findCompanyByDomain('acme.com', { request: async () => ({ data: { total: 1, results: [{ id: 'co-1' }] } }) });
  assert.equal(one.id, 'co-1');
  const many = await svc.findCompanyByDomain('acme.com', { request: async () => ({ data: { total: 2, results: [] } }) });
  assert.deepEqual(many, { ambiguous: true, count: 2 });
});

test('findContactByEmailOrLinkedIn matches on email, flags ambiguous', async () => {
  const byEmail = await svc.findContactByEmailOrLinkedIn('jane@acme.com', null, {
    request: async () => ({ data: { total: 1, results: [{ id: 'c-1', properties: { email: 'jane@acme.com' } }] } }),
  });
  assert.deepEqual(byEmail, { id: 'c-1', matchedOn: 'email' });

  const ambiguous = await svc.findContactByEmailOrLinkedIn('jane@acme.com', null, {
    request: async () => ({ data: { total: 2, results: [] } }),
  });
  assert.deepEqual(ambiguous, { ambiguous: true, count: 2 });
});

test('pushContact fails loudly when the SDR has no HubSpot owner', async () => {
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [] } };
    throw new Error('should not reach HubSpot beyond the owner lookup');
  };
  await assert.rejects(
    () => svc.pushContact({ companyName: 'Acme' }, { email: 'jane@acme.com' }, 'ghost@scytale.ai', { request }),
    (err) => { assert.equal(err.code, 'NO_HUBSPOT_OWNER'); return true; }
  );
});

test('pushContact returns already_existed without touching the company', async () => {
  let companyCallMade = false;
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') {
      return { data: { total: 1, results: [{ id: 'c-existing', properties: { email: 'jane@acme.com' } }] } };
    }
    companyCallMade = true;
    throw new Error('should not resolve/create a company once contact is found');
  };
  const result = await svc.pushContact(
    { companyName: 'Acme', website: 'https://acme.com' },
    { email: 'jane@acme.com', firstName: 'Jane' },
    'davidv@scytale.ai',
    { request }
  );
  assert.deepEqual(result, { status: 'already_existed', hubspotContactId: 'c-existing', hubspotCompanyId: null });
  assert.equal(companyCallMade, false);
});

test('contactProps carries the contact\'s own company name and country, independent of the associated company record', () => {
  const props = svc.contactProps(
    { firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com', title: 'CTO' },
    'owner-1',
    { companyName: 'Acme', country: 'Germany', employees: 50 }
  );
  assert.equal(props.company, 'Acme');
  assert.equal(props.country, 'Germany');
});

test('contactProps omits company/country when there is no associated company to read them from', () => {
  const props = svc.contactProps({ firstName: 'Jane', email: 'jane@acme.com' }, 'owner-1');
  assert.equal('company' in props, false);
  assert.equal('country' in props, false);
});

// Regression test: HubSpot rejects writes to number_of_employees_contact with
// READ_ONLY_VALUE — it's a calculated property, not the plain numeric field it
// appeared to be. This must never be sent, or every push to a contact whose
// company has an employee count set fails outright.
test('contactProps never sends number_of_employees_contact — HubSpot rejects it as a calculated/read-only property', () => {
  const props = svc.contactProps(
    { firstName: 'Jane', email: 'jane@acme.com' },
    'owner-1',
    { companyName: 'Acme', employees: 50 }
  );
  assert.equal('number_of_employees_contact' in props, false);
});

test('pushContact creates company + contact + association when nothing matches', async () => {
  const calls = [];
  let contactPayload;
  const request = async (method, path, data) => {
    calls.push(path);
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') return { data: { id: 'co-new' } };
    if (path === '/crm/v3/objects/contacts') { contactPayload = data.properties; return { data: { id: 'c-new' } }; }
    if (path.includes('/associations/default/companies/')) return { data: {} };
    throw new Error(`unexpected call: ${path}`);
  };
  const result = await svc.pushContact(
    { _id: 'company-1', companyName: 'Acme', website: 'https://acme.com', country: 'DE', employees: 50 },
    { email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', title: 'CTO' },
    'davidv@scytale.ai',
    { request, companyModel: fakeCompanyModel() }
  );
  assert.deepEqual(result, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-new' });
  assert.ok(calls.some((p) => p.includes('/associations/default/companies/co-new')));
  assert.equal(contactPayload.company, 'Acme', 'the contact itself must carry the company name, not just the association');
  assert.equal(contactPayload.country, 'DE', 'the contact itself must carry the country, not just the association');
  assert.equal('number_of_employees_contact' in contactPayload, false, 'HubSpot rejects writes to this calculated property');
});

test('pushContact resolves the company once even with no domain to dedupe on, and reuses it for later contacts at the same company', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1' });
  let createCalls = 0;
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') { createCalls += 1; return { data: { id: 'co-new' } }; }
    if (path === '/crm/v3/objects/contacts') return { data: { id: 'c-new' } };
    if (path.includes('/associations/default/companies/')) return { data: {} };
    throw new Error(`unexpected call: ${path} (there is no domain, so search must never run)`);
  };
  const first = await svc.pushContact(
    { _id: 'company-1', companyName: 'Acme' }, // no website
    { email: 'jane@acme.com' }, // no stored domain either
    'davidv@scytale.ai',
    { request, companyModel }
  );
  assert.deepEqual(first, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-new' });

  // A second contact at the same (still domain-less) company must reuse the
  // resolved id, not create a second company — this used to always create a
  // fresh one, since there was nothing to dedupe on. Now the claim is keyed on
  // company._id, so it applies with or without a domain.
  const second = await svc.pushContact(
    { _id: 'company-1', companyName: 'Acme' },
    { email: 'bob@acme.com' },
    'davidv@scytale.ai',
    { request, companyModel }
  );
  assert.equal(second.hubspotCompanyId, 'co-new');
  assert.equal(createCalls, 1, 'the company must only ever be created once for this company._id');
});

test('resolveOrCreateCompany: fast path returns the already-resolved id with no HubSpot company search at all', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1', hubspotCompanyId: 'co-cached' });
  const request = async (method, path) => { throw new Error(`unexpected call: ${path} — should have used the cached id`); };
  const id = await svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel });
  assert.equal(id, 'co-cached');
});

test('resolveOrCreateCompany: claims an unresolved company, creates it, and persists the real id (not PENDING)', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1' });
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') return { data: { id: 'co-1' } };
    throw new Error(`unexpected call: ${path}`);
  };
  const id = await svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel });
  assert.equal(id, 'co-1');
  const stored = await companyModel.findById('company-1');
  assert.equal(stored.hubspotCompanyId, 'co-1');
});

test('resolveOrCreateCompany: reuses an existing HubSpot company found by domain instead of creating one', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1' });
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 1, results: [{ id: 'co-existing' }] } };
    throw new Error(`unexpected call: ${path} (must not create — one already exists)`);
  };
  const id = await svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel });
  assert.equal(id, 'co-existing');
});

test('resolveOrCreateCompany: releases the claim on failure, instead of leaving it stuck for the full stale-claim window', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1' });
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') throw new Error('HubSpot 500');
    throw new Error(`unexpected call: ${path}`);
  };
  await assert.rejects(() => svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel }));
  const stored = await companyModel.findById('company-1');
  assert.equal(stored.hubspotCompanyId, undefined, 'the claim must be released, or a retry would be stuck for ~60s');
});

test('resolveOrCreateCompany: when another request already holds the claim, it waits and reuses what that request resolves — never a duplicate', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1', hubspotCompanyId: PENDING, hubspotCompanyClaimedAt: new Date() });
  let pollCount = 0;
  const request = async (method, path) => { throw new Error(`unexpected call: ${path} (must never create — that would be the duplicate)`); };
  const resultPromise = svc.resolveOrCreateCompany(
    { _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1',
    {
      request, companyModel,
      sleep: async () => {
        pollCount += 1;
        // the concurrent holder's create "lands" on the 2nd poll, not the 1st
        if (pollCount === 2) await companyModel.updateOne({ _id: 'company-1' }, { $set: { hubspotCompanyId: 'co-from-other-request' } });
      },
    }
  );
  assert.equal(await resultPromise, 'co-from-other-request');
  assert.ok(pollCount >= 2);
});

test('resolveOrCreateCompany: a stale (crashed-holder) claim can be reclaimed and resolved instead of blocking forever', async () => {
  const longAgo = new Date(Date.now() - 5 * 60_000); // well past the 60s staleness window
  const companyModel = fakeCompanyModel({ _id: 'company-1', hubspotCompanyId: PENDING, hubspotCompanyClaimedAt: longAgo });
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') return { data: { id: 'co-reclaimed' } };
    throw new Error(`unexpected call: ${path}`);
  };
  const id = await svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel });
  assert.equal(id, 'co-reclaimed');
});

test('resolveOrCreateCompany gives up loudly (without ever creating a duplicate) if the claim holder never finishes', async () => {
  const companyModel = fakeCompanyModel({ _id: 'company-1', hubspotCompanyId: PENDING, hubspotCompanyClaimedAt: new Date() });
  const request = async (method, path) => { throw new Error(`unexpected call: ${path}`); };
  await assert.rejects(
    () => svc.resolveOrCreateCompany({ _id: 'company-1', companyName: 'Acme' }, 'acme.com', 'owner-1', { request, companyModel, sleep: async () => {} }),
    (err) => { assert.equal(err.code, 'COMPANY_CREATE_TIMEOUT'); return true; }
  );
});

test('pushContact reuses an existing HubSpot company instead of creating a duplicate', async () => {
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 1, results: [{ id: 'co-existing' }] } };
    if (path === '/crm/v3/objects/contacts') return { data: { id: 'c-new' } };
    if (path.includes('/associations/default/companies/')) return { data: {} };
    throw new Error(`unexpected create call: ${path}`);
  };
  const result = await svc.pushContact(
    { _id: 'company-1', companyName: 'Acme', website: 'https://acme.com' },
    { email: 'jane@acme.com' },
    'davidv@scytale.ai',
    { request, companyModel: fakeCompanyModel() }
  );
  assert.deepEqual(result, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-existing' });
});

test('pushContact rejects when the domain matches more than one HubSpot company', async () => {
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 2, results: [] } };
    throw new Error('should not create anything when ambiguous');
  };
  await assert.rejects(
    () => svc.pushContact(
      { _id: 'company-1', companyName: 'Acme', website: 'https://acme.com' },
      { email: 'jane@acme.com' },
      'davidv@scytale.ai',
      { request, companyModel: fakeCompanyModel() }
    ),
    (err) => { assert.equal(err.code, 'AMBIGUOUS_COMPANY'); return true; }
  );
});

test('pushContact rejects when email/LinkedIn matches more than one HubSpot contact', async () => {
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 2, results: [] } };
    throw new Error('should not create anything when ambiguous');
  };
  await assert.rejects(
    () => svc.pushContact({ companyName: 'Acme', website: 'https://acme.com' }, { email: 'jane@acme.com' }, 'davidv@scytale.ai', { request }),
    (err) => { assert.equal(err.code, 'AMBIGUOUS_CONTACT'); return true; }
  );
});
