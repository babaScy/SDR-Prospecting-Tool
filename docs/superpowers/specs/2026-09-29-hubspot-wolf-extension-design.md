# HubSpot Wolf lookup extension (design)

## Background

An SDR working a call has HubSpot open but not Wolf. Wolf already holds qualification/firmographic detail (the `LeadCard` shown throughout the Prospector frontend) for any company that's been pushed to HubSpot — `Company.hubspotCompanyId` and `Contact.hubspotContactId` are set at push time and never change afterward. There's currently no way to see that data without leaving HubSpot and searching for the company in Wolf by hand.

This adds a small Chrome extension: click its toolbar icon while viewing a HubSpot contact or company record, and a popup shows that company's `LeadCard` — pulled live from Wolf's backend, matched off the HubSpot record id already stored on our data.

## Scope

- Chrome extension (Manifest V3), one popup, triggered by clicking the toolbar icon (not injected/always-on).
- Popup shows the company's `LeadCard` only — same component, same data, as used elsewhere in the frontend. No contact-level card.
- Landing on a HubSpot **contact** record resolves to that contact's company and shows the same company card. Landing on a **company** record shows it directly.
- New read-only backend endpoint, gated by a static shared secret (not per-user auth, not the session-cookie flow the rest of the app uses).
- Out of scope for this pass: per-user extension tokens/login, an always-on overlay, showing per-contact cards, any CRM besides HubSpot, write actions from the extension.

Known tradeoff, accepted for v1: because auth is one shared secret rather than a per-user token, the endpoint can't scope results to "your own lists" the way the rest of the app does (e.g. `leads.js`'s `list.assignedTo` check) — any SDR with the extension installed can look up any company. Given this is read-only qualification data, that's an acceptable v1 tradeoff, not a bug to fix here.

Also accepted for v1: the new route is mounted ahead of `currentUser`/`maintenanceGuard` (see below), so it keeps working during maintenance mode. Low stakes for a read-only lookup; not worth threading maintenance-mode awareness through a shared-secret route for this pass.

## Backend

### Shared-secret auth

New middleware, `backend/src/middleware/extensionAuth.js`:

```js
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

### Lookup route

New file `backend/src/routes/extension.js`:

```js
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

Same response shape `GET /api/lists/:id/leads` already produces (company doc + computed `applicableFrameworks`), so `LeadCard` consumes it unchanged.

### Mounting and CORS

The existing global `app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }))` runs before everything else in `app.js`, including any route-specific middleware — so a second, narrower `cors()` scoped to `/api/extension` would never actually run for preflight (`OPTIONS`) requests if placed after it; the global one already intercepts and answers those first.

To avoid that, the extension route (with its own `cors()`) is mounted **before** the global `cors()` call, not after — same reasoning as `/api/auth` being reachable without a session cookie, just earlier still:

```js
// Own CORS + auth, mounted ahead of the global cors()/currentUser/maintenanceGuard
// chain below — this path has no cookie and no per-user identity, just one
// shared secret, and must stay reachable regardless of either.
app.use('/api/extension', cors({ origin: true }), require('./middleware/extensionAuth'), require('./routes/extension'));

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174', credentials: true }));
// ...rest of app.js unchanged
```

(`origin: true` reflects whatever origin asked, with no `credentials: true` — fine here since the shared secret, not a cookie, is what's gating access.)

### Config

`EXTENSION_SHARED_KEY` — new required env var (backend `.env` / deploy config), a long random string. The same value is baked into the extension's build (see below).

## Extension

New top-level `extension/` directory (sibling to `backend/` and `frontend/`).

```
extension/
  manifest.json
  popup.html
  src/
    popup.jsx        # entry: renders <Popup />
    Popup.jsx         # state machine below
    hubspotUrl.js     # pure function: URL -> { type, hubspotId } | null
  vite.config.js
```

### manifest.json (MV3)

- `action.default_popup`: `popup.html`
- `permissions`: `["activeTab"]` — only what's needed to read the current tab's URL when the icon is clicked
- `host_permissions`: the backend's deployed origin (needed for `fetch` from the popup to succeed under MV3's extension CSP)

### `hubspotUrl.js`

Pure function parsing a HubSpot record URL into `{ type: 'company' | 'contact', hubspotId }` or `null` if the URL doesn't match a known HubSpot record pattern (contact/company record views only — list views, deals, etc. all return `null`). Kept pure and separate from `Popup.jsx` specifically so it's unit-testable without a browser.

### `Popup.jsx`

On mount: `chrome.tabs.query({ active: true, currentWindow: true })` → parse the URL with `hubspotUrl.js` → if `null`, render "Open a HubSpot contact or company to see Wolf info." and stop. Otherwise `fetch` `${BACKEND_URL}/api/extension/lookup?type=...&hubspotId=...` with the baked-in `X-Wolf-Extension-Key` header, and render one of:

- loading → a simple spinner/"Loading…"
- 404 → "No Wolf record for this company yet."
- other error (network, 401, 500) → the error message, short
- success → `LeadCard` imported directly from `../../frontend/src/components/LeadCard.jsx` (same repo — reused as-is, not duplicated), with its existing stylesheet included in the extension's own build

### Build

`extension/vite.config.js` builds `popup.html`/`popup.jsx` into a loadable unpacked extension (`chrome://extensions` → "Load unpacked"). `BACKEND_URL` and `EXTENSION_SHARED_KEY` come from a build-time `.env` (mirroring how `frontend/` already gets `FRONTEND_URL`/backend URL into its build), not committed.

## Testing

Backend (`backend/test/`, following the existing `node:test` + `supertest` route-test pattern used by `contactRoutes.test.js`/`hubspotRoutes.test.js`): new `extensionRoutes.test.js` covering —
- company match → 200 with the company + `applicableFrameworks`
- contact match → resolves to its company, 200
- no match (either type) → 404
- missing/wrong `X-Wolf-Extension-Key` → 401
- missing `EXTENSION_SHARED_KEY` env var → 500
- bad `type` / missing `hubspotId` → 400

Extension: `hubspotUrl.js` gets a plain `node:test` unit test (no browser needed — a handful of real HubSpot URL shapes in, expected `{ type, hubspotId }` or `null` out). `Popup.jsx` and the manifest are verified manually by loading the unpacked extension in Chrome against a running backend, since there's no existing test harness for extension UI in this repo.
