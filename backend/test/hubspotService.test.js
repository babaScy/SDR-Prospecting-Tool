const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/hubspotService');

beforeEach(() => svc.clearCaches());

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

test('pushContact creates company + contact + association when nothing matches', async () => {
  const calls = [];
  const request = async (method, path) => {
    calls.push(path);
    if (path.startsWith('/crm/v3/owners')) return { data: { results: [{ id: 'owner-1' }] } };
    if (path === '/crm/v3/objects/contacts/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies/search') return { data: { total: 0, results: [] } };
    if (path === '/crm/v3/objects/companies') return { data: { id: 'co-new' } };
    if (path === '/crm/v3/objects/contacts') return { data: { id: 'c-new' } };
    if (path.includes('/associations/default/companies/')) return { data: {} };
    throw new Error(`unexpected call: ${path}`);
  };
  const result = await svc.pushContact(
    { companyName: 'Acme', website: 'https://acme.com', country: 'DE', employees: 50 },
    { email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', title: 'CTO' },
    'davidv@scytale.ai',
    { request }
  );
  assert.deepEqual(result, { status: 'synced', hubspotContactId: 'c-new', hubspotCompanyId: 'co-new' });
  assert.ok(calls.some((p) => p.includes('/associations/default/companies/co-new')));
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
