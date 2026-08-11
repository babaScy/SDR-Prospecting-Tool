# Add company to HubSpot when no contacts were found (design)

## Background

Today, a HubSpot company record is only ever created as a side effect of pushing a *contact* (`hubspotService.pushContact` → `resolveOrCreateCompany`, called from `POST /api/contacts/:id/hubspot`). A company whose `contactStatus` is `'none'` (contact sourcing ran but found nobody — no resolvable domain, zero Apollo people, or the AI picker made zero picks) has no path into HubSpot at all: `ContactsScreen.jsx` renders "No decision-maker found." for such companies with no action available.

Note: `POST /api/leads/:id/decision` already refuses to accept a company with no website domain at all ("no website domain on Apollo... can only be rejected"). So by the time a company is `sdrStatus: 'accepted'` and `contactStatus: 'none'`, it necessarily *has* a domain — sourcing ran and still found nobody. The domain-missing case in the new endpoint below is a defensive fallback, not the expected path.

## Scope

Only companies with `contactStatus === 'none'`. The existing per-contact push flow is unchanged and remains the only path for companies that do have contacts.

## Backend

New route in `backend/src/routes/leads.js` (the existing company-scoped route file — `POST /:id/decision` already lives here), mounted at `/api/leads`:

`POST /api/leads/:id/hubspot`

```js
router.post('/:id/hubspot', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Lead not found' });

    const list = await List.findById(company.listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }

    if (company.contactStatus !== 'none') {
      return res.status(400).json({ error: 'This company has contacts — push them individually from the Contacts screen.' });
    }

    const domain = hubspotService.resolveDomain(company, null); // falls back to company.website
    if (!domain) {
      return res.status(400).json({ error: 'No website domain on this company — cannot safely dedupe in HubSpot' });
    }

    let hubspotCompanyId;
    try {
      const ownerId = await hubspotService.getOwnerIdByEmail(list.assignedTo);
      if (!ownerId) {
        throw new Error(`No HubSpot user found for ${list.assignedTo} — ask an admin to check their HubSpot account email.`);
      }
      hubspotCompanyId = await hubspotService.resolveOrCreateCompany(company, domain, ownerId);
    } catch (err) {
      console.error(`[hubspot] company push failed for ${company._id}: ${err.message}`);
      company.hubspotPushStatus = 'failed';
      company.hubspotPushError = err.message;
      await company.save();
      return res.status(502).json({ error: err.message });
    }

    company.hubspotCompanyId = hubspotCompanyId; // resolveOrCreateCompany already persists this, but keep the in-memory doc consistent before the next save
    company.hubspotPushStatus = 'synced';
    company.hubspotPushedAt = new Date();
    company.hubspotPushedBy = req.user.email;
    company.hubspotPushError = undefined;
    await company.save();
    return res.json(company);
  } catch (err) {
    next(err);
  }
});
```

`resolveOrCreateCompany` and `getOwnerIdByEmail` are already exported from `hubspotService.js` and used exactly this way inside `pushContact` — reused as-is, no changes to `hubspotService.js` needed. `resolveDomain(company, contact)` already handles a `null` contact via `contact?.domain || company?.website`, so it's reused unchanged too.

`NO_HUBSPOT_OWNER`/`AMBIGUOUS_COMPANY`/`COMPANY_CREATE_TIMEOUT` are `HubspotPushError`s already thrown by these functions — they're caught by the generic `try/catch` above and surfaced via `err.message`, same as the contact route does.

## Data model

`backend/src/models/Company.js` — add 4 fields, mirroring `Contact`'s existing `hubspotStatus`/`hubspotSyncedAt`/`hubspotSyncedBy`/`hubspotError` (`Company` doesn't have push-audit fields today, only the resolve-cache `hubspotCompanyId`/`hubspotCompanyClaimedAt`):

```js
hubspotPushStatus: { type: String, enum: ['none', 'synced', 'failed'], default: 'none' },
hubspotPushedAt: { type: Date },
hubspotPushedBy: { type: String },
hubspotPushError: { type: String },
```

No changes to `hubspotCompanyId`/`hubspotCompanyClaimedAt` — reused as-is.

## Frontend

`frontend/src/components/ContactsScreen.jsx` — where a company's contact group currently renders:
```jsx
<p className="muted">No decision-maker found.</p>
```
add a button alongside it, with the same state machine as `ContactCard`'s HubSpot button:
- `hubspotPushStatus === 'synced'` → disabled, label `'In HubSpot'`
- push in flight (local `busy` state) → disabled, label `'Adding…'`
- `hubspotPushStatus === 'failed'` → enabled (retryable), show `hubspotPushError` near the button, label `'Add to HubSpot'`
- otherwise → enabled, label `'Add to HubSpot'`

New `pushCompanyToHubspot(companyId)` helper in `frontend/src/api.js` (`POST /api/leads/${companyId}/hubspot`), alongside the existing `pushContactToHubspot`. On success, replace that company's record in local state (same pattern `onPushed` uses for contacts).

## Testing

Per existing conventions (`test/` has route-level tests for `contacts.js` and `leads.js`), add route tests for `POST /api/leads/:id/hubspot` covering: success (mocked `hubspotService`), 400 when `contactStatus !== 'none'`, 400 when no domain, 403 when an SDR requests a company not on their own list, 502 + persisted `hubspotPushStatus: 'failed'` on a `hubspotService` throw, 404 for a bad/missing id. Mirrors the existing test shape for `contacts.js`'s push route (check `test/` for that file's exact name and mocking pattern before writing new tests, to stay consistent).
