# HubSpot Contact Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-contact "Add to HubSpot" button on the Contacts screen that pushes a sourced contact (and its company, if needed) into HubSpot under the owning SDR, with dedup safety, and persists the outcome so button state survives a refresh.

**Architecture:** A new `hubspotService.js` (OAuth refresh-token auth, dedup lookups, insert-only orchestrator) is called by a new `POST /api/contacts/:id/hubspot` route, which persists the result onto the `Contact` document. The frontend adds one button per contact card driven by that persisted status.

**Tech Stack:** Express 5, Mongoose, `axios` (already a backend dependency), `node:test` + `supertest` (existing test stack), React 18 (existing frontend).

## Global Constraints

- Insert-only: never update or delete existing HubSpot records (matches WOLF+'s posture).
- No outreach-sequence enrollment and no auto-generated email copy fields — Prospector doesn't generate that content; this button only creates/reuses the company and contact records.
- Owner attribution (`hubspot_owner_id`) is resolved live per push from the *list's* assigned SDR (`list.assignedTo`) via HubSpot's Owners API. If no HubSpot owner matches that email, the push fails outright — there is no fallback to a default owner.
- No dry-run / master-switch env flags — the button click is the explicit confirmation for a single contact.
- Tests never call the real HubSpot API — every function that makes an HTTP call accepts an injectable `deps.request` (or `deps` object), mirroring the pattern already used in `apolloPeopleService.js`.
- New required env vars: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REFRESH_TOKEN` — added to `server.js`'s `REQUIRED_ENV` fail-fast list, same as `APOLLO_PEOPLE_KEY`.
- The OAuth token fetch and retry-on-429/5xx logic inside `hsRequest` are exercised only by a real HubSpot call (first live click, same posture the repo already documents for contact sourcing's first live Apollo call) — every unit test injects `deps.request` and never reaches `hsRequest` itself. This is a deliberate, documented gap, not an oversight.

---

### Task 1: `hubspotService` — auth, normalization, owner lookup

**Files:**
- Create: `backend/src/services/hubspotService.js`
- Test: `backend/test/hubspotService.test.js`

**Interfaces:**
- Produces (used by later tasks in this same file and by Task 2's additions):
  - `normalizeDomain(input: string|null): string|null`
  - `normalizeEmail(input: string|null): string|null`
  - `normalizeLinkedIn(input: string|null): string|null`
  - `linkedinVariants(input: string|null): string[]`
  - `getOwnerIdByEmail(email: string, deps?: { request? }): Promise<string|null>`
  - `clearCaches(): void` (resets the OAuth token cache and owner cache — used by tests)

- [ ] **Step 1: Write the failing tests**

Create `backend/test/hubspotService.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test test/hubspotService.test.js`
Expected: FAIL — `Cannot find module '../src/services/hubspotService'`

- [ ] **Step 3: Implement `hubspotService.js`**

Create `backend/src/services/hubspotService.js`:

```js
const axios = require('axios');

// ─── OAuth token management (refresh-token flow) ─────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

const trim = (v) => (typeof v === 'string' ? v.trim() : v);

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const refresh = trim(process.env.HUBSPOT_REFRESH_TOKEN);
  const clientId = trim(process.env.HUBSPOT_CLIENT_ID);
  const clientSecret = trim(process.env.HUBSPOT_CLIENT_SECRET);
  if (!refresh || !clientId || !clientSecret) {
    throw new Error('HubSpot OAuth creds missing (need HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REFRESH_TOKEN)');
  }
  const res = await axios.post(
    'https://api.hubapi.com/oauth/v1/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

// Authed request. Retries once on 429/5xx (HubSpot rate limit / transient).
async function hsRequest(method, path, data) {
  const token = await getAccessToken();
  const cfg = {
    method,
    url: `https://api.hubapi.com${path}`,
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  try {
    return await axios(cfg);
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || (status >= 500 && status < 600)) {
      const wait = parseInt(err.response?.headers?.['retry-after'] || '2', 10) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return axios(cfg);
    }
    throw err;
  }
}

// ─── Normalization (the real anti-duplicate work) ────────────────────────────
function normalizeDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d || null;
}

function normalizeEmail(input) {
  if (!input) return null;
  const e = String(input).trim().toLowerCase();
  return e.includes('@') ? e : null;
}

function linkedinCore(input) {
  if (!input) return null;
  let u = String(input).trim().toLowerCase();
  if (!u) return null;
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  u = u.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return u.includes('linkedin.com') ? u : null;
}

function normalizeLinkedIn(input) {
  const core = linkedinCore(input);
  return core ? `https://${core}` : null;
}

// All plausible stored formats, for exact-match search (HubSpot search is exact).
function linkedinVariants(input) {
  const core = linkedinCore(input);
  if (!core) return [];
  const hosts = [core, `www.${core}`];
  const out = [];
  for (const h of hosts) for (const proto of ['https://', 'http://']) for (const slash of ['', '/']) out.push(proto + h + slash);
  return [...new Set(out)];
}

// ─── Owner lookup (cached — owners rarely change) ────────────────────────────
const ownerCache = new Map(); // lowercased email -> HubSpot owner id, or null (checked, not found)

async function getOwnerIdByEmail(email, deps = {}) {
  const request = deps.request || hsRequest;
  const key = String(email).toLowerCase();
  if (ownerCache.has(key)) return ownerCache.get(key);
  const res = await request('get', `/crm/v3/owners?email=${encodeURIComponent(key)}`);
  const owner = (res.data.results || [])[0];
  const id = owner ? owner.id : null;
  ownerCache.set(key, id);
  return id;
}

function clearCaches() {
  cachedToken = null;
  tokenExpiresAt = 0;
  ownerCache.clear();
}

module.exports = {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedIn,
  linkedinVariants,
  getOwnerIdByEmail,
  clearCaches,
  // internal, exposed only so Task 2 extends the same module cleanly:
  hsRequest,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test test/hubspotService.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/hubspotService.js backend/test/hubspotService.test.js
git commit -m "feat(prospector): HubSpot auth, normalization, owner lookup"
```

---

### Task 2: `hubspotService` — dedup lookups + push orchestrator

**Files:**
- Modify: `backend/src/services/hubspotService.js`
- Modify: `backend/test/hubspotService.test.js`

**Interfaces:**
- Consumes: `normalizeDomain`, `normalizeEmail`, `normalizeLinkedIn`, `linkedinVariants`, `getOwnerIdByEmail`, `hsRequest` from Task 1 (same file).
- Produces (used by Task 3's route):
  - `pushContact(company, contact, ownerEmail, deps?): Promise<{ status: 'synced'|'already_existed', hubspotContactId: string, hubspotCompanyId: string|null }>`
  - `HubspotPushError` — `Error` subclass with a `.code` property (`'NO_HUBSPOT_OWNER' | 'AMBIGUOUS_CONTACT' | 'AMBIGUOUS_COMPANY'`), thrown by `pushContact` to block a write.
  - `company` shape consumed: `{ companyName, website, country, employees, companyLinkedinUrl }` (all optional except `companyName`).
  - `contact` shape consumed: `{ email, firstName, lastName, title, linkedinUrl, domain }` (all optional).

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/hubspotService.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test test/hubspotService.test.js`
Expected: FAIL — `svc.findCompanyByDomain is not a function` (and similar for the other new exports)

- [ ] **Step 3: Extend `hubspotService.js`**

Add to `backend/src/services/hubspotService.js` (before the final `module.exports`):

```js
// ─── Property mapping ────────────────────────────────────────────────────────
const prune = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));

const resolveDomain = (company, contact) => normalizeDomain(contact?.domain || company?.website);

const companyProps = (company, domain, ownerId) => prune({
  name: company.companyName,
  domain,
  country: company.country,
  numberofemployees: company.employees,
  linkedin_company_page: normalizeLinkedIn(company.companyLinkedinUrl),
  hubspot_owner_id: ownerId,
  inbound_outbound: 'OUTBOUND',
  lifecyclestage: '209865412', // "Outbound Qualified Lead"
});

const contactProps = (contact, ownerId) => prune({
  firstname: contact.firstName,
  lastname: contact.lastName,
  email: normalizeEmail(contact.email),
  jobtitle: contact.title,
  linkedin_profile: normalizeLinkedIn(contact.linkedinUrl),
  hs_marketable_status: false,
  hubspot_owner_id: ownerId,
  hs_lead_status: 'NEW',
  lead_source: 'Outbound',
  mql_sql: 'SQL',
});

// ─── Dedup lookups (read-only) ────────────────────────────────────────────────
async function findCompanyByDomain(domain, deps = {}) {
  const request = deps.request || hsRequest;
  const d = normalizeDomain(domain);
  if (!d) return null;
  const res = await request('post', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: d }] }],
    properties: ['domain', 'name'],
    limit: 2,
  });
  const total = res.data.total || 0;
  if (total === 0) return null;
  if (total > 1) return { ambiguous: true, count: total };
  return { id: res.data.results[0].id };
}

async function findContactByEmailOrLinkedIn(email, linkedinUrl, deps = {}) {
  const request = deps.request || hsRequest;
  const e = normalizeEmail(email);
  const liVariants = linkedinVariants(linkedinUrl);
  const filterGroups = [];
  if (e) filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: e }] });
  if (liVariants.length) filterGroups.push({ filters: [{ propertyName: 'linkedin_profile', operator: 'IN', values: liVariants }] });
  if (!filterGroups.length) return null;
  const res = await request('post', '/crm/v3/objects/contacts/search', {
    filterGroups,
    properties: ['email', 'linkedin_profile'],
    limit: 2,
  });
  const total = res.data.total || 0;
  if (total === 0) return null;
  if (total > 1) return { ambiguous: true, count: total };
  const hit = res.data.results[0];
  const matchedOn = e && hit.properties?.email?.toLowerCase() === e ? 'email' : 'linkedin';
  return { id: hit.id, matchedOn };
}

// ─── Orchestrator: dedup gate + insert-only write for ONE contact ────────────
class HubspotPushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function pushContact(company, contact, ownerEmail, deps = {}) {
  const request = deps.request || hsRequest;

  const ownerId = await getOwnerIdByEmail(ownerEmail, { request });
  if (!ownerId) {
    throw new HubspotPushError(
      'NO_HUBSPOT_OWNER',
      `No HubSpot user found for ${ownerEmail} — ask an admin to check their HubSpot account email.`
    );
  }

  const existingContact = await findContactByEmailOrLinkedIn(contact.email, contact.linkedinUrl, { request });
  if (existingContact?.ambiguous) {
    throw new HubspotPushError(
      'AMBIGUOUS_CONTACT',
      `${existingContact.count} HubSpot contacts already match this email/LinkedIn — resolve manually.`
    );
  }
  if (existingContact) {
    return { status: 'already_existed', hubspotContactId: existingContact.id, hubspotCompanyId: null };
  }

  const domain = resolveDomain(company, contact);
  const companyHit = domain ? await findCompanyByDomain(domain, { request }) : null;
  if (companyHit?.ambiguous) {
    throw new HubspotPushError(
      'AMBIGUOUS_COMPANY',
      `${companyHit.count} HubSpot companies already match domain ${domain} — resolve manually.`
    );
  }

  let companyId = companyHit?.id;
  if (!companyId) {
    const created = await request('post', '/crm/v3/objects/companies', { properties: companyProps(company, domain, ownerId) });
    companyId = created.data.id;
  }

  const createdContact = await request('post', '/crm/v3/objects/contacts', { properties: contactProps(contact, ownerId) });
  const contactId = createdContact.data.id;

  await request('put', `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`);

  return { status: 'synced', hubspotContactId: contactId, hubspotCompanyId: companyId };
}
```

Then replace the `module.exports` block with:

```js
module.exports = {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedIn,
  linkedinVariants,
  getOwnerIdByEmail,
  findCompanyByDomain,
  findContactByEmailOrLinkedIn,
  companyProps,
  contactProps,
  resolveDomain,
  pushContact,
  HubspotPushError,
  clearCaches,
  hsRequest,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test test/hubspotService.test.js`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/hubspotService.js backend/test/hubspotService.test.js
git commit -m "feat(prospector): HubSpot dedup lookups + push orchestrator"
```

---

### Task 3: `Contact` model fields + `POST /api/contacts/:id/hubspot` route

**Files:**
- Modify: `backend/src/models/Contact.js`
- Create: `backend/src/routes/contacts.js`
- Modify: `backend/src/app.js`
- Modify: `backend/server.js`
- Test: `backend/test/hubspotRoutes.test.js`

**Interfaces:**
- Consumes: `hubspotService.pushContact(company, contact, ownerEmail)` from Task 2.
- Consumes existing `req.user` shape from `middleware/currentUser.js` (`{ email, role, regions }`), same as `routes/leads.js`.
- Produces: `Contact` documents now carry `hubspotStatus`, `hubspotContactId`, `hubspotCompanyId`, `hubspotSyncedAt`, `hubspotSyncedBy`, `hubspotError` — consumed by Task 4's frontend.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/hubspotRoutes.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const hubspotService = require('../src/services/hubspotService');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); });

const asDavid = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));
const asKhadym = (req) => req.set('Cookie', sessionCookie('khadym@scytale.ai'));

const makeSetup = async () => {
  const list = await List.create({
    name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1,
    assignedTo: 'davidv@scytale.ai', status: 'sourced',
  });
  const company = await Company.create({
    apolloAccountId: 'a1', companyName: 'Acme', website: 'https://acme.com',
    listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'found',
  });
  const contact = await Contact.create({
    companyId: company._id, listId: list._id, apolloPersonId: 'p1',
    firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com', title: 'CTO', rank: 1,
  });
  return { list, company, contact };
};

test('404 for an unknown contact', async () => {
  const res = await asDavid(request(app).post(`/api/contacts/${new mongoose.Types.ObjectId()}/hubspot`));
  assert.equal(res.status, 404);
});

test('403 for a non-owning SDR', async () => {
  const { contact } = await makeSetup();
  const res = await asKhadym(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 403);
});

test('successful push persists synced status and IDs', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => ({ status: 'synced', hubspotContactId: 'hc1', hubspotCompanyId: 'co1' });
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 200);
  assert.equal(res.body.hubspotStatus, 'synced');
  assert.equal(res.body.hubspotContactId, 'hc1');
  assert.equal(res.body.hubspotCompanyId, 'co1');
  assert.equal(res.body.hubspotSyncedBy, 'davidv@scytale.ai');
  assert.ok(res.body.hubspotSyncedAt);
});

test('already-existed push persists that status with no company id', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => ({ status: 'already_existed', hubspotContactId: 'hc-existing', hubspotCompanyId: null });
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 200);
  assert.equal(res.body.hubspotStatus, 'already_existed');
  assert.equal(res.body.hubspotContactId, 'hc-existing');
});

test('failed push persists the error and returns 502, leaving prior IDs untouched', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => { throw new Error('No HubSpot user found for davidv@scytale.ai'); };
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /No HubSpot user found/);
  const saved = await Contact.findById(contact._id);
  assert.equal(saved.hubspotStatus, 'failed');
  assert.equal(saved.hubspotError, 'No HubSpot user found for davidv@scytale.ai');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test test/hubspotRoutes.test.js`
Expected: FAIL — 404s on every request (no `/api/contacts` route mounted yet)

- [ ] **Step 3: Add the Contact model fields**

In `backend/src/models/Contact.js`, replace:

```js
    rank:           { type: Number }, // 1..4 (1 = best)
    isPrimary:      { type: Boolean, default: false },
    reasoning:      { type: String },
  },
```

with:

```js
    rank:           { type: Number }, // 1..4 (1 = best)
    isPrimary:      { type: Boolean, default: false },
    reasoning:      { type: String },

    // ── HubSpot push (manual, per-contact button) ─────────────────────────
    hubspotStatus:    { type: String, enum: ['none', 'synced', 'already_existed', 'failed'], default: 'none' },
    hubspotContactId: { type: String },
    hubspotCompanyId: { type: String },
    hubspotSyncedAt:  { type: Date },
    hubspotSyncedBy:  { type: String }, // email of whoever clicked the button
    hubspotError:     { type: String }, // last failure reason, cleared on next success
  },
```

- [ ] **Step 4: Create the route**

Create `backend/src/routes/contacts.js`:

```js
const express = require('express');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Company = require('../models/Company');
const List = require('../models/List');
const hubspotService = require('../services/hubspotService');

const router = express.Router();

router.post('/:id/hubspot', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Contact not found' });
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const company = await Company.findById(contact.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const list = await List.findById(contact.listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }

    try {
      const result = await hubspotService.pushContact(company, contact, list.assignedTo);
      contact.hubspotStatus = result.status;
      contact.hubspotContactId = result.hubspotContactId;
      if (result.hubspotCompanyId) contact.hubspotCompanyId = result.hubspotCompanyId;
      contact.hubspotSyncedAt = new Date();
      contact.hubspotSyncedBy = req.user.email;
      contact.hubspotError = undefined;
      await contact.save();
      return res.json(contact);
    } catch (err) {
      contact.hubspotStatus = 'failed';
      contact.hubspotError = err.message;
      await contact.save();
      return res.status(502).json({ error: err.message });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

- [ ] **Step 5: Mount the route**

In `backend/src/app.js`, add after the `/api/settings` line:

```js
app.use('/api/settings', require('./routes/settings'));
app.use('/api/contacts', require('./routes/contacts'));
```

- [ ] **Step 6: Require the HubSpot env vars at boot**

In `backend/server.js`, change:

```js
const REQUIRED_ENV = ['MONGODB_URI', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'APOLLO_PEOPLE_KEY', 'SESSION_SECRET'];
```

to:

```js
const REQUIRED_ENV = [
  'MONGODB_URI', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'APOLLO_PEOPLE_KEY', 'SESSION_SECRET',
  'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_REFRESH_TOKEN',
];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && node --test test/hubspotRoutes.test.js`
Expected: PASS (5 tests)

- [ ] **Step 8: Run the full backend suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS (all tests, including the new ones)

- [ ] **Step 9: Commit**

```bash
git add backend/src/models/Contact.js backend/src/routes/contacts.js backend/src/app.js backend/server.js backend/test/hubspotRoutes.test.js
git commit -m "feat(prospector): POST /api/contacts/:id/hubspot route"
```

---

### Task 4: Frontend button + docs

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/components/ContactsScreen.jsx`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `POST /api/contacts/:id/hubspot` from Task 3, returning the full updated `Contact` (including `hubspotStatus`, `hubspotContactId`, `hubspotSyncedAt`, `hubspotSyncedBy`).

- [ ] **Step 1: Add the API call**

In `frontend/src/api.js`, add after `sendDecision`:

```js
export const pushContactToHubspot = (contactId) =>
  request(`/api/contacts/${contactId}/hubspot`, { method: 'POST' });
```

- [ ] **Step 2: Add the button to `ContactCard` and wire state updates**

In `frontend/src/components/ContactsScreen.jsx`, update the imports:

```js
import { useEffect, useState } from 'react';
import { fetchContacts, fetchList, pushContactToHubspot } from '../api';
import { IconMail, IconLinkedin, IconPhone, IconStar, IconCheck } from '../icons';
import { getCompanyHref } from '../utils/companyLink';
```

Replace the `ContactCard` function with:

```js
function ContactCard({ c, onPushed }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const push = async () => {
    setBusy(true);
    setErr('');
    try {
      onPushed(await pushContactToHubspot(c._id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const synced = c.hubspotStatus === 'synced';
  const alreadyExisted = c.hubspotStatus === 'already_existed';
  const label = synced ? 'In HubSpot' : alreadyExisted ? 'Already in HubSpot' : busy ? 'Adding…' : 'Add to HubSpot';

  return (
    <div className={`contact-card${c.isPrimary ? ' primary' : ''}`}>
      {c.isPrimary && <span className="primary-ribbon"><IconStar width={12} height={12} /> Primary</span>}
      <div className="contact-head">
        <div className="avatar">{initials(c)}</div>
        <div>
          <div className="contact-name">{c.firstName} {c.lastName}</div>
          <div className="contact-title">{c.title || 'no title'}</div>
        </div>
      </div>
      {c.reasoning && <div className="contact-reason">{c.reasoning}</div>}
      <div className="contact-actions">
        {c.email
          ? <a className="chip" href={`mailto:${c.email}`}><IconMail width={14} height={14} /> Email</a>
          : <span className="chip muted">no email</span>}
        {c.linkedinUrl && <a className="chip" href={c.linkedinUrl} target="_blank" rel="noreferrer"><IconLinkedin width={14} height={14} /> LinkedIn</a>}
        {c.phone && <a className="chip" href={`tel:${c.phone}`}><IconPhone width={14} height={14} /> {c.phone}</a>}
      </div>
      <div className="contact-actions">
        <button className="btn small ghost" onClick={push} disabled={busy || synced || alreadyExisted}>
          {synced && <IconCheck width={14} height={14} />} {label}
        </button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
```

Then update the group-rendering call site (inside `ContactsScreen`'s `groups.map`) so each card can report its update back up. Replace:

```jsx
{contacts.length
  ? <div className="contacts-row">{contacts.map((c) => <ContactCard key={c._id} c={c} />)}</div>
  : <p className="muted">No decision-maker found.</p>}
```

with:

```jsx
{contacts.length
  ? <div className="contacts-row">{contacts.map((c) => (
      <ContactCard
        key={c._id}
        c={c}
        onPushed={(updated) => setGroups((prev) => prev.map((g) => ({
          ...g,
          contacts: g.contacts.map((existing) => (existing._id === updated._id ? updated : existing)),
        })))}
      />
    ))}</div>
  : <p className="muted">No decision-maker found.</p>}
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds with no errors

- [ ] **Step 4: Update `HANDOFF.md`**

In `backend/.env` needs section, add after `APOLLO_PEOPLE_KEY=...`:

```
HUBSPOT_CLIENT_ID=<HubSpot app client id>
HUBSPOT_CLIENT_SECRET=<HubSpot app client secret>
HUBSPOT_REFRESH_TOKEN=<OAuth refresh token for the connected HubSpot account>
```

In "What's built", add a bullet after the Contact sourcing bullet:

```
- **HubSpot push**: `POST /api/contacts/:id/hubspot` pushes one sourced contact (and its company, if not already there) into HubSpot under the owning SDR (owner resolved live via HubSpot's Owners API by email — fails loudly if no match, no fallback owner). Dedup by domain (company) and email/LinkedIn (contact) is checked first; an existing match is reused/reported rather than duplicated. Insert-only, no updates/deletes, no outreach-sequence enrollment (Prospector generates no outreach copy). Button lives on each contact card in the Contacts screen; state (`hubspotStatus`) persists across refresh.
```

Add a line to "Known non-blocking follow-ups":

```
- **HubSpot push has never made a live HubSpot call.** Every test injects a fake `request`, so the OAuth token exchange, owner-lookup endpoint, and object create/search endpoints are all unverified against the real API. First real run is the test, same posture contact sourcing shipped with for Apollo people search.
```

Add to "Next likely asks" (remove the now-done HubSpot line, keep the rest):

```
- Deploying it somewhere the SDR can reach without your machine running
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.js frontend/src/components/ContactsScreen.jsx HANDOFF.md
git commit -m "feat(prospector): Add to HubSpot button on the Contacts screen"
```
