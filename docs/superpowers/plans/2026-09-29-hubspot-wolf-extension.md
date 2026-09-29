# HubSpot Wolf Lookup Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension popup that, when clicked while viewing a HubSpot contact or company record, shows that company's Wolf `LeadCard` (qualification verdict, reasoning, firmographics).

**Architecture:** A new shared-secret-gated backend endpoint (`GET /api/extension/lookup`) resolves a HubSpot record id to a Wolf `Company` doc, reusing the same response shape `/api/lists/:id/leads` already produces. A small Manifest V3 extension parses the active tab's HubSpot URL, calls that endpoint, and renders the existing `LeadCard` React component (imported directly from `frontend/src`, not duplicated).

**Tech Stack:** Express/Mongoose (existing backend), `node:test` + `supertest` + `mongodb-memory-server` (existing backend test stack), React + Vite (new `extension/` package, mirroring `frontend/`'s toolchain), Chrome Manifest V3.

**Spec:** `docs/superpowers/specs/2026-09-29-hubspot-wolf-extension-design.md`

## Global Constraints

- Popup shows the **company** `LeadCard` only — never a per-contact card, even when the matched record is a contact (spec Scope).
- Auth is one static shared secret (`EXTENSION_SHARED_KEY`), sent as the `X-Wolf-Extension-Key` header — no per-user tokens, no login screen (spec Scope, Backend).
- The extension route is mounted **before** the app's global `cors()`/`currentUser`/`maintenanceGuard` chain in `app.js`, with its own `cors({ origin: true })` ahead of it (spec Mounting and CORS).
- No production backend exists yet (per project conventions — everything ships straight to `main`), so the extension's backend URL is a plain constant for now, not build-time-.env-templated as an earlier draft of the spec considered; trivial to change later. This is a plan-level simplification of the spec's "build-time `.env`" wording, not a scope change — the spec's actual requirement is just "the extension knows where the backend is," which a constant satisfies today.
- `permissions: ["activeTab"]` only — no broader host access, no content scripts (spec Extension / manifest.json).

## Review Focus

- A HubSpot record URL with a trailing sub-tab segment or query string after the numeric id (e.g. `.../record/0-2/12345/related-companies`, `.../record/0-1/999?foo=bar`) — SDRs routinely land on sub-tabs of a record, not just its root URL, and this must still resolve to the record id. Test added in Task 3.
- A browser-internal tab URL (`chrome://newtab`, `about:blank`) — very likely to be the active tab the first time someone tries the extension — must return `null`, not throw. Test added in Task 3.
- `?type=company&hubspotId=` (present but empty) must be rejected as a 400, not silently treated as "no id" further down the stack. Test added in Task 2.
- The shared-secret check must be an exact match — a header value with incidental leading/trailing whitespace (e.g. pasted from a `.env` file with a stray newline) must still be rejected, not accepted by some accidental `.trim()`/loose comparison later. Test added in Task 1.
- The popup must not fire any network request at all when the active tab isn't a recognized HubSpot record — only render the "open a HubSpot record" message. Manual check in Task 5 (no automated harness for the popup exists in this repo, per spec Testing).

---

### Task 1: Backend — shared-secret auth middleware

**Files:**
- Create: `backend/src/middleware/extensionAuth.js`
- Test: `backend/test/extensionAuth.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `module.exports = function extensionAuth(req, res, next)` — an Express middleware. Later tasks (Task 2) mount it directly on the new route.

- [ ] **Step 1: Write the failing test**

```js
// backend/test/extensionAuth.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const extensionAuth = require('../src/middleware/extensionAuth');

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function run(req) {
  const res = mockRes();
  let nextCalled = false;
  extensionAuth(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('missing EXTENSION_SHARED_KEY env var → 500', () => {
  delete process.env.EXTENSION_SHARED_KEY;
  const { res, nextCalled } = run({ header: () => undefined });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});

test('missing header → 401', () => {
  process.env.EXTENSION_SHARED_KEY = 'secret123';
  const { res, nextCalled } = run({ header: () => undefined });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('wrong header value → 401', () => {
  process.env.EXTENSION_SHARED_KEY = 'secret123';
  const req = { header: (name) => (name === 'X-Wolf-Extension-Key' ? 'wrong' : undefined) };
  const { res, nextCalled } = run(req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

// Guards against a future "helpful" .trim()/loose-equals change silently
// widening what counts as a match.
test('correct key plus stray whitespace → still 401', () => {
  process.env.EXTENSION_SHARED_KEY = 'secret123';
  const req = { header: (name) => (name === 'X-Wolf-Extension-Key' ? 'secret123 ' : undefined) };
  const { res, nextCalled } = run(req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('correct header value → calls next, no response sent', () => {
  process.env.EXTENSION_SHARED_KEY = 'secret123';
  const req = { header: (name) => (name === 'X-Wolf-Extension-Key' ? 'secret123' : undefined) };
  const { res, nextCalled } = run(req);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/extensionAuth.test.js`
Expected: FAIL — `Cannot find module '../src/middleware/extensionAuth'`

- [ ] **Step 3: Write minimal implementation**

```js
// backend/src/middleware/extensionAuth.js
// Gates the extension's read-only lookup route. Deliberately separate from
// currentUser.js — there's no per-user identity here, just one shared secret
// baked into the extension, so req.user is never set on this path.
module.exports = function extensionAuth(req, res, next) {
  const key = process.env.EXTENSION_SHARED_KEY;
  if (!key) return res.status(500).json({ error: 'EXTENSION_SHARED_KEY is not set' });
  if (req.header('X-Wolf-Extension-Key') !== key) {
    return res.status(401).json({ error: 'Invalid or missing extension key' });
  }
  next();
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/extensionAuth.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/extensionAuth.js backend/test/extensionAuth.test.js
git commit -m "feat(prospector): add shared-secret auth middleware for the extension route"
```

---

### Task 2: Backend — extension lookup route, mounted ahead of the global CORS/session chain

**Files:**
- Create: `backend/src/routes/extension.js`
- Modify: `backend/src/app.js:1-16` (insert the new mount between `const app = express();` and the existing global `app.use(cors(...))` line)
- Test: `backend/test/extensionRoutes.test.js`

**Interfaces:**
- Consumes: `extensionAuth` from Task 1 (`backend/src/middleware/extensionAuth.js`); `Company` model (`hubspotCompanyId`), `Contact` model (`hubspotContactId`, `companyId`); `applicableFrameworks(company)` from `backend/src/util/applicableFrameworks.js` (already used the same way in `backend/src/routes/lists.js:89`).
- Produces: `GET /api/extension/lookup?type=company|contact&hubspotId=<id>` → `200` with `{ ...company, applicableFrameworks }`, `400` (bad/missing params), `401` (bad/missing shared key, from Task 1's middleware), `404` (no match). Later tasks (Task 5) call this exact endpoint/shape from the extension popup.

- [ ] **Step 1: Write the failing test**

```js
// backend/test/extensionRoutes.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');

process.env.EXTENSION_SHARED_KEY = 'test-extension-key';
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const withKey = (req) => req.set('X-Wolf-Extension-Key', 'test-extension-key');

const makeCompany = async (over = {}) => {
  const list = await List.create({ name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1, assignedTo: 'davidv@scytale.ai' });
  return Company.create({ apolloAccountId: 'a1', companyName: 'Acme', listId: list._id, status: 'qualified', ...over });
};

test('company lookup by hubspotCompanyId → 200 with company + applicableFrameworks', async () => {
  await makeCompany({ hubspotCompanyId: 'hs-co-1' });
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'company', hubspotId: 'hs-co-1' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.companyName, 'Acme');
  assert.ok('applicableFrameworks' in res.body);
});

test('contact lookup resolves to its company → 200', async () => {
  const company = await makeCompany({ hubspotCompanyId: 'hs-co-2' });
  await Contact.create({ companyId: company._id, listId: company.listId, apolloPersonId: 'p1', hubspotContactId: 'hs-ct-1' });
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'contact', hubspotId: 'hs-ct-1' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.companyName, 'Acme');
});

test('no match (company) → 404', async () => {
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'company', hubspotId: 'nope' }));
  assert.equal(res.status, 404);
});

test('no match (contact) → 404', async () => {
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'contact', hubspotId: 'nope' }));
  assert.equal(res.status, 404);
});

test('missing shared-secret header → 401', async () => {
  const res = await request(app).get('/api/extension/lookup').query({ type: 'company', hubspotId: 'nope' });
  assert.equal(res.status, 401);
});

test('wrong shared-secret header → 401', async () => {
  const res = await request(app).get('/api/extension/lookup').query({ type: 'company', hubspotId: 'nope' }).set('X-Wolf-Extension-Key', 'bad');
  assert.equal(res.status, 401);
});

test('bad type → 400', async () => {
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'deal', hubspotId: 'x' }));
  assert.equal(res.status, 400);
});

test('missing hubspotId → 400', async () => {
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'company' }));
  assert.equal(res.status, 400);
});

// Present-but-empty must be rejected the same as missing — Express parses
// ?hubspotId= as '', which is falsy but not "absent", so this pins that the
// falsy check actually covers it rather than only an undefined-check.
test('empty hubspotId → 400', async () => {
  const res = await withKey(request(app).get('/api/extension/lookup').query({ type: 'company', hubspotId: '' }));
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/extensionRoutes.test.js`
Expected: FAIL — 404s for every route (route doesn't exist / not mounted yet), or a require error if `routes/extension.js` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/src/routes/extension.js
const express = require('express');
const Company = require('../models/Company');
const Contact = require('../models/Contact');
const { applicableFrameworks } = require('../util/applicableFrameworks');

const router = express.Router();

router.get('/lookup', async (req, res, next) => {
  try {
    const { type, hubspotId } = req.query;
    if (!['company', 'contact'].includes(type) || !hubspotId) {
      return res.status(400).json({ error: "type must be 'company' or 'contact', hubspotId is required" });
    }

    let company;
    if (type === 'company') {
      company = await Company.findOne({ hubspotCompanyId: hubspotId }).lean();
    } else {
      const contact = await Contact.findOne({ hubspotContactId: hubspotId }).lean();
      company = contact && await Company.findById(contact.companyId).lean();
    }

    if (!company) return res.status(404).json({ error: 'No Wolf record found for this HubSpot record' });

    res.json({ ...company, applicableFrameworks: applicableFrameworks(company) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

Modify `backend/src/app.js` — insert the new mount right after `const app = express();`, before the existing global `cors()` call:

```js
const app = express();

// Own CORS + auth, mounted ahead of the global cors()/currentUser/maintenanceGuard
// chain below — this path has no cookie and no per-user identity, just one
// shared secret, and must stay reachable regardless of either. Mounting it
// after the global cors() would silently break: that middleware already
// intercepts and answers every OPTIONS preflight before this route-specific
// one ever runs.
app.use('/api/extension', cors({ origin: true }), require('./middleware/extensionAuth'), require('./routes/extension'));

// credentials must be allowed for the session cookie to travel cross-origin.
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174', credentials: true }));
```

(Everything below that in `app.js` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/extensionRoutes.test.js`
Expected: PASS (9 tests)

Then run the full backend suite to confirm nothing else broke from the `app.js` change:

Run: `cd backend && npm test`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/extension.js backend/src/app.js backend/test/extensionRoutes.test.js
git commit -m "feat(prospector): add /api/extension/lookup for the HubSpot Wolf extension"
```

Note: add `EXTENSION_SHARED_KEY=<a long random string>` to your local `backend/.env` before manually exercising this route outside the test suite (there is no `.env.example` convention in this repo — see the other keys already in `backend/.env`).

---

### Task 3: Extension — HubSpot URL parser (pure function)

**Files:**
- Create: `extension/src/hubspotUrl.js`
- Test: `extension/test/hubspotUrl.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `module.exports = { parseHubspotUrl }` where `parseHubspotUrl(url: string) => { type: 'company' | 'contact', hubspotId: string } | null`. Task 5's `Popup.jsx` calls this directly.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/hubspotUrl.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHubspotUrl } = require('../src/hubspotUrl');

test('current-shape contact record URL', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/record/0-1/987654321'),
    { type: 'contact', hubspotId: '987654321' }
  );
});

test('current-shape company record URL', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/record/0-2/111222333'),
    { type: 'company', hubspotId: '111222333' }
  );
});

// SDRs land on sub-tabs of a record constantly (activity, related companies,
// etc.) — the id must still resolve from a URL that doesn't end at it.
test('current-shape URL with a trailing sub-tab segment', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/record/0-2/111222333/related-companies'),
    { type: 'company', hubspotId: '111222333' }
  );
});

test('current-shape URL with a trailing query string', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/record/0-1/999?interaction=note'),
    { type: 'contact', hubspotId: '999' }
  );
});

test('legacy contact URL', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/contact/555'),
    { type: 'contact', hubspotId: '555' }
  );
});

test('legacy company URL', () => {
  assert.deepEqual(
    parseHubspotUrl('https://app.hubspot.com/contacts/12345678/company/666'),
    { type: 'company', hubspotId: '666' }
  );
});

test('a HubSpot list view is not a record → null', () => {
  assert.equal(parseHubspotUrl('https://app.hubspot.com/contacts/12345678/objectLists/view/all'), null);
});

test('a non-HubSpot URL → null', () => {
  assert.equal(parseHubspotUrl('https://example.com/whatever'), null);
});

// The most likely tab to be active the first time someone tries the
// extension — must not throw.
test('a browser-internal URL → null, no throw', () => {
  assert.equal(parseHubspotUrl('chrome://newtab/'), null);
  assert.equal(parseHubspotUrl('about:blank'), null);
});

test('undefined/empty input → null', () => {
  assert.equal(parseHubspotUrl(undefined), null);
  assert.equal(parseHubspotUrl(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test test/hubspotUrl.test.js`
Expected: FAIL — `Cannot find module '../src/hubspotUrl'`

- [ ] **Step 3: Write minimal implementation**

```js
// extension/src/hubspotUrl.js
// Parses a HubSpot CRM record URL into { type, hubspotId }, or null if the
// URL isn't a contact/company record view (list views, deals, non-HubSpot
// and browser-internal URLs all return null).
function parseHubspotUrl(url) {
  if (!url) return null;
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  // Current shape: /contacts/<portalId>/record/<objectTypeId>/<recordId>[/...]
  // 0-1 = contact, 0-2 = company — HubSpot's standard object type ids.
  let m = path.match(/\/record\/0-1\/(\d+)/);
  if (m) return { type: 'contact', hubspotId: m[1] };
  m = path.match(/\/record\/0-2\/(\d+)/);
  if (m) return { type: 'company', hubspotId: m[1] };

  // Legacy shape: /contacts/<portalId>/contact/<id> or .../company/<id>
  m = path.match(/\/contact\/(\d+)(?:\/|$)/);
  if (m) return { type: 'contact', hubspotId: m[1] };
  m = path.match(/\/company\/(\d+)(?:\/|$)/);
  if (m) return { type: 'company', hubspotId: m[1] };

  return null;
}

module.exports = { parseHubspotUrl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test test/hubspotUrl.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add extension/src/hubspotUrl.js extension/test/hubspotUrl.test.js
git commit -m "feat(prospector): add HubSpot record URL parser for the extension"
```

---

### Task 4: Extension — Manifest V3 scaffold with a placeholder popup

**Files:**
- Create: `extension/package.json`
- Create: `extension/manifest.json`
- Create: `extension/popup.html`
- Create: `extension/vite.config.js`
- Create: `extension/src/popup.jsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 yet (this task only proves the extension shell loads and builds).
- Produces: a `dist/` build loadable as an unpacked Chrome extension; `extension/src/popup.jsx` as the entry point Task 5 replaces the body of.

- [ ] **Step 1: Create the package manifest**

```json
// extension/package.json
{
  "name": "wolf-extension",
  "private": true,
  "version": "0.1.0",
  "type": "commonjs",
  "scripts": {
    "build": "vite build",
    "test": "node --test 'test/**/*.test.js'"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.3.4"
  }
}
```

(`"type": "commonjs"` matters here: `extension/src/hubspotUrl.js` and its test from Task 3 use plain `require`/`module.exports`, and Node would otherwise treat every `.js` file in this package as an ES module and reject `require()`.)

- [ ] **Step 2: Create the Chrome manifest**

```json
// extension/manifest.json
{
  "manifest_version": 3,
  "name": "Wolf for HubSpot",
  "version": "0.1.0",
  "description": "Shows Wolf's qualification card for the HubSpot contact or company you're viewing.",
  "action": {
    "default_popup": "popup.html"
  },
  "permissions": ["activeTab"],
  "host_permissions": ["http://localhost:4000/*"]
}
```

(`host_permissions` points at the backend's dev URL — there's no deployed backend yet; update this alongside `BACKEND_URL` in `extension/src/config.js`, added in Task 5, once one exists.)

- [ ] **Step 3: Create the popup HTML shell and a placeholder entry**

```html
<!-- extension/popup.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Wolf</title>
    <style>
      body { margin: 0; width: 380px; max-height: 600px; overflow-y: auto; font-family: sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/popup.jsx"></script>
  </body>
</html>
```

```jsx
// extension/src/popup.jsx
import { createRoot } from 'react-dom/client';

// Replaced in the next task with the real lookup + LeadCard flow — this
// placeholder only proves the extension shell loads and builds.
createRoot(document.getElementById('root')).render(<p>Wolf extension loading…</p>);
```

```js
// extension/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: 'popup.html',
    },
  },
});
```

- [ ] **Step 4: Build it and load it in Chrome**

Run: `cd extension && npm install && npm run build`
Expected: a `dist/` directory containing `popup.html` and its bundled JS, no build errors.

Then, in Chrome: go to `chrome://extensions`, enable Developer mode, "Load unpacked", and select `extension/dist`. Click the extension's toolbar icon.
Expected: a popup opens showing "Wolf extension loading…".

(`manifest.json` needs to be present in `dist/` for Chrome to load it — if `npm run build` doesn't already copy it there, copy it manually for this check: `cp extension/manifest.json extension/dist/manifest.json`. Task 5 is unaffected either way since it only touches `popup.jsx`.)

- [ ] **Step 5: Commit**

```bash
git add extension/package.json extension/manifest.json extension/popup.html extension/vite.config.js extension/src/popup.jsx
git commit -m "feat(prospector): scaffold the Wolf-for-HubSpot Chrome extension"
```

---

### Task 5: Extension — real lookup flow and `LeadCard` rendering

**Files:**
- Create: `extension/src/config.js`
- Create: `extension/src/Popup.jsx`
- Modify: `extension/src/popup.jsx` (render `<Popup />` instead of the placeholder)

**Interfaces:**
- Consumes: `parseHubspotUrl` from Task 3 (`extension/src/hubspotUrl.js`); `GET /api/extension/lookup` from Task 2; `LeadCard` from `frontend/src/components/LeadCard.jsx` (imported directly, unmodified) and its stylesheet `frontend/src/styles.css`.
- Produces: the finished popup UI — nothing later in this plan depends on it.

- [ ] **Step 1: Add the backend config constants**

```js
// extension/src/config.js
// No deployed backend exists yet — update both of these once one does.
// EXTENSION_SHARED_KEY must match the backend's EXTENSION_SHARED_KEY env var.
export const BACKEND_URL = 'http://localhost:4000';
export const EXTENSION_SHARED_KEY = 'REPLACE_WITH_YOUR_LOCAL_EXTENSION_SHARED_KEY';
```

- [ ] **Step 2: Write `Popup.jsx`**

```jsx
// extension/src/Popup.jsx
import { useEffect, useState } from 'react';
import LeadCard from '../../frontend/src/components/LeadCard';
import '../../frontend/src/styles.css';
import { parseHubspotUrl } from './hubspotUrl';
import { BACKEND_URL, EXTENSION_SHARED_KEY } from './config';

export default function Popup() {
  const [state, setState] = useState({ status: 'loading' }); // loading | no-record | not-found | error | found

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      const parsed = parseHubspotUrl(url);
      if (!parsed) {
        if (!cancelled) setState({ status: 'no-record' });
        return; // no network request when there's nothing to look up
      }

      try {
        const res = await fetch(
          `${BACKEND_URL}/api/extension/lookup?type=${parsed.type}&hubspotId=${encodeURIComponent(parsed.hubspotId)}`,
          { headers: { 'X-Wolf-Extension-Key': EXTENSION_SHARED_KEY } }
        );
        if (cancelled) return;
        if (res.status === 404) return setState({ status: 'not-found' });
        if (!res.ok) return setState({ status: 'error', message: (await res.json().catch(() => ({}))).error || `Request failed (${res.status})` });
        setState({ status: 'found', lead: await res.json() });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: err.message });
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'no-record') return <p>Open a HubSpot contact or company to see Wolf info.</p>;
  if (state.status === 'not-found') return <p>No Wolf record for this company yet.</p>;
  if (state.status === 'error') return <p>Couldn't load Wolf data: {state.message}</p>;
  return <LeadCard lead={state.lead} />;
}
```

- [ ] **Step 3: Wire it into the entry point**

```jsx
// extension/src/popup.jsx
import { createRoot } from 'react-dom/client';
import Popup from './Popup';

createRoot(document.getElementById('root')).render(<Popup />);
```

- [ ] **Step 4: Manual verification**

Set `EXTENSION_SHARED_KEY` in `backend/.env` and `extension/src/config.js` to the same value. Start the backend (`cd backend && npm run dev`). Rebuild the extension (`cd extension && npm run build`) and reload it at `chrome://extensions`.

Check each of these by hand (no automated harness exists for this part — per the spec's Testing section):
- A HubSpot company page whose `hubspotCompanyId` matches a real `Company` in your dev DB → popup shows that company's `LeadCard`.
- A HubSpot contact page whose `hubspotContactId` matches a real `Contact` → popup shows that contact's company's `LeadCard`.
- A HubSpot page for a record with no matching Wolf data → "No Wolf record for this company yet."
- A non-HubSpot tab (or `chrome://newtab`) active → "Open a HubSpot contact or company to see Wolf info." and confirm via the Network tab in DevTools that **no request was made** to `/api/extension/lookup`.
- Backend stopped / wrong `EXTENSION_SHARED_KEY` in `config.js` → the error state renders, extension doesn't hang on "Loading…".

- [ ] **Step 5: Commit**

```bash
git add extension/src/config.js extension/src/Popup.jsx extension/src/popup.jsx
git commit -m "feat(prospector): wire the extension popup to the Wolf lookup endpoint"
```
