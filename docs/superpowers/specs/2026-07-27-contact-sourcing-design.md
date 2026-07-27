# Contact sourcing (confirm review → find 1-4 decision-makers) — design

## Problem

After an SDR finishes reviewing a list (accepts/rejects every lead), the
accepted companies have no *people* attached — just firmographics. Scytale's
WOLF+ product already finds a decision-maker contact per company via Apollo;
Prospector needs the same, with two differences:

1. It's gated behind an explicit **"Confirm list review"** step, and
2. it returns **1-4 ranked contacts** per company instead of a single one.

## Goals

1. When a list becomes fully reviewed (0 pending leads), pop a **"Confirm list
   review"** modal. Confirming **locks** the review (decisions final) and
   starts contact sourcing as a background job with live progress.
2. Source contacts only for **accepted** companies (SDR `sdrStatus:'accepted'`).
3. Mirror WOLF+'s Apollo pipeline (search → bulk-enrich → AI picker) but return
   **up to 4 ranked** decision-makers per company, all saved and shown.
4. A **Contacts view** on the list detail that displays each accepted company
   with its 1-4 contacts, visually consistent with the existing dark
   indigo/violet design system.

## Non-goals

- HubSpot / outreach / sequences / email sending — WOLF+'s `contacts.js` has
  all of that; **none of it is in scope**. We stop at "contacts found and
  displayed."
- Manual add-a-contact-by-Apollo-ID, re-sequencing, enrollment — out of scope.
- SDR choosing among the 1-4 — the AI ranks; all are shown; no selection step.
- Deployment / live smoke test — deferred until the full feature set is built.

## WOLF+ source (mirrored)

`WOLF+/The-Wolf/icp-qualifier/src/services/contactService.js` is the reference.
The pipeline we copy, per company:

1. Derive `domain` from `website` (`new URL(...).hostname` minus `www.`).
2. **Search** `POST https://api.apollo.io/api/v1/mixed_people/api_search` with
   `{ per_page: 25, q_organization_domains_list: [domain], person_titles:
   BROAD_SEARCH_TITLES, include_similar_titles: true }`.
3. **Bulk-enrich** `POST /api/v1/people/bulk_match` with
   `{ details: [{id, domain}], reveal_personal_emails: true }`, in batches of 10.
4. **AI picker** (Claude Haiku, model `claude-haiku-4-5-20251001`): filter out
   `EXCLUDED_TITLES` (sales/marketing/HR/finance/legal/CS/…), then pick using
   the ICP-priority system prompt + `PROFILE_CONTEXT`.
5. Persist contact(s); set `Company.contactStatus`.

`BROAD_SEARCH_TITLES`, `EXCLUDED_TITLES`, `PROFILE_CONTEXT`, and the AI system
prompt are copied verbatim from WOLF+ into a Prospector config module. Apollo
people calls use a **separate `APOLLO_PEOPLE_KEY`** env var (as WOLF+ does),
distinct from the company-search `APOLLO_API_KEY`.

**Our one change to the picker:** the tool becomes `select_contacts` returning
an array of **up to 4** `{ apolloPersonId, rank, reasoning }` (rank 1 = best),
or an empty array if none qualify. We save all returned, capped at 4.

## Data model

### New `backend/src/models/Contact.js`
```js
{
  companyId:      ObjectId(ref 'Company', required, index),
  listId:         ObjectId(ref 'List', required, index),
  apolloPersonId: String (required),
  domain:         String,
  firstName:      String,
  lastName:       String,
  title:          String,
  email:          String,           // may be null — contact still shown
  linkedinUrl:    String,
  phone:          String,
  rank:           Number,           // 1..4 (1 = best)
  isPrimary:      Boolean,          // rank === 1
  reasoning:      String,           // AI's one-line rationale
  // timestamps
}
// unique compound index { companyId: 1, apolloPersonId: 1 }
```
Contact is scoped to a company (and its list), not global — re-sourcing a
company replaces its contacts cleanly.

### `backend/src/models/Company.js`
Add `contactStatus: { enum: ['pending','sourcing','found','none'], default:
'pending' }`. `found` = ≥1 contact saved; `none` = no viable decision-maker.

### `backend/src/models/List.js`
- `status` enum gains `'sourcing'` and `'sourced'`.
  Happy path: `pulling → qualifying → ready → reviewed → sourcing → sourced`.
- Add `reviewConfirmedAt: Date`.

## Confirm gate

### Route: `POST /api/lists/:id/confirm-review`
- SDR must own the list (admin allowed); list `status` must be `'reviewed'`
  (0 pending leads) → else `409 { error: 'List is not fully reviewed' }`.
- Sets `reviewConfirmedAt = now`. If there are **accepted** companies: set
  `status:'sourcing'`, set those companies' `contactStatus:'sourcing'`, and
  fire `contactService.sourceList(listId)` fire-and-forget (like a pull).
  If **0 accepted**: set `status:'sourced'` immediately (nothing to source).
- Returns the updated list.

### Locking (decisions final after confirm)
`POST /api/leads/:id/decision` (`leads.js`): after loading the owner list, if
`reviewConfirmedAt` is set (or status ∈ `sourcing`/`sourced`), reject with
`409 { error: 'Review already confirmed — decisions are locked' }`. The
existing `ready ↔ reviewed` auto-flip is unchanged for un-confirmed lists.

## Contact sourcing service — `backend/src/services/contactService.js`

`sourceList(listId, deps = {})` (deps inject `search`, `bulkMatch`, `pick` for
tests):
1. Load accepted companies: `Company.find({ listId, sdrStatus:'accepted' })`.
2. For each (bounded by a shared concurrency limiter on Apollo people calls):
   search → bulk_match → `pickContacts` (AI, up to 4). Write progress to the
   list's `lastMessage`/`progressLog` (reuse `pullService.logProgress`
   pattern), e.g. "Sourcing 3/12: Acme — 2 contacts".
3. Save contacts (delete-then-insert per company so re-source is clean), set
   `Company.contactStatus` (`found`/`none`).
4. On completion set `List.status = 'sourced'`; on a thrown error set
   `'failed'` with the message (mirrors `runPull`). Startup recovery
   (`markStaleListsFailed`) extends to cover `'sourcing'`.

`pickContacts(enrichedCandidates, company)` = the WOLF+ picker adapted to
return an array of up to 4 ranked contacts (empty if none).

### Read route: `GET /api/lists/:id/contacts`
Ownership-checked. Returns accepted companies each with their contacts, ranked:
```
[{ company: { _id, companyName, website, tier, contactStatus },
   contacts: [{ firstName, lastName, title, email, linkedinUrl, phone,
                rank, isPrimary, reasoning }] }]
```

## Frontend

### Confirm modal — `ReviewScreen.jsx`
The existing "Review complete 🎉" panel (shown when the queue empties) gains
the confirm flow: a modal/panel "You've reviewed all N leads — X accepted.
Confirm to lock decisions and find contacts." **Confirm** calls
`confirmReview(listId)` and transitions the list detail to the Contacts view;
**Cancel** leaves it (SDR can still Undo/adjust until they confirm). If X = 0,
copy reads "No accepted leads to source" and Confirm just finalizes.
The modal auto-appears on finishing the last lead (queue empty + not yet
confirmed).

### Contacts view — `ListDetailScreen.jsx` + new `ContactsScreen.jsx`
- When `list.status` ∈ `sourcing`/`sourced`, the segmented control shows a
  **Contacts** tab (default-selected for these statuses); Table stays
  available, Card review is hidden (locked).
- `ContactsScreen`:
  - **Stat strip:** accepted · companies with contacts · total contacts ·
    emailable.
  - While `sourcing`: pull-style progress (message + indeterminate bar + log),
    polled every 3s via `fetchList`.
  - **One card per accepted company** (reusing `panel`/card styling): header
    with company name, tier badge, website link, `contactStatus` pill; below,
    a wrapping row of **1-4 contact mini-cards**:
    - initials avatar, **name** (bold), **title** (muted); rank 1 shows a
      **"★ Primary"** ribbon, others ordered by rank.
    - small italic **reasoning** line.
    - actions: **Email** (copy + `mailto:`), **LinkedIn** icon-link, **Phone**
      if present. No email → muted "no email" chip, email action disabled.
    - no viable contact → muted "No decision-maker found" state.
- New API client fns in `api.js`: `confirmReview(id)` → `POST
  /api/lists/:id/confirm-review`; `fetchContacts(id)` → `GET
  /api/lists/:id/contacts`.

## Config / env

- New `backend/src/config/contactFilters.js`: `BROAD_SEARCH_TITLES`,
  `EXCLUDED_TITLES`, `PROFILE_CONTEXT`, AI system prompt — copied from WOLF+.
- `backend/.env` needs `APOLLO_PEOPLE_KEY` (people-search key). Document in
  README/HANDOFF; the `.env.example`/setup notes gain the new var.

## Error handling

- `409` — confirm on a not-fully-reviewed list; decision on a locked list.
- `403` — SDR touching another SDR's list (existing ownership pattern).
- Per-company sourcing failures are logged and set that company's
  `contactStatus` appropriately without failing the whole list; a top-level
  throw marks the list `failed` (like `runPull`).
- No domain / no candidates / no viable contact → `contactStatus:'none'`.

## Testing

Backend (`backend/test/`, mocked Apollo + Anthropic via deps injection, in
line with `pullService`/`qualifierService` tests):
- **contactService**: picker returns up to 4 ranked (rank 1 = isPrimary);
  no-domain / no-candidates / no-viable → `contactStatus:'none'`; contacts
  saved with correct fields; re-source replaces cleanly; list ends `sourced`;
  a thrown error marks the list `failed`.
- **confirm-review route**: ownership (403), must be `reviewed` (409
  otherwise), fires the job + sets `sourcing`, 0-accepted → `sourced`
  immediately, sets `reviewConfirmedAt`.
- **decision lock**: `POST /leads/:id/decision` → 409 once the list's review is
  confirmed.
- **contacts read route**: ownership-checked; returns accepted companies with
  ranked contacts.
- **Company.contactStatus / List status+reviewConfirmedAt**: schema defaults
  and enums.

Frontend: build + manual (no test suite) — confirm modal on completion, lock
prevents further decisions, Contacts view renders 1-4 cards with primary
ribbon and disabled email when absent, sourcing progress polls.

## Doc updates

`README.md` / `HANDOFF.md`: document the confirm-review → contact-sourcing
flow, the 1-4 ranked contacts, the new `APOLLO_PEOPLE_KEY`, and that HubSpot/
outreach remains out of scope.
