# Contact Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an SDR confirms a fully-reviewed list, source up to 4 ranked decision-maker contacts per accepted company via Apollo (mirroring WOLF+), and display them in a Contacts view.

**Architecture:** A confirm-review gate locks the list's decisions and fires a background sourcing job (like a pull). The job runs WOLF+'s pipeline per accepted company — Apollo people search → bulk enrich → Claude picker — but the picker returns up to 4 ranked contacts. Contacts persist in a new collection; the list detail gains a Contacts view.

**Tech Stack:** Node/Express 5, Mongoose 9 (CommonJS), `@anthropic-ai/sdk` (Messages API), `axios` (Apollo), `node:test`+`supertest`+`mongodb-memory-server`; React 18 + Vite frontend.

## Global Constraints

- Backend CommonJS. Tests: `cd backend && node --test test/<file>`. No new dependencies. In-memory Mongo via `test/helpers/db.js`. Mock Apollo/Anthropic via dependency injection (never hit the network in tests) — follow the `pullService`/`qualifierService` deps pattern.
- WOLF+ reference: `WOLF+/The-Wolf/icp-qualifier/src/services/contactService.js`. Copy `BROAD_SEARCH_TITLES`, `EXCLUDED_TITLES`, `PROFILE_CONTEXT`, and the AI picker system prompt **verbatim** (values in Task 1).
- Apollo people endpoints (exact): search `https://api.apollo.io/api/v1/mixed_people/api_search`; bulk match `https://api.apollo.io/api/v1/people/bulk_match`. Search body: `{ per_page: 25, q_organization_domains_list: [domain], person_titles: BROAD_SEARCH_TITLES, include_similar_titles: true }`. Bulk match body: `{ details: [{id, domain}], reveal_personal_emails: true }`, batched by 10.
- Apollo people calls use `process.env.APOLLO_PEOPLE_KEY` (distinct from company-search `APOLLO_API_KEY`).
- AI picker model: `claude-haiku-4-5-20251001`.
- Scope: source **accepted** companies only (`sdrStatus: 'accepted'`). Picker returns **up to 4** ranked contacts (rank 1 = `isPrimary`), empty if none.
- Contacts without an email are still saved and shown (flagged non-emailable). Review is **locked** once confirmed.
- Out of scope: HubSpot/outreach/sequences/email-send, manual add-by-id, SDR selection among contacts, deployment/live test.
- Spec: `docs/superpowers/specs/2026-07-27-contact-sourcing-design.md`.

---

### Task 1: Contact-search config (verbatim WOLF+ constants)

**Files:**
- Create: `backend/src/config/contactFilters.js`
- Create: `backend/test/contactFilters.test.js`

**Interfaces:**
- Produces: exports `BROAD_SEARCH_TITLES` (string[]), `EXCLUDED_TITLES` (RegExp[]), `PROFILE_CONTEXT` ({icp1,icp2}), `PICKER_SYSTEM_PROMPT` (string).

- [ ] **Step 1: Write the failing test** — `backend/test/contactFilters.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cf = require('../src/config/contactFilters');

test('exports the WOLF+ contact-search constants', () => {
  assert.ok(Array.isArray(cf.BROAD_SEARCH_TITLES) && cf.BROAD_SEARCH_TITLES.includes('ceo'));
  assert.ok(cf.BROAD_SEARCH_TITLES.includes('chief technology officer'));
  assert.ok(Array.isArray(cf.EXCLUDED_TITLES) && cf.EXCLUDED_TITLES.every((r) => r instanceof RegExp));
  // sales/marketing/hr must be excluded
  assert.ok(cf.EXCLUDED_TITLES.some((r) => r.test('VP of Sales')));
  assert.ok(cf.EXCLUDED_TITLES.some((r) => r.test('Head of Marketing')));
  assert.ok(cf.PROFILE_CONTEXT.icp1 && cf.PROFILE_CONTEXT.icp2);
  assert.match(cf.PICKER_SYSTEM_PROMPT, /Scytale/);
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd backend && node --test test/contactFilters.test.js` → FAIL (module not found).

- [ ] **Step 3: Create `backend/src/config/contactFilters.js`** (copy values verbatim from WOLF+)

```js
// Copied verbatim from WOLF+ (The-Wolf/icp-qualifier/src/services/contactService.js).
const EXCLUDED_TITLES = [
  /finance|financial|accounting|accountant/i,
  /legal|counsel|attorney|lawyer/i,
  /marketing|campaign|content|author|editor|writer|copywriter|brand/i,
  /\bsales\b|business development|account executive|account manager|account director|commercial director|sales director/i,
  /human resources|people ops|\bhr\b|talent|recruiter|recruitment/i,
  /delegate|ambassador|advisor|consultant/i,
  /operations manager|office manager|admin/i,
  /customer success|customer support|support engineer/i,
  /partner|practice lead|business director/i,
];

const BROAD_SEARCH_TITLES = [
  'ceo', 'cto', 'ciso', 'coo', 'cio',
  'co-founder', 'founder', 'managing director', 'general manager',
  'chief executive officer', 'chief technology officer', 'chief information security officer',
  'chief operating officer', 'chief information officer',
  'vp engineering', 'vp technology', 'vp security', 'vp infrastructure', 'vp of cyber',
  'head of engineering', 'head of technology', 'head of security',
  'head of information security', 'head of infosec', 'head of cyber',
  'head of it', 'head of infrastructure',
  'director of engineering', 'director of technology', 'director of security',
  'director of information security', 'director of it',
  'technical director', 'engineering director', 'security director',
  'it director', 'information security manager', 'information security director',
  'compliance manager', 'compliance officer', 'compliance director',
  'security manager', 'it manager', 'infrastructure manager',
  'technical co-founder', 'director',
];

const PROFILE_CONTEXT = {
  icp1: 'Startup (1–50 employees). No dedicated security function exists yet — compliance is owned by a founder or senior technical leader. Priority order: CEO → CTO / Chief Technology Officer → Co-Founder. CISO is rare at this size but a strong signal if present.',
  icp2: 'Growth-stage company (51–250 employees). Priority order: CTO / Chief Technology Officer → CISO / Head of Security / Head of Infosec / Director of Security → Co-Founder → CEO → VP Engineering / Director of Engineering. At this size the CTO is the dominant decision-maker for compliance tooling, with CISO as the warmest lead if present.',
};

// Adapted from WOLF+: pick UP TO 4 ranked contacts instead of one.
const PICKER_SYSTEM_PROMPT = `You are a B2B sales assistant for Scytale, a compliance automation platform that helps companies achieve ISO 27001 and SOC 2 certification faster.

Your job is to pick up to 4 contacts — the people most likely to own or influence a compliance or security purchase — ranked best-first.

## Title Normalization
Before evaluating anyone, normalize their title mentally:
- "Co-CEO", "Managing Director", "Managing Partner" → treat as CEO
- "VP Engineering", "Head of Engineering", "Engineering Director" → treat as senior engineering leader
- "Head of Security", "Head of Infosec", "Director of Information Security", "VP Security" → treat as CISO-equivalent
- "Chief of Staff", "Technical Lead", "Staff Engineer" → not decision-makers, ignore
- Strip qualifiers like "Acting", "Interim", "Associate", "Assistant" and evaluate the base title

## Who to Pick
Follow the ICP priority order, best-first. Prefer candidates with an email address. Return up to 4 genuine decision-makers — fewer if fewer qualify. Do not pad the list with weak candidates.

"Director" titles require judgment:
- Director of Security / Director of Engineering / Director of Infosec → valid
- Account Director / Director of Sales / Director of Customer Success / Director of Partnerships → disqualified
- When unsure, ask: does this person own technical or security decisions? If no, skip.

## Hard Disqualify
Never pick anyone whose role is primarily: sales, marketing, HR, finance, legal, customer success, partnerships, recruiting, or account management — regardless of seniority.

## No Viable Contact
If no candidate passes the above criteria, call select_contacts with an empty array. Do not force a pick.

Always call select_contacts — never respond with plain text.`;

module.exports = { BROAD_SEARCH_TITLES, EXCLUDED_TITLES, PROFILE_CONTEXT, PICKER_SYSTEM_PROMPT };
```

- [ ] **Step 4: Run test to verify it passes** — `cd backend && node --test test/contactFilters.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add backend/src/config/contactFilters.js backend/test/contactFilters.test.js
git commit -m "feat(prospector): contact-search config (WOLF+ titles, exclusions, picker prompt)"
```

---

### Task 2: Data model — Contact, Company.contactStatus, List status + reviewConfirmedAt

**Files:**
- Create: `backend/src/models/Contact.js`
- Modify: `backend/src/models/Company.js:62` (after `sdrReviewedAt`)
- Modify: `backend/src/models/List.js:20` (status enum) and add `reviewConfirmedAt`
- Modify: `backend/test/models.test.js` (append tests)

**Interfaces:**
- Produces: `Contact` model with `{ companyId, listId, apolloPersonId, domain, firstName, lastName, title, email, linkedinUrl, phone, rank, isPrimary, reasoning }`, unique compound index `{companyId:1, apolloPersonId:1}`. `Company.contactStatus` enum `['pending','sourcing','found','none']` default `'pending'`. `List.status` adds `'sourcing'`,`'sourced'`; `List.reviewConfirmedAt: Date`.

- [ ] **Step 1: Write the failing tests** — append to `backend/test/models.test.js`

```js
test('Contact model persists ranked contact fields', async () => {
  const Contact = require('../src/models/Contact');
  const mongoose = require('mongoose');
  const companyId = new mongoose.Types.ObjectId();
  const listId = new mongoose.Types.ObjectId();
  const c = await Contact.create({
    companyId, listId, apolloPersonId: 'p1', firstName: 'Ada', lastName: 'Lovelace',
    title: 'CTO', email: 'ada@acme.com', rank: 1, isPrimary: true, reasoning: 'owns eng',
  });
  assert.equal(c.rank, 1);
  assert.equal(c.isPrimary, true);
  assert.equal(c.email, 'ada@acme.com');
});

test('Company.contactStatus defaults to pending and accepts the enum', async () => {
  const Company = require('../src/models/Company');
  const mongoose = require('mongoose');
  const c = await Company.create({ apolloAccountId: 'x-cs', companyName: 'X', listId: new mongoose.Types.ObjectId() });
  assert.equal(c.contactStatus, 'pending');
  c.contactStatus = 'sourcing'; await c.save(); assert.equal(c.contactStatus, 'sourcing');
});

test('List accepts sourcing/sourced status and reviewConfirmedAt', async () => {
  const List = require('../src/models/List');
  const l = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  assert.equal(l.status, 'sourcing');
  const when = new Date();
  l.status = 'sourced'; l.reviewConfirmedAt = when; await l.save();
  assert.equal(l.status, 'sourced');
  assert.equal(l.reviewConfirmedAt.getTime(), when.getTime());
});
```

- [ ] **Step 2: Run to verify they fail** — `cd backend && node --test test/models.test.js` → FAIL (Contact missing; enums reject).

- [ ] **Step 3a: Create `backend/src/models/Contact.js`**

```js
const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    companyId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    listId:         { type: mongoose.Schema.Types.ObjectId, ref: 'List', required: true, index: true },
    apolloPersonId: { type: String, required: true },
    domain:         { type: String },
    firstName:      { type: String },
    lastName:       { type: String },
    title:          { type: String },
    email:          { type: String }, // may be null — contact still shown
    linkedinUrl:    { type: String },
    phone:          { type: String },
    rank:           { type: Number }, // 1..4 (1 = best)
    isPrimary:      { type: Boolean, default: false },
    reasoning:      { type: String },
  },
  { timestamps: true }
);

contactSchema.index({ companyId: 1, apolloPersonId: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);
```

- [ ] **Step 3b: `backend/src/models/Company.js`** — after `sdrReviewedAt: { type: Date },` add:
```js
    contactStatus: {
      type: String,
      enum: ['pending', 'sourcing', 'found', 'none'],
      default: 'pending',
    },
```

- [ ] **Step 3c: `backend/src/models/List.js`** — extend the status enum and add the field:
```js
    status: {
      type: String,
      enum: ['pulling', 'qualifying', 'ready', 'reviewed', 'sourcing', 'sourced', 'failed'],
      default: 'pulling',
    },
```
and after `assignedTo`/`pullMode`, add: `reviewConfirmedAt: { type: Date },`

- [ ] **Step 4: Run to verify pass** — `cd backend && node --test test/models.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add backend/src/models/Contact.js backend/src/models/Company.js backend/src/models/List.js backend/test/models.test.js
git commit -m "feat(prospector): Contact model + contactStatus + list sourcing statuses"
```

---

### Task 3: Apollo people service (search + bulk match)

**Files:**
- Create: `backend/src/services/apolloPeopleService.js`
- Create: `backend/test/apolloPeopleService.test.js`

**Interfaces:**
- Produces: `domainFromWebsite(website)` → string|null; `buildSearchBody(domain)` → object; `searchCandidates(domain, deps)` → people[]; `bulkMatch(items, deps)` → Map<personId, enriched> (items = `{person:{id}, domain}[]`, batched by 10). `deps.post` injectable (defaults to axios.post) so tests never hit the network.

- [ ] **Step 1: Write the failing test** — `backend/test/apolloPeopleService.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/apolloPeopleService');

test('domainFromWebsite strips protocol and www', () => {
  assert.equal(svc.domainFromWebsite('https://www.acme.com/pricing'), 'acme.com');
  assert.equal(svc.domainFromWebsite('http://acme.io'), 'acme.io');
  assert.equal(svc.domainFromWebsite(''), null);
  assert.equal(svc.domainFromWebsite('not a url'), null);
});

test('buildSearchBody uses domain, titles, per_page 25', () => {
  const body = svc.buildSearchBody('acme.com');
  assert.equal(body.per_page, 25);
  assert.deepEqual(body.q_organization_domains_list, ['acme.com']);
  assert.equal(body.include_similar_titles, true);
  assert.ok(body.person_titles.includes('ceo'));
});

test('searchCandidates returns people via injected post', async () => {
  const post = async (url, body) => ({ data: { people: [{ id: 'p1', title: 'CTO' }] } });
  const people = await svc.searchCandidates('acme.com', { post });
  assert.equal(people.length, 1);
  assert.equal(people[0].id, 'p1');
});

test('bulkMatch batches by 10 and maps by id', async () => {
  const calls = [];
  const post = async (url, body) => {
    calls.push(body.details.length);
    return { data: { matches: body.details.map((d) => ({ id: d.id, email: `${d.id}@x.com` })) } };
  };
  const items = Array.from({ length: 23 }, (_, i) => ({ person: { id: `p${i}` }, domain: 'acme.com' }));
  const map = await svc.bulkMatch(items, { post });
  assert.deepEqual(calls, [10, 10, 3]); // three batches
  assert.equal(map.get('p0').email, 'p0@x.com');
  assert.equal(map.size, 23);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Create `backend/src/services/apolloPeopleService.js`**

```js
const axios = require('axios');
const { BROAD_SEARCH_TITLES } = require('../config/contactFilters');

const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const BULK_MATCH_URL = 'https://api.apollo.io/api/v1/people/bulk_match';

const headers = () => ({
  'X-Api-Key': process.env.APOLLO_PEOPLE_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

function domainFromWebsite(website) {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const buildSearchBody = (domain) => ({
  per_page: 25,
  q_organization_domains_list: [domain],
  person_titles: BROAD_SEARCH_TITLES,
  include_similar_titles: true,
});

async function searchCandidates(domain, deps = {}) {
  const post = deps.post || axios.post;
  const res = await post(SEARCH_URL, buildSearchBody(domain), { headers: headers(), timeout: 15000 });
  return res.data.people || [];
}

// items: [{ person: { id }, domain }]. Batches of 10. Returns Map<id, enriched>.
async function bulkMatch(items, deps = {}) {
  const post = deps.post || axios.post;
  const byId = new Map();
  for (let i = 0; i < items.length; i += 10) {
    const details = items.slice(i, i + 10).map((it) => ({ id: it.person.id, domain: it.domain }));
    const res = await post(BULK_MATCH_URL, { details, reveal_personal_emails: true }, { headers: headers(), timeout: 15000 });
    for (const m of res.data.matches || []) if (m?.id) byId.set(m.id, m);
  }
  return byId;
}

module.exports = { domainFromWebsite, buildSearchBody, searchCandidates, bulkMatch, SEARCH_URL, BULK_MATCH_URL };
```

- [ ] **Step 4: Run to verify pass** — PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/apolloPeopleService.js backend/test/apolloPeopleService.test.js
git commit -m "feat(prospector): Apollo people search + bulk-match service"
```

---

### Task 4: AI contact picker (up to 4 ranked)

**Files:**
- Create: `backend/src/services/contactService.js` (picker only in this task)
- Create: `backend/test/contactPicker.test.js`

**Interfaces:**
- Consumes: `contactFilters` (Task 1).
- Produces: `pickContacts(enrichedCandidates, company, deps = {})` → `Promise<Array<{ person, rank, isPrimary, reasoning }>>` (up to 4, ranked; empty if none). Filters `EXCLUDED_TITLES` before the AI call. `deps.createMessage(params)` injectable (defaults to the real Anthropic call) so tests never hit the API.

- [ ] **Step 1: Write the failing test** — `backend/test/contactPicker.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickContacts } = require('../src/services/contactService');

const company = { companyName: 'Acme', employees: 20, icpProfile: 'icp1' };

test('pickContacts filters excluded titles then returns ranked picks (max 4)', async () => {
  const candidates = [
    { id: 'ceo', first_name: 'A', last_name: 'A', title: 'CEO', email: 'a@x.com' },
    { id: 'cto', first_name: 'B', last_name: 'B', title: 'CTO', email: 'b@x.com' },
    { id: 'sales', first_name: 'C', last_name: 'C', title: 'VP of Sales', email: 'c@x.com' }, // excluded
  ];
  // Fake AI: returns ceo then cto, ranked.
  const createMessage = async (params) => {
    // excluded 'sales' must not be offered to the model
    assert.ok(!params.messages[0].content.includes('VP of Sales'));
    return { content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [
      { apolloPersonId: 'ceo', reasoning: 'founder owns compliance' },
      { apolloPersonId: 'cto', reasoning: 'senior technical leader' },
    ] } }] };
  };
  const picks = await pickContacts(candidates, company, { createMessage });
  assert.equal(picks.length, 2);
  assert.equal(picks[0].person.id, 'ceo');
  assert.equal(picks[0].rank, 1);
  assert.equal(picks[0].isPrimary, true);
  assert.equal(picks[1].rank, 2);
  assert.equal(picks[1].isPrimary, false);
});

test('pickContacts returns [] when AI selects none', async () => {
  const createMessage = async () => ({ content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [] } }] });
  const picks = await pickContacts([{ id: 'x', title: 'CTO' }], company, { createMessage });
  assert.deepEqual(picks, []);
});

test('pickContacts caps at 4 even if AI returns more', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: 'CTO' }));
  const createMessage = async () => ({ content: [{ type: 'tool_use', name: 'select_contacts', input: {
    contacts: cands.map((c) => ({ apolloPersonId: c.id, reasoning: 'r' })),
  } }] });
  const picks = await pickContacts(cands, company, { createMessage });
  assert.equal(picks.length, 4);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`pickContacts` not exported).

- [ ] **Step 3: Create `backend/src/services/contactService.js`** (picker portion)

```js
const Anthropic = require('@anthropic-ai/sdk');
const { EXCLUDED_TITLES, PROFILE_CONTEXT, PICKER_SYSTEM_PROMPT } = require('../config/contactFilters');

let client;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const PICKER_TOOL = {
  name: 'select_contacts',
  description: 'Select up to 4 best contacts, ranked best-first. Empty array if none qualify.',
  input_schema: {
    type: 'object',
    properties: {
      contacts: {
        type: 'array',
        description: 'Up to 4 contacts, ranked best-first.',
        items: {
          type: 'object',
          properties: {
            apolloPersonId: { type: 'string' },
            reasoning: { type: 'string', description: 'One sentence on why this person.' },
          },
          required: ['apolloPersonId', 'reasoning'],
        },
      },
    },
    required: ['contacts'],
  },
  cache_control: { type: 'ephemeral' },
};

const MAX_CONTACTS = 4;

async function pickContacts(enrichedCandidates, company, deps = {}) {
  const createMessage = deps.createMessage || ((params) => getClient().messages.create(params));

  const candidates = (enrichedCandidates || []).filter(
    (p) => p && !EXCLUDED_TITLES.some((re) => re.test(p.title || ''))
  );
  if (!candidates.length) return [];

  const list = candidates
    .map((p, i) => `${i + 1}. ID:${p.id} | ${p.first_name || ''} ${p.last_name || ''} | ${p.title || 'no title'} | email: ${p.email ? 'yes' : 'no'}`)
    .join('\n');

  const userMessage = `Company: ${company.companyName}
Employees: ${company.employees || 'Unknown'}
Profile: ${PROFILE_CONTEXT[company.icpProfile] || PROFILE_CONTEXT.icp1}

Candidates:
${list}

Pick up to 4 best contacts for Scytale to reach out to, ranked best-first.`.trim();

  const res = await createMessage({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [{ type: 'text', text: PICKER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [PICKER_TOOL],
    messages: [{ role: 'user', content: userMessage }],
  });

  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'select_contacts');
  if (!call) return [];

  const picks = [];
  for (const chosen of (call.input.contacts || []).slice(0, MAX_CONTACTS)) {
    const person = candidates.find((p) => p.id === chosen.apolloPersonId);
    if (!person) continue;
    picks.push({ person, rank: picks.length + 1, isPrimary: picks.length === 0, reasoning: chosen.reasoning });
  }
  return picks;
}

module.exports = { pickContacts };
```

- [ ] **Step 4: Run to verify pass** — PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/contactService.js backend/test/contactPicker.test.js
git commit -m "feat(prospector): AI contact picker (up to 4 ranked)"
```

---

### Task 5: Sourcing orchestrator (`sourceList`)

**Files:**
- Modify: `backend/src/services/contactService.js` (add `sourceList`)
- Create: `backend/test/contactService.test.js`

**Interfaces:**
- Consumes: `pickContacts` (Task 4), `apolloPeopleService` (Task 3), `Company`/`Contact`/`List` models, `pullService.logProgress`.
- Produces: `sourceList(listId, deps = {})` → sources accepted companies, saves ranked `Contact`s (delete-then-insert per company), sets `Company.contactStatus` (`found`/`none`), writes progress to the list, ends `List.status='sourced'` (or `'failed'` on throw). `deps` inject `{ search, bulkMatch, pick }`.

- [ ] **Step 1: Write the failing test** — `backend/test/contactService.test.js`

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const { sourceList } = require('../src/services/contactService');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

async function seedList() {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 2, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const accepted = await Company.create({ apolloAccountId: 'acc-1', companyName: 'Acme', website: 'https://acme.com', listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'sourcing' });
  const rejected = await Company.create({ apolloAccountId: 'acc-2', companyName: 'Nope', website: 'https://nope.com', listId: list._id, status: 'qualified', sdrStatus: 'rejected' });
  return { list, accepted, rejected };
}

const deps = {
  search: async () => [{ id: 'p1', title: 'CTO' }, { id: 'p2', title: 'CEO' }],
  bulkMatch: async (items) => new Map(items.map((it) => [it.person.id, { id: it.person.id, first_name: 'F', last_name: 'L', title: 'CTO', email: `${it.person.id}@acme.com`, linkedin_url: 'u' }])),
  pick: async (enriched) => enriched.slice(0, 2).map((p, i) => ({ person: p, rank: i + 1, isPrimary: i === 0, reasoning: 'r' })),
};

test('sourceList sources only accepted companies and saves ranked contacts', async () => {
  const { list, accepted, rejected } = await seedList();
  await sourceList(list._id, deps);

  const contacts = await Contact.find({ companyId: accepted._id }).sort('rank');
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].isPrimary, true);
  assert.equal(contacts[0].rank, 1);
  assert.equal(await Contact.countDocuments({ companyId: rejected._id }), 0); // rejected never sourced

  const freshAccepted = await Company.findById(accepted._id);
  assert.equal(freshAccepted.contactStatus, 'found');
  const freshList = await List.findById(list._id);
  assert.equal(freshList.status, 'sourced');
});

test('sourceList sets contactStatus none when no viable contact', async () => {
  const { list, accepted } = await seedList();
  await sourceList(list._id, { ...deps, pick: async () => [] });
  const fresh = await Company.findById(accepted._id);
  assert.equal(fresh.contactStatus, 'none');
  assert.equal(await Contact.countDocuments({ companyId: accepted._id }), 0);
});

test('sourceList sets none when the company has no domain', async () => {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai', status: 'sourcing' });
  const c = await Company.create({ apolloAccountId: 'nd', companyName: 'NoWeb', website: '', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  await sourceList(list._id, deps);
  const fresh = await Company.findById(c._id);
  assert.equal(fresh.contactStatus, 'none');
});

test('sourceList marks the list failed on a thrown error', async () => {
  const { list } = await seedList();
  await sourceList(list._id, { ...deps, search: async () => { throw new Error('apollo people down'); } });
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /apollo people down/);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`sourceList` not exported).

- [ ] **Step 3: Add `sourceList` to `backend/src/services/contactService.js`**

Add requires at top:
```js
const List = require('../models/List');
const Company = require('../models/Company');
const Contact = require('../models/Contact');
const apolloPeople = require('./apolloPeopleService');
const { logProgress } = require('./pullService');
```

Add the orchestrator (before `module.exports`):
```js
async function sourceCompany(company, list, deps) {
  const search = deps.search || apolloPeople.searchCandidates;
  const bulkMatch = deps.bulkMatch || apolloPeople.bulkMatch;
  const pick = deps.pick || pickContacts;

  const domain = apolloPeople.domainFromWebsite(company.website);
  if (!domain) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  const people = await search(domain);
  if (!people.length) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  const enrichedById = await bulkMatch(people.map((person) => ({ person, domain })));
  const enriched = people.map((p) => enrichedById.get(p.id)).filter(Boolean);
  const picks = await pick(enriched, company);

  // delete-then-insert so a re-source is clean
  await Contact.deleteMany({ companyId: company._id });
  if (!picks.length) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  await Contact.insertMany(picks.map(({ person, rank, isPrimary, reasoning }) => ({
    companyId: company._id,
    listId: list._id,
    apolloPersonId: person.id,
    domain,
    firstName: person.first_name,
    lastName: person.last_name,
    title: person.title,
    email: person.email || null,
    linkedinUrl: person.linkedin_url || null,
    phone: person.organization?.phone || null,
    rank, isPrimary, reasoning,
  })));
  await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'found' } });
  return picks.length;
}

async function sourceList(listId, deps = {}) {
  try {
    const list = await List.findById(listId);
    if (!list) throw new Error(`List ${listId} not found`);

    const accepted = await Company.find({ listId, sdrStatus: 'accepted' });
    await logProgress(listId, `Sourcing contacts for ${accepted.length} accepted companies...`);

    for (let i = 0; i < accepted.length; i++) {
      const company = accepted[i];
      await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'sourcing' } });
      const n = await sourceCompany(company, list, deps);
      await logProgress(listId, `Sourced ${i + 1}/${accepted.length}: ${company.companyName} — ${n} contact(s)`);
    }

    await List.findByIdAndUpdate(listId, { $set: { status: 'sourced' } });
    await logProgress(listId, 'Contacts ready.');
  } catch (err) {
    console.error(`[contacts] list ${listId} failed: ${err.message}`);
    await List.findByIdAndUpdate(listId, { $set: { status: 'failed', error: err.message } });
    await logProgress(listId, `Contact sourcing failed: ${err.message}`);
  }
}
```

Update the export: `module.exports = { pickContacts, sourceList };`

> Note: `sourceCompany` reads `deps.search/bulkMatch/pick` per call; that's why the Task-5 tests inject them at the `sourceList(listId, deps)` level and they thread through.

- [ ] **Step 4: Run to verify pass** — `cd backend && node --test test/contactService.test.js` → PASS (4 tests). Then run `test/contactPicker.test.js` to confirm the picker still passes.

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/contactService.js backend/test/contactService.test.js
git commit -m "feat(prospector): contact sourcing orchestrator (sourceList)"
```

---

### Task 6: Startup recovery covers `sourcing`

**Files:**
- Modify: `backend/src/services/pullService.js` (`markStaleListsFailed`)
- Modify: `backend/test/pullService.test.js` (extend the recovery test)

**Interfaces:** `markStaleListsFailed` also flips stranded `'sourcing'` lists to `'failed'`.

- [ ] **Step 1: Write the failing test** — add to `backend/test/pullService.test.js`

```js
test('markStaleListsFailed also flips sourcing lists to failed', async () => {
  await makeList({ status: 'sourcing' });
  const n = await markStaleListsFailed();
  assert.ok(n >= 1);
  assert.equal(await List.countDocuments({ status: 'sourcing' }), 0);
});
```

- [ ] **Step 2: Run to verify it fails** — the `sourcing` list survives (not flipped) → FAIL.

- [ ] **Step 3: Update `markStaleListsFailed` in `backend/src/services/pullService.js`**
```js
async function markStaleListsFailed() {
  const result = await List.updateMany(
    { status: { $in: ['pulling', 'qualifying', 'sourcing'] } },
    { $set: { status: 'failed', error: 'Server restarted mid-job' } }
  );
  return result.modifiedCount;
}
```

- [ ] **Step 4: Run to verify pass** — `cd backend && node --test test/pullService.test.js` → PASS (all, incl. the new one).

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/pullService.js backend/test/pullService.test.js
git commit -m "feat(prospector): startup recovery covers stranded sourcing lists"
```

---

### Task 7: Routes — confirm-review, decision lock, contacts read

**Files:**
- Modify: `backend/src/routes/lists.js` (add `POST /:id/confirm-review`, `GET /:id/contacts`)
- Modify: `backend/src/routes/leads.js` (lock decisions after confirm)
- Create: `backend/test/contactRoutes.test.js`

**Interfaces:**
- `POST /api/lists/:id/confirm-review` — owner-checked; list must be `reviewed`. Sets `reviewConfirmedAt`; if any accepted → status `sourcing` + fire `contactService.sourceList` (fire-and-forget) + accepted companies' `contactStatus='sourcing'`; else status `sourced`. Returns the list.
- `GET /api/lists/:id/contacts` — owner-checked; returns `[{ company, contacts[] }]` for accepted companies, contacts sorted by rank.
- `POST /api/leads/:id/decision` — `409` once the owner list's `reviewConfirmedAt` is set.

- [ ] **Step 1: Write the failing tests** — `backend/test/contactRoutes.test.js`

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const contactService = require('../src/services/contactService');
const app = require('../src/app');

// Don't fire real sourcing.
const sourceCalls = [];
contactService.sourceList = async (listId) => { sourceCalls.push(String(listId)); };

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); sourceCalls.length = 0; });

const asDavid = (req) => req.set('X-User-Email', 'davidv@scytale.ai');
const asKhadym = (req) => req.set('X-User-Email', 'khadym@scytale.ai');

const makeReviewed = async (over = {}) =>
  List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 2, assignedTo: 'davidv@scytale.ai', status: 'reviewed', ...over });

test('confirm-review on a reviewed list with accepted → sourcing + fires job', async () => {
  const list = await makeReviewed();
  await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sourcing');
  assert.ok(res.body.reviewConfirmedAt);
  assert.deepEqual(sourceCalls, [String(list._id)]);
});

test('confirm-review with zero accepted → sourced immediately, no job', async () => {
  const list = await makeReviewed();
  await Company.create({ apolloAccountId: 'r1', companyName: 'No', listId: list._id, status: 'qualified', sdrStatus: 'rejected' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sourced');
  assert.equal(sourceCalls.length, 0);
});

test('confirm-review rejects a not-fully-reviewed list (409)', async () => {
  const list = await makeReviewed({ status: 'ready' });
  const res = await asDavid(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 409);
});

test('confirm-review 403 for a non-owning SDR', async () => {
  const list = await makeReviewed();
  const res = await asKhadym(request(app).post(`/api/lists/${list._id}/confirm-review`));
  assert.equal(res.status, 403);
});

test('decision is locked (409) once review is confirmed', async () => {
  const list = await makeReviewed({ status: 'sourcing', reviewConfirmedAt: new Date() });
  const c = await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted' });
  const res = await asDavid(request(app).post(`/api/leads/${c._id}/decision`)).send({ decision: 'rejected' });
  assert.equal(res.status, 409);
});

test('GET contacts returns accepted companies with ranked contacts', async () => {
  const list = await makeReviewed({ status: 'sourced', reviewConfirmedAt: new Date() });
  const acc = await Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'found' });
  await Contact.create({ companyId: acc._id, listId: list._id, apolloPersonId: 'p2', firstName: 'B', title: 'CEO', rank: 2 });
  await Contact.create({ companyId: acc._id, listId: list._id, apolloPersonId: 'p1', firstName: 'A', title: 'CTO', rank: 1, isPrimary: true });
  const res = await asDavid(request(app).get(`/api/lists/${list._id}/contacts`));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].contacts[0].rank, 1); // sorted by rank
  assert.equal(res.body[0].contacts.length, 2);
});
```

- [ ] **Step 2: Run to verify they fail** — FAIL (routes/lock not present).

- [ ] **Step 3a: Add routes to `backend/src/routes/lists.js`**

Add near the top: `const contactService = require('../services/contactService');`
and reuse the existing ownership guard style. Add these handlers (before `module.exports`):

```js
router.post('/:id/confirm-review', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    if (list.status !== 'reviewed') {
      return res.status(409).json({ error: 'List is not fully reviewed' });
    }

    const acceptedCount = await Company.countDocuments({ listId: list._id, sdrStatus: 'accepted' });
    const update = { reviewConfirmedAt: new Date(), status: acceptedCount > 0 ? 'sourcing' : 'sourced' };
    const updated = await List.findByIdAndUpdate(list._id, { $set: update }, { new: true });

    if (acceptedCount > 0) {
      await Company.updateMany(
        { listId: list._id, sdrStatus: 'accepted' },
        { $set: { contactStatus: 'sourcing' } }
      );
      contactService.sourceList(list._id).catch((err) => console.error(`[contacts] unhandled: ${err.message}`));
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/contacts', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    const companies = await Company.find({ listId: list._id, sdrStatus: 'accepted' })
      .select('companyName website tier contactStatus')
      .sort({ companyName: 1 }).lean();
    const contacts = await Contact.find({ listId: list._id }).sort({ rank: 1 }).lean();
    const byCompany = new Map();
    for (const c of contacts) {
      const k = String(c.companyId);
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k).push(c);
    }
    res.json(companies.map((company) => ({ company, contacts: byCompany.get(String(company._id)) || [] })));
  } catch (err) {
    next(err);
  }
});
```

Add `const Contact = require('../models/Contact');` to the requires at the top of `lists.js`.

- [ ] **Step 3b: Lock decisions in `backend/src/routes/leads.js`**

After loading `ownerList` and the SDR-ownership check, before applying the decision, add:
```js
    if (ownerList?.reviewConfirmedAt) {
      return res.status(409).json({ error: 'Review already confirmed — decisions are locked' });
    }
```

- [ ] **Step 4: Run to verify pass** — `cd backend && node --test test/contactRoutes.test.js` → PASS (6 tests). Then run the whole suite: `cd backend && npm test` → all green (mind the monkeypatched `contactService.sourceList` is test-local).

- [ ] **Step 5: Commit**
```bash
git add backend/src/routes/lists.js backend/src/routes/leads.js backend/test/contactRoutes.test.js
git commit -m "feat(prospector): confirm-review + contacts routes + decision lock"
```

---

### Task 8: Frontend API client + icons

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/icons.jsx`

**Interfaces:**
- Produces: `confirmReview(id)` → `POST /api/lists/:id/confirm-review`; `fetchContacts(id)` → `GET /api/lists/:id/contacts`. New icons `IconMail`, `IconLinkedin`, `IconPhone`, `IconStar`.

- [ ] **Step 1: Add API helpers to `frontend/src/api.js`** (after `fetchLeads`)
```js
export const confirmReview = (id) => request(`/api/lists/${id}/confirm-review`, { method: 'POST' });
export const fetchContacts = (id) => request(`/api/lists/${id}/contacts`);
```

- [ ] **Step 2: Add icons to `frontend/src/icons.jsx`** (follow the existing `base`-spread pattern)
```jsx
export function IconMail(props) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}

export function IconLinkedin(props) {
  return (
    <svg {...base} {...props}>
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-11h4v1.5" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

export function IconPhone(props) {
  return (
    <svg {...base} {...props}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
    </svg>
  );
}

export function IconStar(props) {
  return (
    <svg {...base} {...props}>
      <polygon points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9" />
    </svg>
  );
}
```

- [ ] **Step 3: Verify build** — `cd frontend && npm run build` → succeeds.

- [ ] **Step 4: Commit**
```bash
git add frontend/src/api.js frontend/src/icons.jsx
git commit -m "feat(prospector): frontend confirm-review/contacts API + contact icons"
```

---

### Task 9: Frontend — confirm modal + Contacts view

**Files:**
- Modify: `frontend/src/components/ReviewScreen.jsx` (confirm flow on completion)
- Modify: `frontend/src/components/ListDetailScreen.jsx` (Contacts tab)
- Create: `frontend/src/components/ContactsScreen.jsx`
- Modify: `frontend/src/styles.css` (contact card styles)

**Interfaces:**
- Consumes: `confirmReview`, `fetchContacts`, `fetchList` from `api.js`; new icons.
- Produces: confirm modal in the review-complete state; a Contacts view (stat strip, sourcing progress, one card per accepted company with 1-4 ranked contact mini-cards).

- [ ] **Step 1: Confirm flow in `frontend/src/components/ReviewScreen.jsx`**

In the queue-empty branch (`if (!current)`), replace the panel with a confirm gate. Add `confirmReview` to the imports and a `confirming` state:
```jsx
import { fetchLeads, sendDecision, confirmReview } from '../api';
// ...add inside component state:
const [confirmed, setConfirmed] = useState(false);
const [confirmError, setConfirmError] = useState('');

// replace the body of `if (!current) { ... }`:
if (!current) {
  const accepted = done.filter((d) => d.decision === 'accepted').length;
  const rejected = done.filter((d) => d.decision === 'rejected').length;
  const doConfirm = async () => {
    setConfirmError('');
    try {
      await confirmReview(listId);
      setConfirmed(true);
      onReviewConfirmed?.(); // parent switches to Contacts view
    } catch (err) {
      setConfirmError(err.message);
    }
  };
  return (
    <div className="panel">
      <h2>Review complete 🎉</h2>
      <div className="stat-row">
        <div className="stat-card tone-green"><div className="dot" /><div><div className="num">{accepted}</div><div className="label">accepted</div></div></div>
        <div className="stat-card tone-neutral"><div className="dot" /><div><div className="num">{rejected}</div><div className="label">rejected</div></div></div>
      </div>
      <div className="modal-note">
        {accepted > 0
          ? `Confirm to lock these decisions and find contacts for the ${accepted} accepted ${accepted === 1 ? 'company' : 'companies'}.`
          : 'No accepted leads to source. Confirming just finalizes this list.'}
      </div>
      {confirmError && <p className="error">{confirmError}</p>}
      <div className="decision-row">
        <button className="btn ghost" onClick={undo} disabled={busy || !done.length || confirmed}><IconUndo /> Undo last</button>
        <button className="btn accept" onClick={doConfirm} disabled={confirmed}><IconCheck /> Confirm list review</button>
      </div>
    </div>
  );
}
```
`ReviewScreen` signature gains `onReviewConfirmed`: `export default function ReviewScreen({ listId, onBack, onReviewConfirmed }) {`.

- [ ] **Step 2: `frontend/src/components/ListDetailScreen.jsx`** — add the Contacts tab

```jsx
import { useEffect, useState } from 'react';
import { fetchList } from '../api';
import { IconArrowLeft, IconTable, IconCards } from '../icons';
import ListTable from './ListTable';
import ReviewScreen from './ReviewScreen';
import ContactsScreen from './ContactsScreen';

export default function ListDetailScreen({ listId, onBack }) {
  const [list, setList] = useState(null);
  const [mode, setMode] = useState('table');

  const load = () => fetchList(listId).then((l) => { setList(l); return l; }).catch(() => null);
  useEffect(() => { load().then((l) => { if (l && ['sourcing', 'sourced'].includes(l.status)) setMode('contacts'); }); }, [listId]);

  const sourced = list && ['sourcing', 'sourced'].includes(list.status);

  return (
    <div>
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn ghost small" onClick={onBack}><IconArrowLeft /> Lists</button>
          <strong>{list?.name || '…'}</strong>
        </div>
        <div className="segmented">
          <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}><IconTable /> Table</button>
          {!sourced && <button className={mode === 'card' ? 'active' : ''} onClick={() => setMode('card')}><IconCards /> Card review</button>}
          {sourced && <button className={mode === 'contacts' ? 'active' : ''} onClick={() => setMode('contacts')}>Contacts</button>}
        </div>
      </div>
      {mode === 'table' && <ListTable listId={listId} />}
      {mode === 'card' && <ReviewScreen listId={listId} onBack={onBack} onReviewConfirmed={() => load().then(() => setMode('contacts'))} />}
      {mode === 'contacts' && <ContactsScreen listId={listId} />}
    </div>
  );
}
```

- [ ] **Step 3: Create `frontend/src/components/ContactsScreen.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { fetchContacts, fetchList } from '../api';
import { IconMail, IconLinkedin, IconPhone, IconStar } from '../icons';

const RUNNING = ['sourcing'];
const initials = (c) => `${(c.firstName || '?')[0] || ''}${(c.lastName || '')[0] || ''}`.toUpperCase() || '?';

function ContactCard({ c }) {
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
    </div>
  );
}

export default function ContactsScreen({ listId }) {
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');

  const loadContacts = () => fetchContacts(listId).then(setGroups).catch((e) => setError(e.message));
  useEffect(() => { fetchList(listId).then(setList).catch(() => {}); loadContacts(); }, [listId]);

  const sourcing = list && RUNNING.includes(list.status);
  useEffect(() => {
    if (!sourcing) { loadContacts(); return undefined; }
    const t = setInterval(() => { fetchList(listId).then(setList).catch(() => {}); loadContacts(); }, 3000);
    return () => clearInterval(t);
  }, [sourcing, listId]);

  if (error) return <div className="panel"><p className="error">{error}</p></div>;
  if (!groups) return <p className="muted">Loading…</p>;

  const companiesWith = groups.filter((g) => g.contacts.length).length;
  const totalContacts = groups.reduce((n, g) => n + g.contacts.length, 0);
  const emailable = groups.reduce((n, g) => n + g.contacts.filter((c) => c.email).length, 0);

  return (
    <div>
      <div className="panel">
        <div className="stat-row">
          <div className="stat"><span className="num">{groups.length}</span><span className="label">accepted companies</span></div>
          <div className="stat"><span className="num">{companiesWith}</span><span className="label">with contacts</span></div>
          <div className="stat"><span className="num">{totalContacts}</span><span className="label">contacts</span></div>
          <div className="stat"><span className="num">{emailable}</span><span className="label">emailable</span></div>
        </div>
        {sourcing && (
          <>
            <p className="muted">{list.lastMessage}</p>
            <div className="progress-bar indeterminate"><div /></div>
          </>
        )}
      </div>

      {groups.map(({ company, contacts }) => (
        <div className="panel" key={company._id}>
          <div className="contacts-company-head">
            <strong>{company.companyName}</strong>
            {company.tier && <span className="badge">Tier {company.tier}</span>}
            {company.website && <a className="muted" href={company.website} target="_blank" rel="noreferrer">website</a>}
            <span className={`badge ${company.contactStatus}`}>{company.contactStatus}</span>
          </div>
          {contacts.length
            ? <div className="contacts-row">{contacts.map((c) => <ContactCard key={c._id} c={c} />)}</div>
            : <p className="muted">No decision-maker found.</p>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add styles to `frontend/src/styles.css`** (append; reuse existing tokens/vars)

```css
.modal-note { color: var(--muted); margin: 10px 0 4px; }
.contacts-company-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.contacts-row { display: flex; flex-wrap: wrap; gap: 12px; }
.contact-card { position: relative; flex: 1 1 220px; min-width: 220px; max-width: 300px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2, rgba(255,255,255,0.02)); }
.contact-card.primary { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary) inset; }
.primary-ribbon { position: absolute; top: -9px; right: 12px; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--primary); color: #fff; }
.contact-head { display: flex; align-items: center; gap: 10px; }
.avatar { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 600; background: rgba(124,111,238,0.18); color: var(--primary); }
.contact-name { font-weight: 600; }
.contact-title { color: var(--muted); font-size: 13px; }
.contact-reason { color: var(--muted); font-style: italic; font-size: 12px; margin: 8px 0; }
.contact-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--text); text-decoration: none; }
.chip.muted { color: var(--muted); opacity: 0.6; }
.badge.found { background: rgba(52,199,89,0.16); color: #34c759; }
.badge.none, .badge.sourcing { background: rgba(124,111,238,0.18); color: var(--primary); }
```
> If a referenced CSS var (e.g. `--surface-2`) doesn't exist, fall back to an existing one or a literal — check `styles.css`'s `:root` first and match the established tokens.

- [ ] **Step 5: Verify build** — `cd frontend && npm run build` → succeeds.

- [ ] **Step 6: Manual check** (no frontend test suite): as an SDR, finish reviewing a list → confirm modal appears → Confirm → Contacts tab shows sourcing progress then 1-4 cards per accepted company; primary ribbon on rank 1; email chip disabled when absent; a locked list rejects further decisions.

- [ ] **Step 7: Commit**
```bash
git add frontend/src/components/ReviewScreen.jsx frontend/src/components/ListDetailScreen.jsx frontend/src/components/ContactsScreen.jsx frontend/src/styles.css
git commit -m "feat(prospector): confirm-review modal + Contacts view"
```

---

### Task 10: Docs + env

**Files:**
- Modify: `README.md`, `HANDOFF.md`

**Interfaces:** none.

- [ ] **Step 1: Update docs** — document: the confirm-review → contact-sourcing flow; up to 4 ranked contacts per accepted company; the new `APOLLO_PEOPLE_KEY` env var (required for sourcing, separate from `APOLLO_API_KEY`); the new list statuses (`sourcing`/`sourced`) and that decisions lock on confirm; and that HubSpot/outreach remains out of scope. Add `APOLLO_PEOPLE_KEY` to any documented env/setup list.

- [ ] **Step 2: Commit**
```bash
git add README.md HANDOFF.md
git commit -m "docs(prospector): document contact sourcing + APOLLO_PEOPLE_KEY"
```

---

## Self-Review

**Spec coverage:**
- Confirm gate (modal, lock, background job, reviewed→sourcing→sourced, 0-accepted) → Tasks 2, 7, 9. ✅
- Source accepted only → Task 5 (`Company.find({sdrStatus:'accepted'})`). ✅
- WOLF+ pipeline mirrored (search/bulk_match/picker, verbatim constants, people key, haiku model) → Tasks 1, 3, 4. ✅
- Up to 4 ranked, all shown, primary = rank 1 → Tasks 4 (picker), 9 (view). ✅
- Data model (Contact, contactStatus, list statuses, reviewConfirmedAt) → Task 2. ✅
- Decision lock after confirm → Task 7. ✅
- Contacts read route + Contacts view (stat strip, sourcing progress, cards, no-email/no-contact states) → Tasks 7, 9. ✅
- Startup recovery covers sourcing → Task 6. ✅
- Env `APOLLO_PEOPLE_KEY` + docs → Task 10. ✅
- Testing per task (mocked Apollo/Anthropic via deps) → Tasks 1-7. ✅

**Placeholder scan:** none — every code step has complete code; commands have expected outcomes.

**Type consistency:** `pickContacts(enriched, company, deps)` → `[{person,rank,isPrimary,reasoning}]` consumed by `sourceCompany`; `sourceList(listId, deps)`; `confirmReview(id)`/`fetchContacts(id)`; contacts route returns `[{company, contacts[]}]` consumed verbatim by `ContactsScreen`. `Company.contactStatus` values (`pending/sourcing/found/none`) and `List.status` additions (`sourcing/sourced`) are used consistently across model, service, routes, and view.

**Cross-task note:** Task 7's route test monkeypatches `contactService.sourceList` so no real sourcing fires; the real wiring (`contactService.sourceList(list._id).catch(...)`) is exercised only in production and via Task 5's unit tests.
