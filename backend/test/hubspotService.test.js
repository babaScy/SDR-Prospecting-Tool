const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/hubspotService');

beforeEach(() => svc.clearCaches());

// In-memory stand-in for HubspotCompanyLock, so these tests never need a real
// Mongo connection. `_held` lets a test start with the lock already taken, to
// simulate a concurrent request that's mid-create.
function fakeLockModel() {
  const held = new Set();
  return {
    _held: held,
    async create({ domain }) {
      if (held.has(domain)) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      held.add(domain);
    },
    async deleteOne({ domain }) {
      held.delete(domain);
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

test('contactProps carries the contact\'s own company name, country, and employee count, independent of the associated company record', () => {
  const props = svc.contactProps(
    { firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com', title: 'CTO' },
    'owner-1',
    { companyName: 'Acme', country: 'Germany', employees: 50 }
  );
  assert.equal(props.company, 'Acme');
  assert.equal(props.country, 'Germany');
  assert.equal(props.number_of_employees_contact, 50);
});

test('contactProps omits company/country/employee-count when there is no associated company to read them from', () => {
  const props = svc.contactProps({ firstName: 'Jane', email: 'jane@acme.com' }, 'owner-1');
  assert.equal('company' in props, false);
  assert.equal('country' in props, false);
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
    { companyName: 'Acme', website: 'https://acme.com', country: 'DE', employees: 50 },
    { email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', title: 'CTO' },
    'davidv@scytale.ai',
    { request, lockModel: fakeLockModel() }
  );
  assert.deepEqual(result, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-new' });
  assert.ok(calls.some((p) => p.includes('/associations/default/companies/co-new')));
  assert.equal(contactPayload.company, 'Acme', 'the contact itself must carry the company name, not just the association');
  assert.equal(contactPayload.country, 'DE', 'the contact itself must carry the country, not just the association');
  assert.equal(contactPayload.number_of_employees_contact, 50, 'the contact itself must carry the employee count too');
});

test('pushContact creates a fresh company every time when there is no domain to dedupe on (no lock involved)', async () => {
  const request = async (method, path) => {
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') return { data: { id: 'co-new' } };
    if (path === '/crm/v3/objects/contacts') return { data: { id: 'c-new' } };
    if (path.includes('/associations/default/companies/')) return { data: {} };
    throw new Error(`unexpected call: ${path} (there is no domain, so search must never run)`);
  };
  const result = await svc.pushContact(
    { companyName: 'Acme' }, // no website
    { email: 'jane@acme.com' }, // no stored domain either
    'davidv@scytale.ai',
    { request }
  );
  assert.deepEqual(result, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-new' });
});

test('createCompanyOnce creates the company when the domain lock is free, then releases it', async () => {
  const lockModel = fakeLockModel();
  let createCalls = 0;
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies') { createCalls += 1; return { data: { id: 'co-1' } }; }
    throw new Error(`unexpected call: ${path}`);
  };
  const id = await svc.createCompanyOnce({ companyName: 'Acme' }, 'acme.com', 'owner-1', { request, lockModel });
  assert.equal(id, 'co-1');
  assert.equal(createCalls, 1);
  assert.equal(lockModel._held.has('acme.com'), false, 'lock must be released after a successful create');
});

test('createCompanyOnce releases the lock even when the HubSpot create call fails', async () => {
  const lockModel = fakeLockModel();
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies') throw new Error('HubSpot 500');
    throw new Error(`unexpected call: ${path}`);
  };
  await assert.rejects(() => svc.createCompanyOnce({ companyName: 'Acme' }, 'acme.com', 'owner-1', { request, lockModel }));
  assert.equal(lockModel._held.has('acme.com'), false, 'lock must be released on failure too, or the domain would be stuck for ~60s');
});

test('createCompanyOnce: when another request already holds the domain lock, it waits and reuses the company that request creates — never a duplicate', async () => {
  const lockModel = fakeLockModel();
  lockModel._held.add('acme.com'); // simulates a concurrent pushContact call mid-create
  let searchCalls = 0;
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') {
      searchCalls += 1;
      // the concurrent holder's create "lands" on the 2nd poll, not the 1st
      if (searchCalls < 2) return { data: { total: 0, results: [] } };
      return { data: { total: 1, results: [{ id: 'co-from-other-request' }] } };
    }
    throw new Error(`unexpected call: ${path} (must never create — that would be the duplicate)`);
  };
  const id = await svc.createCompanyOnce(
    { companyName: 'Acme' }, 'acme.com', 'owner-1',
    { request, lockModel, sleep: async () => {} } // skip the real delay in tests
  );
  assert.equal(id, 'co-from-other-request');
  assert.ok(searchCalls >= 2);
});

test('createCompanyOnce gives up loudly (without ever creating a duplicate) if the lock holder never finishes', async () => {
  const lockModel = fakeLockModel();
  lockModel._held.add('acme.com');
  const request = async (method, path) => {
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    throw new Error(`unexpected call: ${path}`);
  };
  await assert.rejects(
    () => svc.createCompanyOnce({ companyName: 'Acme' }, 'acme.com', 'owner-1', { request, lockModel, sleep: async () => {} }),
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
    { companyName: 'Acme', website: 'https://acme.com' },
    { email: 'jane@acme.com' },
    'davidv@scytale.ai',
    { request }
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
    () => svc.pushContact({ companyName: 'Acme', website: 'https://acme.com' }, { email: 'jane@acme.com' }, 'davidv@scytale.ai', { request }),
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
