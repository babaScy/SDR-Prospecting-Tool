# Roles & list assignment — design

## Problem

The app has no concept of identity today (per `HANDOFF.md`: "no auth"). Anyone
who opens it can run pulls and review any list. This is becoming a real
internal team tool with two roles:

- **Admin** (`yonia@scytale.ai`) — runs pulls on behalf of a specific SDR, and
  can see/review every list regardless of who it's assigned to.
- **SDR** (`davidv@scytale.ai`, `danielp@scytale.ai`, `darrent@scytale.ai`,
  `jillianl@scytale.ai`, `khadym@scytale.ai`) — only sees and acts on lists
  assigned to them, working leads toward being ready for HubSpot (not
  connected yet — out of scope here).

## Goals

1. A lightweight identity picker (no password) that the app remembers.
2. Every list is assigned to exactly one SDR at creation time, chosen by the
   admin when they run the pull.
3. Server-side enforcement: an SDR cannot see or act on another SDR's list,
   even by calling the API directly. Admin bypasses this everywhere.
4. Nav/UI reflects the role: SDRs don't see the Pull screen at all.

## Non-goals

- Real authentication (passwords, magic links, SSO) — out of scope. The
  allowlist approach is intentionally only as strong as team trust; revisit if
  the app becomes externally reachable or the team grows.
- HubSpot integration — explicitly not connected yet. This project changes who
  can act on a list, not what happens after a lead is accepted.
- Backfilling `assignedTo` on the 2 existing dev-data lists — they'll simply
  be admin-only-visible until someone reassigns them (out of scope; trivial to
  do by hand in Mongo if needed).
- Per-SDR filter/search on the admin Lists table — admin sees everything in
  one table with an added "Assigned to" column; no new filter UI.

## Architecture

Identity travels as a header, not a session/cookie/token:

```
Frontend picker → localStorage['prospectorUser'] = email
                → every API call: header X-User-Email: <email>
Backend middleware → looks up email in a static allowlist (role: admin|sdr)
                   → req.user = { email, role }  (401 if missing/unknown)
Route handlers    → use req.user to filter/authorize
```

### Backend: `backend/src/config/users.js` (new)

A static array, same pattern as the existing `config/prompt.md`:

```js
module.exports = [
  { email: 'yonia@scytale.ai',   role: 'admin' },
  { email: 'davidv@scytale.ai',  role: 'sdr' },
  { email: 'danielp@scytale.ai', role: 'sdr' },
  { email: 'darrent@scytale.ai', role: 'sdr' },
  { email: 'jillianl@scytale.ai',role: 'sdr' },
  { email: 'khadym@scytale.ai',  role: 'sdr' },
];
```

### Backend: `backend/src/middleware/currentUser.js` (new)

Reads `X-User-Email`, looks it up, sets `req.user`. Applied to all `/api`
routes in `app.js`. Missing header or unrecognized email → `401
{ error: 'Unknown or missing user' }`.

### Data model: `backend/src/models/List.js`

Add `assignedTo: { type: String, required: true }` — the SDR's email. Set once
by `POST /api/pull` from the request body; never changed afterward (no
reassignment flow in this pass — not asked for).

### Backend: authorization changes

- `POST /api/pull` (`backend/src/routes/pull.js`) — require `req.user.role ===
  'admin'` (403 otherwise). Body gains `assignedTo`, validated against the
  `users.js` allowlist's SDR emails (400 if missing/not an SDR). `List.create`
  includes `assignedTo`.
- `GET /api/lists` (`lists.js`) — admin: unchanged (all lists). SDR: add
  `{ assignedTo: req.user.email }` to the `List.find()` query.
- `GET /api/lists/:id`, `GET /api/lists/:id/leads` — after loading the list,
  if `req.user.role === 'sdr' && list.assignedTo !== req.user.email`, return
  `403 { error: 'Not your list' }`.
- `POST /api/leads/:id/decision` (`leads.js`) — after loading the company,
  load its parent `List`, apply the same ownership check before applying the
  decision.

### Frontend: identity

- New `frontend/src/components/UserPicker.jsx` — radio list of the 6 emails
  (label shows role next to admin), "Continue" button, writes
  `localStorage.prospectorUser` and calls `onPick(email)`.
- `frontend/src/api.js`'s `request()` adds `X-User-Email:
  localStorage.getItem('prospectorUser')` to every call's headers.
- `App.jsx`: on mount, read `localStorage.prospectorUser`. If absent, render
  `UserPicker` instead of the normal nav/main. Once set, derive role from the
  frontend's local allowlist copy (see "How the frontend knows the current
  role" below) to decide nav visibility.
- Topbar gains a profile chip (email + role) with a "Switch" link that clears
  `localStorage` and re-shows `UserPicker`.
- A `401` from any API call (e.g. stale/cleared identity) also clears storage
  and bounces to `UserPicker`, so a revoked/mistyped identity self-heals
  instead of showing a wall of errors.

### Frontend: role affects nav and screens

- Nav: admin → `Pull` + `Lists`. SDR → `Lists` only.
- `PullScreen.jsx` — new required "Assign to" `<select>` of the 5 SDR emails,
  included in the `startPull` body.
- `ListsScreen.jsx` — admin's table gets an "Assigned to" column. SDR's table
  is already server-filtered to their own lists, so no client-side change
  needed there; the existing totals strip keeps summing whatever rows are
  present (global for admin, personal for SDR — same code, different data).
- `ListDetailScreen`/`ListTable`/`ReviewScreen` — no logic changes. A `403`
  from the backend (e.g. someone follows a stale link to another SDR's list)
  surfaces through the existing `error` banner pattern already used
  everywhere else in these components.

### How the frontend knows the current role

Simplest option: `fetchList`/`fetchLists` responses don't carry role, so the
frontend keeps its own tiny copy of the email→role mapping (5 SDR emails +
admin) alongside `UserPicker`, just for nav/UI decisions. The backend remains
the actual authority (enforces via `req.user`, not by trusting the frontend's
copy) — this local list is only ever used to decide what to *show*, never to
grant access.

## Data flow (SDR reviewing a list)

1. First visit: no `localStorage.prospectorUser` → `UserPicker` shown → SDR
   picks their email → stored, `App` re-renders with `Lists`-only nav.
2. `ListsScreen` calls `GET /api/lists` with `X-User-Email: davidv@scytale.ai`
   → middleware resolves `req.user = {email, role: 'sdr'}` → route filters to
   `assignedTo: 'davidv@scytale.ai'` → only their lists return.
3. Clicking a list → `ListDetailScreen` → `GET /api/lists/:id/leads` with the
   same header → middleware + ownership check pass (it's their list) → table
   loads normally.
4. If they somehow hit a URL/id for another SDR's list, the same check fails
   → `403` → the table/card screen's existing error state shows it, no crash.

## Error handling

- `401` (missing/unrecognized `X-User-Email`) — any API call: clear stored
  identity, show `UserPicker`.
- `403` (SDR touching another SDR's list) — surfaced via existing per-screen
  error banners; no new UI component needed.
- `400` (`POST /api/pull` missing/invalid `assignedTo`, or non-admin calling
  it) — surfaced via `PullScreen`'s existing error handling.

## Testing

- Backend (`backend/test/`):
  - New test file for `currentUser` middleware: missing header → 401, unknown
    email → 401, valid email → `req.user` populated correctly.
  - `dashboardRoutes.test.js`: `GET /api/lists` as an SDR only returns their
    own; as admin returns all. `GET /api/lists/:id` and `/leads` — 403 for a
    non-owning SDR, 200 for admin and for the owning SDR.
  - `pullRoute.test.js`: 403 for a non-admin caller; 400 for missing/invalid
    `assignedTo`; successful pull stores `assignedTo`.
  - Decision route: 403 for a non-owning SDR, 200 for admin and the owning
    SDR.
- Frontend: manual browser verification (no test suite exists) — picker flow,
  nav differences per role, pull with assignment, SDR seeing only their own
  lists, a 403 surfacing cleanly, switch-user flow, 401 self-heal.

## Doc fix (incidental)

`README.md`/`HANDOFF.md`'s "no auth" mention is now stale once this project
ships — update it to reflect the new admin/SDR identity model. (The
"HubSpot (not built yet)" line was briefly mis-edited to say "Clay" during
this project and has been corrected back to HubSpot.)
