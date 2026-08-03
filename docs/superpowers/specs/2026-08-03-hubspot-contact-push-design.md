# HubSpot contact push — design

Date: 2026-08-03
Branch: `feat/contact-sourcing` (or a follow-on branch off it once merged)
Status: approved, pending write-up into an implementation plan

## Problem

Prospector sources up to 4 ranked decision-maker contacts per accepted company
(`ContactsScreen.jsx`) but has no HubSpot integration at all today — an SDR
who wants a contact in HubSpot has to re-enter it by hand, and there's no way
to tell from Prospector whether that's already happened. Sister project
WOLF+ has an automated HubSpot sync (`The-Wolf/services/hubspotService.js`)
but it hardcodes a single owner and auto-enrolls contacts into an outreach
email sequence — neither behavior is right for Prospector, which has no
per-SDR HubSpot mapping and generates no outreach copy.

## Goal

A per-contact "Add to HubSpot" button on the Contacts screen that pushes one
contact (and its company, if needed) into HubSpot under the SDR who owns
that list, with the same dedup safety WOLF+ relies on, and persists the
result so the button's state survives a refresh.

## Architecture

- **`backend/src/services/hubspotService.js`** (new) — adapted from WOLF+'s
  service: OAuth refresh-token auth, domain/email/LinkedIn normalization,
  dedup lookups, and an orchestrator that creates-or-reuses the company then
  creates the contact and associates them. HTTP client is injectable
  (`deps.request`) so tests never hit the real API, matching the pattern
  already used in `apolloPeopleService.js`.
- **`POST /api/contacts/:id/hubspot`** (new route, likely `routes/contacts.js`,
  new file) — the only entry point. Loads the `Contact`, its `Company`, and
  the owning `List`; enforces the existing list-ownership rule (SDR can only
  act on their own lists, admin can act on any); calls the service; persists
  the result on the `Contact` document; returns the updated contact.
- **`ContactsScreen.jsx`** — each `ContactCard` gets a button whose label
  reflects `contact.hubspotStatus`.

No sequence enrollment, no bulk/automatic sync, no dry-run master switch —
the button click is the explicit confirmation, so every call is a real,
one-contact write (guarded by the dedup checks below).

## Data model changes

`Contact` schema gains:

```js
hubspotStatus:    { type: String, enum: ['none', 'synced', 'already_existed', 'failed'], default: 'none' },
hubspotContactId: { type: String },
hubspotCompanyId: { type: String },
hubspotSyncedAt:  { type: Date },
hubspotSyncedBy:  { type: String }, // email of whoever clicked the button
hubspotError:     { type: String }, // last failure reason, cleared on next success
```

## Data flow (per click)

1. Frontend calls `POST /api/contacts/:id/hubspot`.
2. Route loads `Contact` → `Company` → `List`; 404 if any missing; 403 if an
   SDR doesn't own the list.
3. Route calls `hubspotService.pushContact(company, contact, { ownerEmail: list.assignedTo })`:
   a. Resolve the HubSpot owner: `GET /crm/v3/owners?email=<ownerEmail>`. No
      match → throw a typed error (`NO_HUBSPOT_OWNER`), no writes attempted.
   b. Dedup contact: search by normalized email OR normalized LinkedIn URL.
      - Exact one match → contact already exists. Skip creation, return
        `{ status: 'already_existed', hubspotContactId }`.
      - More than one match (ambiguous) → throw a typed error
        (`AMBIGUOUS_CONTACT`), no writes.
      - No match → continue.
   c. Dedup company by normalized domain (`contact.domain || company.website`).
      Reuse if found, otherwise create it with the resolved owner.
   d. Create the contact with the resolved owner, associate to the company.
   e. Return `{ status: 'synced', hubspotContactId, hubspotCompanyId }`.
4. Route persists the outcome onto `Contact` (`hubspotStatus`,
   `hubspotContactId`, `hubspotCompanyId`, `hubspotSyncedAt: now`,
   `hubspotSyncedBy: req.user.email`, `hubspotError: null`) and returns it.
5. On any thrown error, route persists `hubspotStatus: 'failed'` +
   `hubspotError: <message>` and returns 502 with the error message; the
   contact's prior `hubspotContactId` (if any) is left untouched.

## Fields pushed

Adapted from WOLF+, dropping only what depends on outreach-sequence
generation (Prospector doesn't have that):

- **Company:** `name`, `domain`, `country`, `numberofemployees`,
  `linkedin_company_page`, `hubspot_owner_id`, `inbound_outbound: 'OUTBOUND'`,
  `lifecyclestage: '209865412'` ("Outbound Qualified Lead").
- **Contact:** `firstname`, `lastname`, `email`, `jobtitle`,
  `linkedin_profile`, `hubspot_owner_id`, `hs_marketable_status: false`,
  `hs_lead_status: 'NEW'`, `lead_source: 'Outbound'`, `mql_sql: 'SQL'`.
- **Not included:** `clay_subject_line`/`clay_content`/`clay_german_content`/
  `clay_email_body_3`, `ai_talk_tracks`, and sequence enrollment — Prospector
  generates no outreach copy, so there's nothing to put in those fields.

## Owner attribution

`hubspot_owner_id` is resolved per push from the *list's* assigned SDR
(`list.assignedTo`), not the clicking user (matters only for admins pushing
on behalf of an SDR) and not a hardcoded default. Resolution is a live
HubSpot Owners API lookup by email, cached in-process (owners rarely
change) to avoid a round trip on every click.

**If no HubSpot owner matches that email:** the push fails outright with a
clear error ("No HubSpot user found for `<email>` — ask an admin to check
their HubSpot account email"). No fallback to a default owner — silently
mis-attributing a contact to the wrong person is worse than a blocked push.

## Error handling

| Condition | Behavior |
|---|---|
| Contact/Company/List not found | 404 |
| SDR pushing a contact not on their own list | 403 (existing pattern) |
| No HubSpot owner for the SDR's email | 502, `hubspotStatus: 'failed'`, actionable message |
| Contact already exists in HubSpot (unambiguous) | 200, `hubspotStatus: 'already_existed'`, existing ID stored, no duplicate created |
| Ambiguous match (>1 contact) | 502, `hubspotStatus: 'failed'`, no writes |
| Ambiguous company match (>1 company for domain) | 502, `hubspotStatus: 'failed'`, no writes |
| HubSpot API 429/5xx | One retry (reuse WOLF+'s retry-after handling), then surface as failure |
| Missing `HUBSPOT_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` at boot | Same pattern as `APOLLO_PEOPLE_KEY` — fail fast at boot, not on first click |

Button UI states driven by `hubspotStatus`:
- `none` → "Add to HubSpot" (active)
- `synced` → "✓ In HubSpot" (disabled)
- `already_existed` → "Already in HubSpot" (disabled)
- `failed` → "Add to HubSpot" re-enabled, with `hubspotError` shown inline (retryable)

## Config

New env vars (same shape as WOLF+, added to `HANDOFF.md`'s env list):
```
HUBSPOT_CLIENT_ID=<HubSpot app client id>
HUBSPOT_CLIENT_SECRET=<HubSpot app client secret>
HUBSPOT_REFRESH_TOKEN=<OAuth refresh token for the connected HubSpot account>
```

## Testing

- `hubspotService` unit tests with an injected fake HTTP client (mirroring
  `apolloPeopleService.test.js` conventions): owner lookup found/not-found,
  contact dedup hit/miss/ambiguous, company dedup hit/miss/ambiguous,
  successful create + associate, 429 retry.
- Route tests (supertest + in-memory Mongo, fake `hubspotService`): 404s,
  403 (cross-SDR), persisted status on success/already-existed/failure,
  response shape.
- No live HubSpot calls in any test — first real call is a manual smoke
  test against a real HubSpot sandbox/portal, same posture as contact
  sourcing's first Apollo call.
- No frontend test suite exists in this repo (per `HANDOFF.md`); button
  states verified by build + manual click-through, not automated.

## Out of scope (explicitly deferred)

- Outreach sequence enrollment / auto-generated email copy.
- Bulk/automatic push (e.g. push-all-on-confirm) — this is a manual,
  per-contact action only.
- Two-way sync (detecting HubSpot-side changes, updates, deletes) — this is
  insert-only, matching WOLF+'s posture.
