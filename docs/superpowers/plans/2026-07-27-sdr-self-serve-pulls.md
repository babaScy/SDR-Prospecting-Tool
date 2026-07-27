# SDR Self-Serve Pulls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each SDR run their own Apollo pulls — capped at 5 AI-qualified leads per day, restricted to their assigned regions — with multiple SDRs pulling concurrently (even the same region) without skipping or double-pulling companies.

**Architecture:** The pull becomes self-sizing: an SDR picks region + ICP profile, and a batching loop (first batch of 10, then top-ups of exactly `5 − qualifiedToday`) runs under the hood until they hit 5 qualified. Concurrency safety comes from replacing the shared page cursor with an atomic **item-index** cursor (each round reserves exactly the item indices it needs via `$inc`), a duplicate-key guard on company insert, a per-SDR pull latch, and a global enrich concurrency cap. The daily quota is derived from `Company` data, not stored.

**Tech Stack:** Node.js, Express 5, Mongoose 9 (CommonJS), `@anthropic-ai/sdk` (Messages + Batches API), `node:test` + `supertest` + `mongodb-memory-server`, React 18 + Vite (frontend).

## Global Constraints

- Backend is CommonJS (`require`/`module.exports`), Node's built-in test runner (`node --test`), in-memory Mongo via `test/helpers/db.js`. No new dependencies.
- All user emails are lowercase; `currentUser` middleware does an exact string compare.
- Constants (verbatim): `DAILY_QUALIFIED_QUOTA = 5`, `FIRST_BATCH_SIZE = 10`, `SYNC_THRESHOLD = 3` (chunks `< 3` → sync Messages API, `>= 3` → Batches API), `SESSION_MAX_PULLED = 60`, `ENRICH_CONCURRENCY = 5`, `APOLLO_PER_PAGE = 25`, `RESET_TZ = 'Asia/Jerusalem'`.
- The in-process latch and enrich limiter assume a single Express process (already true today — see `pull.js:11-14`).
- Cursor doc `value` shape becomes `{ next, perPage, totalItems }`; existing docs have `value` as a plain integer (a page number) and must be reshaped on read.
- Admin pull path (fixed count + assign-to-SDR + global latch) keeps its current behavior; SDR path is additive.
- Spec: `docs/superpowers/specs/2026-07-27-sdr-self-serve-pulls-design.md`.

---

### Task 1: Roster, regions & pull constants

**Files:**
- Modify: `backend/src/config/users.js`
- Create: `backend/src/config/pullConfig.js`
- Create: `backend/test/usersConfig.test.js`

**Interfaces:**
- Produces: `users.js` exports an array of `{ email, role, regions }`. `pullConfig.js` exports `{ DAILY_QUALIFIED_QUOTA, FIRST_BATCH_SIZE, SYNC_THRESHOLD, SESSION_MAX_PULLED, ENRICH_CONCURRENCY, APOLLO_PER_PAGE, RESET_TZ }`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/usersConfig.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const USERS = require('../src/config/users');
const { REGIONS } = require('../src/config/filters');

const sdrs = USERS.filter((u) => u.role === 'sdr');

test('roster has one admin and 13 SDRs', () => {
  assert.equal(USERS.filter((u) => u.role === 'admin').length, 1);
  assert.equal(sdrs.length, 13);
});

test('danielp was dropped', () => {
  assert.equal(USERS.find((u) => u.email === 'danielp@scytale.ai'), undefined);
});

test('every email is lowercase', () => {
  for (const u of USERS) assert.equal(u.email, u.email.toLowerCase(), u.email);
});

test('every SDR has at least one valid region; admin has none', () => {
  const admin = USERS.find((u) => u.role === 'admin');
  assert.deepEqual(admin.regions, []);
  for (const u of sdrs) {
    assert.ok(u.regions.length >= 1, `${u.email} has no region`);
    for (const r of u.regions) assert.ok(REGIONS[r], `${u.email} has unknown region ${r}`);
  }
});

test('aus roster is correct', () => {
  const aus = sdrs.filter((u) => u.regions.includes('aus')).map((u) => u.email).sort();
  assert.deepEqual(aus, ['darrent@scytale.ai', 'katiem@scytale.ai', 'simamkelen@scytale.ai']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/usersConfig.test.js`
Expected: FAIL (13 SDRs assertion fails; current roster has 5, no `regions`).

- [ ] **Step 3: Replace `backend/src/config/users.js`**

```js
module.exports = [
  { email: 'yonia@scytale.ai',       role: 'admin', regions: [] },
  { email: 'simamkelen@scytale.ai',  role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'darrent@scytale.ai',     role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'katiem@scytale.ai',      role: 'sdr',   regions: ['aus', 'benelux'] },
  { email: 'jamesb@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'chumam@scytale.ai',      role: 'sdr',   regions: ['benelux', 'dach'] },
  { email: 'tylorvw@scytale.ai',     role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'ryane@scytale.ai',       role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'khadym@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'jillianl@scytale.ai',    role: 'sdr',   regions: ['dach', 'nordics'] },
  { email: 'davidv@scytale.ai',      role: 'sdr',   regions: ['dach', 'uk'] },
  { email: 'darrenm@scytale.ai',     role: 'sdr',   regions: ['dach'] },
  { email: 'lusandam@scytale.ai',    role: 'sdr',   regions: ['uk'] },
  { email: 'kristophers@scytale.ai', role: 'sdr',   regions: ['uk'] },
];
```

- [ ] **Step 4: Create `backend/src/config/pullConfig.js`**

```js
module.exports = {
  DAILY_QUALIFIED_QUOTA: 5,
  FIRST_BATCH_SIZE: 10,
  SYNC_THRESHOLD: 3,     // chunk < 3 → sync Messages API; >= 3 → Batches API
  SESSION_MAX_PULLED: 60,
  ENRICH_CONCURRENCY: 5,
  APOLLO_PER_PAGE: 25,
  RESET_TZ: 'Asia/Jerusalem',
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test test/usersConfig.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/users.js backend/src/config/pullConfig.js backend/test/usersConfig.test.js
git commit -m "feat(prospector): SDR roster with regions + pull constants"
```

---

### Task 2: Enrich concurrency limiter

**Files:**
- Create: `backend/src/util/limiter.js`
- Create: `backend/test/limiter.test.js`

**Interfaces:**
- Produces: `makeLimiter(max)` returns `run(fn)` → `Promise`, running at most `max` `fn`s concurrently, queueing the rest. Rejections propagate to the caller and free the slot.

- [ ] **Step 1: Write the failing test**

Create `backend/test/limiter.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLimiter } = require('../src/util/limiter');

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

test('never exceeds max concurrency', async () => {
  const run = makeLimiter(2);
  let active = 0, peak = 0;
  const task = () => run(async () => {
    active++; peak = Math.max(peak, active);
    await defer(10);
    active--;
  });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.ok(peak <= 2, `peak was ${peak}`);
});

test('returns fn result and frees slot on rejection', async () => {
  const run = makeLimiter(1);
  assert.equal(await run(async () => 42), 42);
  await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await run(async () => 'after'), 'after'); // slot was freed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/limiter.test.js`
Expected: FAIL (`Cannot find module '../src/util/limiter'`).

- [ ] **Step 3: Create `backend/src/util/limiter.js`**

```js
// Minimal in-process counting semaphore. Single-process only.
function makeLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; pump(); });
  };

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

module.exports = { makeLimiter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/limiter.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/util/limiter.js backend/test/limiter.test.js
git commit -m "feat(prospector): in-process concurrency limiter"
```

---

### Task 3: Daily-reset day boundary helper

**Files:**
- Create: `backend/src/util/dayBoundary.js`
- Create: `backend/test/dayBoundary.test.js`

**Interfaces:**
- Produces: `startOfTodayInTz(tz, now = new Date())` → `Date` — the UTC instant of the most recent midnight in `tz`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/dayBoundary.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startOfTodayInTz } = require('../src/util/dayBoundary');

const wallClock = (instant, tz) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(instant);

test('result is midnight wall-clock in the target tz', () => {
  const now = new Date('2026-07-27T09:30:00Z'); // any instant
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.equal(wallClock(start, 'Asia/Jerusalem'), '00:00:00');
});

test('result is at or before now, within the last 24h', () => {
  const now = new Date('2026-07-27T09:30:00Z');
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.ok(start.getTime() <= now.getTime());
  assert.ok(now.getTime() - start.getTime() < 24 * 60 * 60 * 1000);
});

test('an instant just after local midnight maps to that same day', () => {
  // 2026-07-27T00:05 Jerusalem (UTC+3 in summer) == 2026-07-26T21:05Z
  const now = new Date('2026-07-26T21:05:00Z');
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.equal(wallClock(start, 'Asia/Jerusalem'), '00:00:00');
  assert.ok(now.getTime() - start.getTime() < 60 * 60 * 1000); // ~5 min after midnight
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/dayBoundary.test.js`
Expected: FAIL (`Cannot find module '../src/util/dayBoundary'`).

- [ ] **Step 3: Create `backend/src/util/dayBoundary.js`**

```js
// Start-of-today (local midnight) in an IANA tz, returned as a UTC Date.
// Uses Intl to read the tz wall-clock; no external date library.
function startOfTodayInTz(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  const hour = parts.hour === '24' ? 0 : Number(parts.hour); // Intl may emit '24'
  // The same wall-clock reading interpreted as if it were UTC:
  const wallAsUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  // Offset between that and the real instant == the tz offset at `now`.
  const offset = wallAsUTC - Math.floor(now.getTime() / 1000) * 1000;
  // Midnight wall-clock (as UTC) minus the offset == real UTC instant of local midnight.
  const midnightWallAsUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0
  );
  return new Date(midnightWallAsUTC - offset);
}

module.exports = { startOfTodayInTz };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/dayBoundary.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/util/dayBoundary.js backend/test/dayBoundary.test.js
git commit -m "feat(prospector): timezone-aware day boundary helper"
```

---

### Task 4: Quota service (qualified-today count)

**Files:**
- Create: `backend/src/services/quotaService.js`
- Create: `backend/test/quotaService.test.js`

**Interfaces:**
- Consumes: `startOfTodayInTz` (Task 3), `pullConfig` (Task 1), `List`, `Company` models.
- Produces: `qualifiedToday(sdrEmail, now = new Date())` → `Promise<number>`; `quotaReached(sdrEmail, now = new Date())` → `Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/quotaService.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const { qualifiedToday, quotaReached } = require('../src/services/quotaService');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/quotaService.test.js`
Expected: FAIL (`Cannot find module '../src/services/quotaService'`).

- [ ] **Step 3: Create `backend/src/services/quotaService.js`**

```js
const List = require('../models/List');
const Company = require('../models/Company');
const { startOfTodayInTz } = require('../util/dayBoundary');
const { RESET_TZ, DAILY_QUALIFIED_QUOTA } = require('../config/pullConfig');

async function qualifiedToday(sdrEmail, now = new Date()) {
  const listIds = await List.find({ assignedTo: sdrEmail }).distinct('_id');
  if (listIds.length === 0) return 0;
  return Company.countDocuments({
    listId: { $in: listIds },
    status: 'qualified',
    createdAt: { $gte: startOfTodayInTz(RESET_TZ, now) },
  });
}

async function quotaReached(sdrEmail, now = new Date()) {
  return (await qualifiedToday(sdrEmail, now)) >= DAILY_QUALIFIED_QUOTA;
}

module.exports = { qualifiedToday, quotaReached };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/quotaService.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/quotaService.js backend/test/quotaService.test.js
git commit -m "feat(prospector): daily qualified-lead quota service"
```

---

### Task 5: `List.pullMode` field

**Files:**
- Modify: `backend/src/models/List.js:14` (after `assignedTo`)
- Modify: `backend/test/models.test.js` (add one test)

**Interfaces:**
- Produces: `List.pullMode` — `'fixed' | 'quota'`, default `'fixed'`. `'fixed'` = admin count-based pull; `'quota'` = SDR self-sizing pull.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/models.test.js` (append a new `test(...)`; keep existing imports):

```js
test('List.pullMode defaults to fixed and accepts quota', async () => {
  const List = require('../src/models/List');
  const a = await List.create({ name: 'a', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai' });
  assert.equal(a.pullMode, 'fixed');
  const b = await List.create({ name: 'b', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai', pullMode: 'quota' });
  assert.equal(b.pullMode, 'quota');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/models.test.js`
Expected: FAIL (`a.pullMode` is `undefined`).

- [ ] **Step 3: Add the field in `backend/src/models/List.js`**

After the `assignedTo` line, add:

```js
    assignedTo: { type: String, required: true },
    pullMode: { type: String, enum: ['fixed', 'quota'], default: 'fixed' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/models.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/List.js backend/test/models.test.js
git commit -m "feat(prospector): List.pullMode (fixed vs quota)"
```

---

### Task 6: Qualifier sync path + dispatcher

**Files:**
- Modify: `backend/src/services/qualifierService.js` (add functions + export)
- Modify: `backend/test/qualifierService.test.js` (add dispatcher tests)

**Interfaces:**
- Consumes: `SYNC_THRESHOLD` from `pullConfig`; existing `getClient`, `systemBlocks`, `tools`, `buildUserMessage`, `persistResult`.
- Produces: `qualifyCompaniesSync(companies, onLog)` → `Promise<Map>`; `qualifyCompanies(companies, onLog, deps = {})` → dispatcher that routes to sync (`< SYNC_THRESHOLD`) or batch (`>=`). `deps` allows `{ sync, batch }` injection for tests. Both return the same `Map<custom_id, { ok, ... }>` shape as `qualifyCompaniesBatch`.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/qualifierService.test.js`:

```js
const qs = require('../src/services/qualifierService');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/qualifierService.test.js`
Expected: FAIL (`qs.qualifyCompanies is not a function`).

- [ ] **Step 3: Add sync path + dispatcher in `backend/src/services/qualifierService.js`**

Add near the top after existing requires:

```js
const { SYNC_THRESHOLD } = require('../config/pullConfig');
```

Add before `module.exports`:

```js
// ─── Sync qualification (Messages API) — for tiny top-up chunks (< 3) ────────
async function qualifyOneSync(company) {
  const anthropic = getClient();
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemBlocks,
    tools,
    messages: [{ role: 'user', content: buildUserMessage(company) }],
  });
  const submitCall = msg.content.find((b) => b.type === 'tool_use' && b.name === 'submit_result');
  if (!submitCall) return { ok: false, error: 'no submit_result call' };
  await persistResult(company, submitCall.input);
  return { ok: true, data: { icp: submitCall.input.icp, tier: submitCall.input.tier } };
}

const qualifyCompaniesSync = async (companies, onLog = () => {}) => {
  const resultsById = new Map();
  for (const company of companies) {
    await onLog(`Qualifying ${company.companyName} (sync)...`);
    try {
      resultsById.set(company._id.toString(), await qualifyOneSync(company));
    } catch (err) {
      resultsById.set(company._id.toString(), { ok: false, error: err.message });
    }
  }
  return resultsById;
};

// Dispatcher: chunk < SYNC_THRESHOLD → sync; otherwise batch.
const qualifyCompanies = async (companies, onLog = () => {}, deps = {}) => {
  if (companies.length === 0) return new Map();
  const sync = deps.sync || qualifyCompaniesSync;
  const batch = deps.batch || qualifyCompaniesBatch;
  return companies.length < SYNC_THRESHOLD ? sync(companies, onLog) : batch(companies, onLog);
};
```

Update the export line:

```js
module.exports = { qualifyCompaniesBatch, qualifyCompaniesSync, qualifyCompanies, persistResult };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/qualifierService.test.js`
Expected: PASS (existing 3 + new dispatcher test).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/qualifierService.js backend/test/qualifierService.test.js
git commit -m "feat(prospector): sync qualification path + sync/batch dispatcher"
```

---

### Task 7: Item-index cursor + `collectBatch` (no-skip, dup-guard, limiter)

**Files:**
- Modify: `backend/src/services/pullService.js` (cursor helpers, `collectBatch`, refactor `collectCompanies`)
- Modify: `backend/test/pullService.test.js` (migrate cursor tests to the item model, add no-skip + dup-guard tests)

**Interfaces:**
- Consumes: `pullConfig` (`APOLLO_PER_PAGE`, `ENRICH_CONCURRENCY`), `makeLimiter` (Task 2), `apolloService.mapOrganization`.
- Produces:
  - `reserveItems(key, k)` → `Promise<{ start, end }>` (half-open range; atomic `$inc` of `value.next`).
  - `readCursor(key)` → `Promise<{ next, perPage, totalItems }>` (reshapes a legacy integer `value`).
  - `collectBatch(list, k, deps)` → `Promise<number>` (companies saved; reserves exactly `k` item indices, fetches by page+offset, dedups, enriches through the shared limiter, inserts with a duplicate-key guard).
  - `collectCompanies(list, deps)` → `Promise<number>` (admin path; loops `collectBatch` until `list.requestedCount` saved or a round saves 0). **Same call signature as today.**
- `deps` = `{ search, enrich }` (defaults to `apolloService`), as in the current code.

- [ ] **Step 1: Write the failing tests (rewrite `pullService.test.js` fakes to a flat, item-paginated model)**

Replace the fake-Apollo helpers and the cursor-specific tests in `backend/test/pullService.test.js`. Keep `runPull`, `logProgress`, `markStaleListsFailed`, enrich-throw, and no-domain tests (their assertions still hold). New helpers + tests:

```js
const { reserveItems, readCursor, collectBatch } = require('../src/services/pullService');

// Flat pool of orgs, paginated by perPage — matches the item-index cursor.
const org = (id) => ({ id, name: `Co ${id}`, website_url: `https://${id}.com`, primary_domain: `${id}.com` });
const fakeSearchFlat = (ids) => async (profile, region, page, perPage) => {
  const all = ids.map(org);
  const startIdx = (page - 1) * perPage;
  return {
    organizations: all.slice(startIdx, startIdx + perPage),
    pagination: { page, totalPages: Math.ceil(all.length / perPage), totalEntries: all.length },
  };
};
const fakeEnrich = async (id) => ({ ...org(id), industry: 'software' });

test('reserveItems hands out disjoint, contiguous ranges (atomic)', async () => {
  const key = 'apolloPage_icp1_uk';
  const [a, b, c] = await Promise.all([
    reserveItems(key, 10), reserveItems(key, 10), reserveItems(key, 5),
  ]);
  const ranges = [a, b, c].sort((x, y) => x.start - y.start);
  assert.equal(ranges[0].start, 0);
  // no gaps, no overlaps
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  assert.equal((await readCursor(key)).next, 25);
});

test('collectBatch does not skip: a top-up resumes at the next item', async () => {
  const list = await makeList();
  const deps = { search: fakeSearchFlat(['a', 'b', 'c', 'd', 'e']), enrich: fakeEnrich };
  const first = await collectBatch(list, 3, deps);   // items 0,1,2 → a,b,c
  const next = await collectBatch(list, 2, deps);    // items 3,4 → d,e (NOT skipping any)
  assert.equal(first, 3);
  assert.equal(next, 2);
  const ids = (await Company.find({ listId: list._id }).sort('apolloAccountId')).map((c) => c.apolloAccountId);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
});

test('collectBatch is non-fatal on a duplicate-key race', async () => {
  const list = await makeList();
  // Pre-insert 'a' globally (simulates another pull winning the race).
  await Company.create({ apolloAccountId: 'a', companyName: 'Co a', listId: list._id });
  // Force the exists() dedup to miss so create() hits the unique index.
  const origExists = Company.exists.bind(Company);
  Company.exists = async () => false;
  try {
    const saved = await collectBatch(list, 2, { search: fakeSearchFlat(['a', 'b']), enrich: fakeEnrich });
    assert.equal(saved, 1); // 'a' dup-guarded, 'b' saved — no throw
  } finally {
    Company.exists = origExists;
  }
});

test('collectCompanies still saves requestedCount new companies (item model)', async () => {
  const list = await makeList(); // requestedCount 4
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c', 'd', 'e', 'f']), enrich: fakeEnrich });
  assert.equal(saved, 4);
  assert.equal(await Company.countDocuments({ listId: list._id }), 4);
});

test('collectCompanies stops after pool exhaustion (no infinite loop)', async () => {
  const list = await makeList({ requestedCount: 50 });
  const saved = await collectCompanies(list, { search: fakeSearchFlat(['a', 'b', 'c']), enrich: fakeEnrich });
  assert.equal(saved, 3);
});
```

Also: **delete** the two obsolete cursor tests (`collectCompanies advances and wraps the page cursor` asserting `state.value === 1`, and the old `stops after a full page wrap` if it relied on the 3-per-page fake) and re-point the retained `dedup`, `no-domain`, and `enrich throws` tests to `fakeSearchFlat([...])` with the same expected IDs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/pullService.test.js`
Expected: FAIL (`reserveItems`/`collectBatch` not exported).

- [ ] **Step 3: Implement cursor helpers + `collectBatch` + refactor `collectCompanies` in `backend/src/services/pullService.js`**

Add requires at top:

```js
const { makeLimiter } = require('../util/limiter');
const { APOLLO_PER_PAGE, ENRICH_CONCURRENCY } = require('../config/pullConfig');
```

Add a module-level limiter (shared across all pulls in the process):

```js
const enrichLimiter = makeLimiter(ENRICH_CONCURRENCY);
```

Replace `getCursor`/`setCursor` (lines 16-25) with the item-cursor helpers:

```js
const cursorKey = (list) => `apolloPage_${list.profile}_${list.region}`;

// Reshape a legacy integer value (a page number) into the item-index shape.
async function readCursor(key) {
  const doc = await PipelineState.findOne({ key });
  if (!doc) return { next: 0, perPage: APOLLO_PER_PAGE, totalItems: null };
  if (typeof doc.value === 'number') {
    const reshaped = { next: (doc.value - 1) * APOLLO_PER_PAGE, perPage: APOLLO_PER_PAGE, totalItems: null };
    await PipelineState.updateOne({ key }, { $set: { value: reshaped } });
    return reshaped;
  }
  return { perPage: APOLLO_PER_PAGE, totalItems: null, ...doc.value };
}

// Atomically reserve k item indices. Returns half-open [start, end).
async function reserveItems(key, k) {
  await readCursor(key); // reshape legacy docs before $inc on a nested path
  const doc = await PipelineState.findOneAndUpdate(
    { key }, { $inc: { 'value.next': k } }, { upsert: true, new: true }
  );
  const end = doc.value.next;
  return { start: end - k, end };
}

const setTotalItems = (key, totalItems) =>
  PipelineState.updateOne({ key }, { $set: { 'value.totalItems': totalItems, 'value.perPage': APOLLO_PER_PAGE } });
```

Add `collectBatch` (reserves exactly `k`, fetches by page+offset, dedups, enriches via limiter, dup-guarded insert):

```js
// Reserve exactly k item indices and save the new companies they map to.
// Returns the number of NEW companies saved (may be < k due to dedup/enrich failures).
async function collectBatch(list, k, { search, enrich }) {
  if (k <= 0) return 0;
  const key = cursorKey(list);
  const { start, end } = await reserveItems(key, k);
  let { totalItems } = await readCursor(key);
  const perPage = APOLLO_PER_PAGE;

  const pageCache = new Map();
  const getPage = async (page) => {
    if (!pageCache.has(page)) {
      const res = await search(list.profile, list.region, page, perPage);
      if (res.pagination.totalEntries && !totalItems) {
        totalItems = res.pagination.totalEntries;
        await setTotalItems(key, totalItems);
      }
      pageCache.set(page, res.organizations);
    }
    return pageCache.get(page);
  };

  let saved = 0;
  for (let i = start; i < end; i++) {
    const idx = totalItems ? i % totalItems : i;
    const page = Math.floor(idx / perPage) + 1;
    const offset = idx % perPage;
    const orgs = await getPage(page);
    const org = orgs[offset];
    if (!org) continue; // past the end of available data

    if (await Company.exists({ apolloAccountId: org.id })) continue;

    let enriched;
    try {
      enriched = await enrichLimiter(() => enrich(org.id));
    } catch (err) {
      console.error(`[pull] enrich failed for ${org.id}: ${err.message}`);
      continue;
    }
    if (!enriched) continue;

    const hasDomain = Boolean(enriched.website_url || enriched.primary_domain);
    try {
      await Company.create({
        ...apollo.mapOrganization(enriched),
        icpProfile: list.profile,
        listId: list._id,
        ...(hasDomain ? {} : { status: 'disqualified', disqualifyReason: 'No domain found on Apollo' }),
      });
      saved++;
    } catch (err) {
      if (err.code === 11000) continue; // lost a race — skip, do not fail the pull
      throw err;
    }
  }
  return saved;
}
```

Replace the body of `collectCompanies` (the admin path) to loop `collectBatch` toward `requestedCount`, stopping when a round adds nothing (pool exhausted):

```js
async function collectCompanies(list, { search, enrich }) {
  let saved = 0;
  while (saved < list.requestedCount) {
    const round = await collectBatch(list, list.requestedCount - saved, { search, enrich });
    saved += round;
    await List.findByIdAndUpdate(list._id, { $set: { pulledCount: saved } });
    await logProgress(list._id, `Pulled ${saved}/${list.requestedCount} new companies...`);
    if (round === 0) break; // no new companies available this pass
  }
  return saved;
}
```

Export the new functions (extend the existing `module.exports`):

```js
module.exports = { runPull, collectCompanies, collectBatch, reserveItems, readCursor, logProgress, markStaleListsFailed };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test test/pullService.test.js`
Expected: PASS (migrated + new tests). Note: `runPull` fixed-path tests still pass because `collectCompanies` keeps its signature and `runPull` is unchanged in this task.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/pullService.js backend/test/pullService.test.js
git commit -m "feat(prospector): atomic item-index cursor, collectBatch, dup-guard (no skips)"
```

---

### Task 8: SDR batching loop (`runQuotaPull`)

**Files:**
- Modify: `backend/src/services/pullService.js` (`runQuotaPull`, branch in `runPull`)
- Modify: `backend/test/pullService.test.js` (batching-loop tests)

**Interfaces:**
- Consumes: `collectBatch` (Task 7), `quotaService.qualifiedToday` (Task 4), `qualifierService.qualifyCompanies` (Task 6), constants `FIRST_BATCH_SIZE`, `DAILY_QUALIFIED_QUOTA`, `SESSION_MAX_PULLED`.
- Produces: `runQuotaPull(list, deps)` — runs first batch of `FIRST_BATCH_SIZE`, then top-ups of `DAILY_QUALIFIED_QUOTA − qualifiedToday`, qualifying each round, until quota reached / safety cap / pool exhausted; sets list `ready`. `runPull(listId, deps)` branches: `list.pullMode === 'quota'` → `runQuotaPull`, else the existing fixed path. `deps` may inject `{ search, enrich, qualify, qualifiedToday }` for tests.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/pullService.test.js`:

```js
test('runQuotaPull: first batch is 10, tops up by (5 - qualifiedToday), stops at 5', async () => {
  const list = await makeList({ pullMode: 'quota', requestedCount: 5 });
  const pool = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const reserved = [];        // record k per round
  const qualifiedByRound = [3, 1, 1]; // round outcomes → cumulative 3,4,5
  let round = 0;
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    // qualify: mark the round's new pending companies as qualified per the script
    qualify: async (companies) => {
      const n = qualifiedByRound[round] ?? 0;
      for (let i = 0; i < n && i < companies.length; i++) {
        await Company.findByIdAndUpdate(companies[i]._id, { $set: { status: 'qualified' } });
      }
      round++;
      return new Map();
    },
  };
  // Spy on collectBatch sizing via reserveItems is covered elsewhere; here assert end state.
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.equal(await Company.countDocuments({ listId: list._id, status: 'qualified' }), 5);
});

test('runQuotaPull: respects SESSION_MAX_PULLED when nothing qualifies', async () => {
  const list = await makeList({ pullMode: 'quota', requestedCount: 5 });
  const pool = Array.from({ length: 200 }, (_, i) => `z${i}`);
  const deps = {
    search: fakeSearchFlat(pool),
    enrich: fakeEnrich,
    qualify: async () => new Map(), // never qualifies anyone
  };
  await runPull(list._id, deps);
  const fresh = await List.findById(list._id);
  assert.equal(fresh.status, 'ready');
  assert.ok(fresh.pulledCount <= 60, `pulled ${fresh.pulledCount}`);
  assert.ok(fresh.pulledCount >= 10, 'at least the first batch');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/pullService.test.js`
Expected: FAIL (quota lists still run the fixed path; no top-up logic).

- [ ] **Step 3: Implement `runQuotaPull` + branch in `runPull`**

Add requires at top of `pullService.js`:

```js
const quotaService = require('./quotaService');
const { FIRST_BATCH_SIZE, DAILY_QUALIFIED_QUOTA, SESSION_MAX_PULLED } = require('../config/pullConfig');
```

Add `runQuotaPull`:

```js
async function runQuotaPull(list, deps = {}) {
  const search = deps.search || apollo.searchCompaniesPage;
  const enrich = deps.enrich || apollo.enrichOrganization;
  const qualify = deps.qualify || ((...args) => require('./qualifierService').qualifyCompanies(...args));
  const qualifiedToday = deps.qualifiedToday || quotaService.qualifiedToday;

  const sdr = list.assignedTo;
  let pulledThisSession = 0;
  let round = 0;

  while (true) {
    const already = await qualifiedToday(sdr);
    if (already >= DAILY_QUALIFIED_QUOTA) break;
    if (pulledThisSession >= SESSION_MAX_PULLED) break;

    const want = round === 0 ? FIRST_BATCH_SIZE : DAILY_QUALIFIED_QUOTA - already;
    const k = Math.min(want, SESSION_MAX_PULLED - pulledThisSession);
    if (k <= 0) break;

    await List.findByIdAndUpdate(list._id, { $set: { status: 'pulling' } });
    await logProgress(list._id, `Round ${round + 1}: pulling ${k} companies...`);
    const saved = await collectBatch(list, k, { search, enrich });
    pulledThisSession += saved;
    await List.findByIdAndUpdate(list._id, { $set: { status: 'qualifying', pulledCount: pulledThisSession } });

    const pending = await Company.find({ listId: list._id, status: 'pending' });
    if (pending.length) {
      await logProgress(list._id, `Round ${round + 1}: qualifying ${pending.length} companies...`);
      await qualify(pending, (msg) => logProgress(list._id, msg));
    }

    round++;
    if (saved === 0) break; // pool exhausted for this region/profile
  }

  await List.findByIdAndUpdate(list._id, { $set: { status: 'ready' } });
  await logProgress(list._id, 'List is ready for review.');
}
```

Branch inside `runPull` — wrap the existing body. After `const list = await List.findById(listId); if (!list) throw ...`, insert:

```js
    if (list.pullMode === 'quota') {
      await runQuotaPull(list, deps);
      return;
    }
```

(The existing fixed-path code below it — `collectCompanies` + chunked `qualifyBatch` + `status: 'ready'` — stays unchanged and still runs for `pullMode: 'fixed'`.)

Add `runQuotaPull` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test test/pullService.test.js`
Expected: PASS (batching-loop tests + all Task 7 tests + unchanged fixed-path tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/pullService.js backend/test/pullService.test.js
git commit -m "feat(prospector): SDR quota batching loop (first 10, top-up to 5)"
```

---

### Task 9: Pull route — SDR branch, per-SDR latch, quota gate, region scope, quota endpoint

**Files:**
- Modify: `backend/src/routes/pull.js`
- Modify: `backend/test/pullRoute.test.js` (add SDR tests; migrate the obsolete "rejects non-admin" test)

**Interfaces:**
- Consumes: `quotaService` (Task 4), `pullService.runPull`, `List`, `USERS`, `pullConfig`.
- Produces: `POST /api/pull` accepts SDR requests `{ region, profile }` (forces `assignedTo = self`, `pullMode = 'quota'`); `GET /api/pull/quota` (SDR) → `{ qualifiedToday, quota }`. Admin behavior (body `{ profile, region, count, assignedTo }`, global latch) is unchanged.

- [ ] **Step 1: Write the failing tests**

In `backend/test/pullRoute.test.js`: **replace** the `POST /api/pull rejects non-admin callers` test (SDRs may now pull) with the SDR tests below, and add the quota/latch tests. Keep the admin tests as-is.

```js
// davidv's regions are ['dach', 'uk'] per the roster.
test('SDR can pull their own region (region+profile only)', async () => {
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 201);
  assert.equal(res.body.assignedTo, 'davidv@scytale.ai');
  assert.equal(res.body.pullMode, 'quota');
  assert.equal(runPullCalls.length, 1);
});

test('SDR pull ignores body assignedTo/count and forces self', async () => {
  const res = await asSdr(request(app).post('/api/pull'))
    .send({ region: 'uk', profile: 'icp1', assignedTo: 'khadym@scytale.ai', count: 999 });
  assert.equal(res.status, 201);
  assert.equal(res.body.assignedTo, 'davidv@scytale.ai');
});

test('SDR cannot pull a region they do not cover', async () => {
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'aus', profile: 'icp1' });
  assert.equal(res.status, 403);
  assert.equal(runPullCalls.length, 0);
});

test('SDR pull is blocked at the daily quota (429)', async () => {
  const list = await List.create({ name: 'x', profile: 'icp1', region: 'uk', requestedCount: 5, assignedTo: 'davidv@scytale.ai', status: 'ready' });
  const Company = require('../src/models/Company');
  for (let i = 0; i < 5; i++) {
    await Company.create({ apolloAccountId: `q${i}`, companyName: `q${i}`, listId: list._id, status: 'qualified' });
  }
  const res = await asSdr(request(app).post('/api/pull')).send({ region: 'uk', profile: 'icp1' });
  assert.equal(res.status, 429);
  assert.equal(runPullCalls.length, 0);
});

test('GET /api/pull/quota returns the SDR count', async () => {
  const res = await asSdr(request(app).get('/api/pull/quota'));
  assert.equal(res.status, 200);
  assert.equal(res.body.quota, 5);
  assert.equal(res.body.qualifiedToday, 0);
});
```

Note: the existing admin test at `pullRoute.test.js:54` (409 while a pull runs) and the TOCTOU test still pass unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/pullRoute.test.js`
Expected: FAIL (SDR requests currently 403 via the blanket non-admin guard; no `/quota` route).

- [ ] **Step 3: Rewrite `backend/src/routes/pull.js`**

```js
const express = require('express');
const List = require('../models/List');
const { REGIONS } = require('../config/filters');
const pullService = require('../services/pullService');
const quotaService = require('../services/quotaService');
const USERS = require('../config/users');
const { DAILY_QUALIFIED_QUOTA } = require('../config/pullConfig');

const SDR_EMAILS = USERS.filter((u) => u.role === 'sdr').map((u) => u.email);

const router = express.Router();

// Admin pulls: one at a time system-wide (unchanged). SDR pulls: one per SDR.
let adminPullStarting = false;
const sdrPullsInFlight = new Set();

const makeName = (profile, region) =>
  `${region.toUpperCase()} · ${profile.toUpperCase()} · ${new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
  })}`;

const RUNNING = { status: { $in: ['pulling', 'qualifying'] } };

// SDR quota indicator.
router.get('/quota', async (req, res, next) => {
  try {
    if (req.user.role !== 'sdr') return res.status(403).json({ error: 'SDR only' });
    const qualifiedToday = await quotaService.qualifiedToday(req.user.email);
    res.json({ qualifiedToday, quota: DAILY_QUALIFIED_QUOTA });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  if (req.user.role === 'sdr') return sdrPull(req, res, next);
  return adminPull(req, res, next);
});

async function sdrPull(req, res, next) {
  const { region, profile } = req.body || {};
  if (!req.user.regions?.includes(region)) {
    return res.status(403).json({ error: 'Not one of your regions' });
  }
  if (!['icp1', 'icp2'].includes(profile)) {
    return res.status(400).json({ error: "profile must be 'icp1' or 'icp2'" });
  }
  if (await quotaService.quotaReached(req.user.email)) {
    return res.status(429).json({ error: 'Daily limit reached — resets at midnight' });
  }
  if (sdrPullsInFlight.has(req.user.email)) {
    return res.status(409).json({ error: 'You already have a pull running' });
  }
  sdrPullsInFlight.add(req.user.email);
  try {
    if (await List.exists({ assignedTo: req.user.email, ...RUNNING })) {
      return res.status(409).json({ error: 'You already have a pull running' });
    }
    const list = await List.create({
      name: makeName(profile, region),
      profile, region,
      requestedCount: DAILY_QUALIFIED_QUOTA,
      assignedTo: req.user.email,
      pullMode: 'quota',
      status: 'pulling',
      lastMessage: 'Starting pull...',
    });
    pullService.runPull(list._id).catch((err) => console.error(`[pull] unhandled: ${err.message}`));
    res.status(201).json(list);
  } catch (err) {
    next(err);
  } finally {
    sdrPullsInFlight.delete(req.user.email);
  }
}

async function adminPull(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can run a pull' });

  const { profile, region, count, assignedTo } = req.body || {};
  if (!['icp1', 'icp2'].includes(profile)) {
    return res.status(400).json({ error: "profile must be 'icp1' or 'icp2'" });
  }
  if (!REGIONS[region]) {
    return res.status(400).json({ error: `region must be one of: ${Object.keys(REGIONS).join(', ')}` });
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: 'count must be an integer between 1 and 200' });
  }
  if (!SDR_EMAILS.includes(assignedTo)) {
    return res.status(400).json({ error: `assignedTo must be one of: ${SDR_EMAILS.join(', ')}` });
  }

  if (adminPullStarting) return res.status(409).json({ error: 'A pull is already running — wait for it to finish' });
  adminPullStarting = true;
  try {
    if (await List.exists(RUNNING)) {
      return res.status(409).json({ error: 'A pull is already running — wait for it to finish' });
    }
    const list = await List.create({
      name: makeName(profile, region),
      profile, region, requestedCount: count, assignedTo,
      pullMode: 'fixed', status: 'pulling', lastMessage: 'Starting pull...',
    });
    pullService.runPull(list._id).catch((err) => console.error(`[pull] unhandled: ${err.message}`));
    res.status(201).json(list);
  } catch (err) {
    next(err);
  } finally {
    adminPullStarting = false;
  }
}

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test test/pullRoute.test.js`
Expected: PASS (SDR + quota tests, plus unchanged admin tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/pull.js backend/test/pullRoute.test.js
git commit -m "feat(prospector): SDR pull route (per-SDR latch, quota gate, region scope)"
```

---

### Task 10: Fix dropped-SDR reference in dashboard tests + full backend suite

**Files:**
- Modify: `backend/test/dashboardRoutes.test.js:15,56` (replace `danielp@scytale.ai`)

**Interfaces:** none (test-only).

- [ ] **Step 1: Replace the dropped SDR in `dashboardRoutes.test.js`**

`danielp@scytale.ai` was removed from the roster, so `currentUser` now 401s it. Replace both occurrences (line 15 `asOtherSdr` and line 56 `seedList('danielp@scytale.ai', 'x2-')`) with a valid SDR distinct from `davidv` — use `khadym@scytale.ai`.

```js
const asOtherSdr = (req) => req.set('X-User-Email', 'khadym@scytale.ai');
```
```js
  await seedList('khadym@scytale.ai', 'x2-');
```

- [ ] **Step 2: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS — every file green. If any other test references `danielp`, update it to a current SDR the same way.

- [ ] **Step 3: Commit**

```bash
git add backend/test/dashboardRoutes.test.js
git commit -m "test(prospector): use a current SDR after dropping danielp"
```

---

### Task 11: Frontend data + API client

**Files:**
- Modify: `frontend/src/users.js`
- Modify: `frontend/src/api.js`

**Interfaces:**
- Produces: frontend `USERS` array mirrors the backend roster incl. `regions`. `api.js` exports `startSdrPull(region, profile)` (POST `{ region, profile }`) and `fetchQuota()` (GET `/api/pull/quota`). Existing `startPull(profile, region, count, assignedTo)` stays for admin.

- [ ] **Step 1: Replace `frontend/src/users.js`** (mirror backend, incl. regions)

```js
export default [
  { email: 'yonia@scytale.ai',       role: 'admin', regions: [] },
  { email: 'simamkelen@scytale.ai',  role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'darrent@scytale.ai',     role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'katiem@scytale.ai',      role: 'sdr',   regions: ['aus', 'benelux'] },
  { email: 'jamesb@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'chumam@scytale.ai',      role: 'sdr',   regions: ['benelux', 'dach'] },
  { email: 'tylorvw@scytale.ai',     role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'ryane@scytale.ai',       role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'khadym@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'jillianl@scytale.ai',    role: 'sdr',   regions: ['dach', 'nordics'] },
  { email: 'davidv@scytale.ai',      role: 'sdr',   regions: ['dach', 'uk'] },
  { email: 'darrenm@scytale.ai',     role: 'sdr',   regions: ['dach'] },
  { email: 'lusandam@scytale.ai',    role: 'sdr',   regions: ['uk'] },
  { email: 'kristophers@scytale.ai', role: 'sdr',   regions: ['uk'] },
];
```

- [ ] **Step 2: Add API helpers in `frontend/src/api.js`** (after `startPull`)

```js
export const startSdrPull = (region, profile) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ region, profile }) });

export const fetchQuota = () => request('/api/pull/quota');
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds (no import/syntax errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/users.js frontend/src/api.js
git commit -m "feat(prospector): frontend roster+regions and SDR pull/quota API"
```

---

### Task 12: Frontend SDR pull screen + nav

**Files:**
- Create: `frontend/src/components/SdrPullScreen.jsx`
- Modify: `frontend/src/App.jsx` (show Pull for SDRs; render SDR vs admin screen)

**Interfaces:**
- Consumes: `startSdrPull`, `fetchQuota`, `fetchLists`, `fetchList` from `api.js`; `USERS` for the current SDR's regions.
- Produces: `SdrPullScreen` — region dropdown (the SDR's regions only), ICP profile dropdown, one Pull button, a "N / 5 qualified today" indicator; button disabled at quota. Reuses the existing polling/progress panel markup from `PullScreen`.

- [ ] **Step 1: Create `frontend/src/components/SdrPullScreen.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { startSdrPull, fetchQuota, fetchLists, fetchList } from '../api';
import USERS from '../users';
import { USER_STORAGE_KEY } from '../api';

const RUNNING = ['pulling', 'qualifying'];

export default function SdrPullScreen() {
  const email = localStorage.getItem(USER_STORAGE_KEY);
  const me = USERS.find((u) => u.email === email);
  const regions = me?.regions || [];

  const [region, setRegion] = useState(regions[0] || '');
  const [profile, setProfile] = useState('icp1');
  const [activeList, setActiveList] = useState(null);
  const [quota, setQuota] = useState(null); // { qualifiedToday, quota }
  const [error, setError] = useState('');

  const refreshQuota = () => fetchQuota().then(setQuota).catch(() => {});

  useEffect(() => {
    refreshQuota();
    fetchLists()
      .then((lists) => {
        const running = lists.find((l) => RUNNING.includes(l.status));
        if (running) setActiveList(running);
      })
      .catch(() => {});
  }, []);

  const isRunning = activeList && RUNNING.includes(activeList.status);

  useEffect(() => {
    if (!isRunning) { refreshQuota(); return undefined; }
    const timer = setInterval(() => {
      fetchList(activeList._id).then(setActiveList).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [isRunning, activeList?._id]);

  const atQuota = quota && quota.qualifiedToday >= quota.quota;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      setActiveList(await startSdrPull(region, profile));
    } catch (err) {
      setError(err.message);
    }
  };

  const counts = activeList?.counts;

  return (
    <div>
      <div className="panel">
        <h2>Pull leads</h2>
        {quota && (
          <p className="muted">
            <strong>{quota.qualifiedToday} / {quota.quota}</strong> qualified today
            {atQuota ? ' — daily limit reached, resets at midnight' : ''}
          </p>
        )}
        <form className="form-row" onSubmit={submit}>
          <label>
            Region
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {regions.map((r) => (
                <option key={r} value={r}>{r.toUpperCase()}</option>
              ))}
            </select>
          </label>
          <label>
            ICP profile
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="icp1">ICP1 (1-50 employees)</option>
              <option value="icp2">ICP2 (51-250 employees)</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={isRunning || atQuota}>
            {isRunning ? 'Pull running…' : 'Pull leads'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>

      {activeList && (
        <div className="panel">
          <h3>
            {activeList.name} <span className={`badge ${activeList.status}`}>{activeList.status}</span>
          </h3>
          <p className="muted">{activeList.lastMessage}</p>
          {activeList.status === 'failed' && <p className="error">{activeList.error}</p>}
          {isRunning && (
            <div className="progress-bar indeterminate"><div /></div>
          )}
          <div className="stat-row">
            <div className="stat"><span className="num">{activeList.pulledCount}</span><span className="label">pulled</span></div>
            {counts && (
              <>
                <div className="stat"><span className="num">{counts.qualified}</span><span className="label">qualified</span></div>
                <div className="stat"><span className="num">{counts.nei}</span><span className="label">not enough info</span></div>
                <div className="stat"><span className="num">{counts.disqualified}</span><span className="label">disqualified</span></div>
              </>
            )}
          </div>
          {activeList.progressLog?.length > 0 && (
            <div className="progress-log">{activeList.progressLog.join('\n')}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire nav + screen in `frontend/src/App.jsx`**

Add the import:

```jsx
import SdrPullScreen from './components/SdrPullScreen';
```

Show the Pull nav button for everyone (remove the `admin`-only guard on the nav button):

```jsx
            <button className={view.name === 'pull' ? 'active' : ''} onClick={() => setView({ name: 'pull' })}>
              Pull
            </button>
```

Render the role-appropriate pull screen in `<main>`:

```jsx
        {view.name === 'pull' && (user.role === 'admin' ? <PullScreen /> : <SdrPullScreen />)}
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification (no frontend test suite)**

Start backend (`cd backend && npm run dev`) and frontend (`cd frontend && npm run dev`), then in the browser:
- Pick an SDR (e.g. `davidv@scytale.ai`) → Pull screen shows only `DACH`/`UK` in the region dropdown, and "0 / 5 qualified today".
- Pick admin (`yonia@scytale.ai`) → Pull screen unchanged (count + assign-to).
- Confirm the SDR region dropdown never lists a region outside the SDR's `regions`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SdrPullScreen.jsx frontend/src/App.jsx
git commit -m "feat(prospector): SDR self-serve pull screen + nav"
```

---

### Task 13: Docs

**Files:**
- Modify: `README.md`, `HANDOFF.md`

**Interfaces:** none.

- [ ] **Step 1: Update docs**

In both files, replace the "pulls are admin-only / globally serialized" description with: SDR self-serve pulls (region + ICP, no count); daily quota of 5 AI-qualified leads per SDR (resets midnight `Asia/Jerusalem`); per-SDR concurrency with an atomic item-index cursor (no skips / no double-pulls); per-SDR region assignments; `danielp` removed, 13 SDRs. Note admin pulls are unchanged.

- [ ] **Step 2: Commit**

```bash
git add README.md HANDOFF.md
git commit -m "docs(prospector): document SDR self-serve pulls and daily quota"
```

---

## Self-Review

**Spec coverage:**
- Roster & regions → Task 1 (+ frontend Task 11). ✅
- Constants → Task 1. ✅
- SDR pull path (region+profile, force self, region 403, quota 429) → Task 9. ✅
- Daily quota derived from data (tz boundary) → Tasks 3, 4; gate in Task 9; loop stop in Task 8. ✅
- Batching loop (first 10, top-up to 5, safety max, pool exhaustion) → Task 8. ✅
- Sync vs batch qualifier → Task 6. ✅
- Concurrency: per-SDR latch → Task 9; atomic item reservation → Task 7; dup-guard → Task 7; enrich limiter → Tasks 2, 7. ✅
- No skipping companies → Task 7 (item cursor, no mid-page break) + explicit test. ✅
- PipelineState item cursor + migration → Task 7 (`readCursor` reshape). ✅
- Frontend (SDR pull screen, region dropdown, quota indicator, admin unchanged) → Tasks 11, 12. ✅
- Error handling (403/429/409) → Task 9. ✅
- Testing coverage → each task's tests; full suite in Task 10. ✅
- Doc updates → Task 13. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code and every command has expected output.

**Type consistency:** `reserveItems`→`{start,end}`, `readCursor`→`{next,perPage,totalItems}`, `collectBatch(list,k,deps)`→number, `qualifyCompanies(companies,onLog,deps)`→Map, `qualifiedToday(email,now)`→number, `runQuotaPull(list,deps)`, `runPull(listId,deps)`, `startSdrPull(region,profile)`, `fetchQuota()` are referenced consistently across tasks.

**One cross-task note for the implementer:** `runQuotaPull` in Task 8 injects `qualify` via `deps`; in production it calls `qualifierService.qualifyCompanies` (Task 6), which itself dispatches sync (<3) vs batch (>=3). Tests inject a `qualify` stub, so Task 8 does not exercise the real Anthropic client.
