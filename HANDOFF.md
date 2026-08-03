# Prospector — Handoff

Standalone prospecting app, built external to WOLF+ (the `The-Wolf`/`wolf-frontend` project). SDRs can self-serve pull companies from Apollo (region + ICP profile; system pulls in batches until 5 AI-qualified leads reached), or admins can assign count-based pulls to an SDR. AI-qualifies them with Claude using the same rubric WOLF+ uses, groups each pull into a **list**, and gives an SDR a review flow to accept/reject leads. Once the SDR confirms the review, it sources up to 4 ranked decision-maker contacts per accepted company (Apollo people search + Claude picker). Nothing downstream of that yet — no HubSpot push, no outreach/sequencing. This repo has its own git history (16 commits, `main` branch) split out of a WOLF+ working branch — WOLF+ itself no longer contains any of this code.

## Layout

```
backend/    Express 5 + Mongoose, port 4000, CommonJS
frontend/   React 18 + Vite, port 5174, no auth
```

Full design/build history (spec, plan, per-task review notes) lived in the WOLF+ repo during development:
- `WOLF+/docs/superpowers/specs/2026-07-19-prospector-design.md` — the approved design
- `WOLF+/docs/superpowers/plans/2026-07-19-prospector.md` — the task-by-task implementation plan (has the original code for every file, useful if you need to see "why does it look like this")

## Data

New MongoDB database **`PROSPECTOR`** on the same Atlas cluster WOLF+ uses (`wolf.mmsclxg.mongodb.net`). WOLF+'s own `WOLF+` database is untouched. Collections: `lists`, `companies`, `contacts`, `pipelinestates`.

## Run it

```bash
cd backend && npm install && npm run dev   # port 4000
cd frontend && npm install && npm run dev  # port 5174
```

`backend/.env` (gitignored, not in the repo — recreate it) needs:
```
MONGODB_URI=<same value as The-Wolf/.env>
APOLLO_API_KEY=<same value as The-Wolf/.env>
APOLLO_PEOPLE_KEY=<same value as The-Wolf/.env — a DIFFERENT key to APOLLO_API_KEY>
HUBSPOT_CLIENT_ID=<HubSpot app client id>
HUBSPOT_CLIENT_SECRET=<HubSpot app client secret>
HUBSPOT_REFRESH_TOKEN=<OAuth refresh token for the connected HubSpot account>
ANTHROPIC_API_KEY=<same value as The-Wolf/.env>
SESSION_SECRET=<any long random string; rotating it signs everyone out>
PORT=4000
```

## Sign-in

Email plus password, with no account picker. Only addresses in
`backend/src/config/users.js` can sign in — that file stays the allowlist and
the source of roles and regions; the `Credential` collection holds only the
hashed secret. Identity is a signed httpOnly cookie, re-checked against the
allowlist on every request, so removing someone from `users.js` ends their
session immediately. The `X-User-Email` header is ignored — it used to *be* the
identity, which let anyone impersonate anyone.

Passwords are hashed with scrypt (Node built-in, memory-hard). Ten failed
attempts locks an address for 15 minutes; a successful sign-in or an admin reset
clears the lock.

Admins issue passwords; there is no self-service reset:
```
node scripts/passwords.js init            # create for anyone missing one
node scripts/passwords.js reset <email>   # new password for one person
node scripts/passwords.js reset-all       # new password for everyone
node scripts/passwords.js list            # who is set up (prints no secrets)
```
Generated passwords are shown once and never stored in the clear — if one is
lost, reset it. Anyone holding an admin-issued password is forced to choose
their own before reaching the app, and that is enforced by the API as well as
the UI, so skipping the screen buys nothing.

`APOLLO_PEOPLE_KEY` is a second Apollo credential (separate account/credit
pool) used only for people search + bulk match during contact sourcing.
Company pulls work without it; contact sourcing does not.

Backend tests: `cd backend && npm test` (87/87 passing, in-memory Mongo, no real API calls).

## What's built

- **Pull**: Two modes: (1) **SDR self-serve**: `POST /api/pull { profile, region }` (no count) → creates a List, system pulls in batches (first 10, then top-ups) until 5 AI-qualified leads reached; daily quota 5 leads/SDR (resets midnight `Asia/Jerusalem`, 429 if exceeded); SDR must be assigned to region (403 otherwise). (2) **Admin**: `POST /api/pull { profile, region, count, sdrEmail }` → count-based pull assigned to specified SDR (no quota, no region check). Both run in-process (Apollo search+enrich → Claude batch qualify), progress polled via `GET /api/lists/:id` (no SSE/WebSockets by design). Multiple SDRs can pull simultaneously (per-SDR concurrency, atomic item-index cursor prevents skips/doubles) — replaced old single-global-pull serialization.
- **Qualify**: Claude `claude-sonnet-4-6` via the Message Batches API, same ICP rubric/tools as WOLF+ (`backend/src/config/prompt.md`, copied verbatim). Verdict → `qualified` / `nei` (not enough info) / `disqualified`.
- **Review**: SDR works a list bucket-by-bucket (qualified → nei → disqualified), sees company + domain + qualification reasoning + signals, hits Accept/Reject. Their decision (`sdrStatus`) is final and overrides the AI verdict. `POST /api/leads/:id/decision`.
- **Confirm review**: `POST /api/lists/:id/confirm-review` (owner-checked, list must be `reviewed`). Sets `reviewConfirmedAt`, which **locks every decision on that list** — `POST /api/leads/:id/decision` returns 409 from then on. If any company is accepted the list goes to `sourcing` and the sourcing job fires (fire-and-forget); with zero accepted it goes straight to `sourced`.
- **Contact sourcing**: `contactService.sourceList(listId)` walks the accepted companies: `apolloPeopleService.searchCandidates(domain)` (46 broad titles, `include_similar_titles`) → `bulkMatch` in batches of 10 for emails/phones → `pickContacts` (Claude `claude-haiku-4-5`, `select_contacts` tool) picks up to 4 ranked best-first, rank 1 flagged `isPrimary`. Titles matching `EXCLUDED_TITLES` (finance/legal/marketing/sales/HR/…) are filtered out before the model sees them. Contacts are delete-then-insert per company so re-sourcing is clean. `Company.contactStatus` ends `found` or `none` (`none` = no domain, no search hits, or no viable decision maker — a normal outcome). `GET /api/lists/:id/contacts` returns `[{ company, contacts[] }]` sorted by rank. Config is verbatim from WOLF+ `icp-qualifier/src/services/contactService.js`, adapted from 1 contact to up-to-4.
- **HubSpot push**: `POST /api/contacts/:id/hubspot` pushes one sourced contact (and its company, if not already there) into HubSpot under the owning SDR (owner resolved live via HubSpot's Owners API by email — fails loudly if no match, no fallback owner). Dedup by domain (company) and email/LinkedIn (contact) is checked first; an existing match is reused/reported rather than duplicated. Insert-only, no updates/deletes, no outreach-sequence enrollment (Prospector generates no outreach copy). Button lives on each contact card in the Contacts screen; state (`hubspotStatus`) persists across refresh.
- **Frontend**: four screens — Pull, Lists (dashboard, polls every 5s), Review (bucket queue with undo, ending in a confirm gate), Contacts (stat strip + one card per accepted company with its ranked contact mini-cards; polls every 3s while sourcing).

Verified end-to-end with a real 5-lead pull against live Apollo/Claude/Atlas — all three screens screenshotted and working, console clean.

## Known non-blocking follow-ups (deferred at merge, not urgent)

- `apolloService.mapOrganization`'s website fallback can produce the literal string `"https://undefined"` when Apollo returns no domain at all (only affects already-disqualified no-domain companies).
- Qualification-chunk logic (chunks of 30) is only tested with small batches — never exercised with >30 companies in one pull.
- `qualifierService.persistResult` never clears a stale `tier` if a company is ever re-qualified to disqualified (no code path re-qualifies today, so currently unreachable).
- Dashboard counts' zero-company fallback and the ready/reviewed list-flip guard aren't directly unit tested (verified correct by code review, just not covered).
- ObjectId-validation is duplicated across `routes/lists.js` and `routes/leads.js` — could be a shared helper.
- `ReviewScreen`'s first "Undo last" on a list with prior-session decisions can revert one of those historical decisions rather than being a no-op (session's `done` array isn't sorted by `sdrReviewedAt`).
- Tier badge in `LeadCard.jsx` reuses the `.badge.pending` CSS class purely for its color.

- **Contact sourcing has never made a live Apollo people call.** Every test injects a fake `post`, so the endpoint URLs (`mixed_people/api_search`, `people/bulk_match`), the `X-Api-Key` header shape, and the `data.people` / `data.matches` response shapes are all inherited from WOLF+ and unverified here. First real run is the test.
- The `cache_control` markers on the picker's system prompt and tool are effectively no-ops: Haiku 4.5 needs a ~4096-token cacheable prefix and the picker prompt is far shorter, so the cache never populates (silent, no error).
- The Contacts view has no frontend test coverage (the repo has no frontend test suite) — verified by build only, not exercised in a browser.
- **HubSpot push has never made a live HubSpot call.** Every test injects a fake `request`, so the OAuth token exchange, owner-lookup endpoint, and object create/search endpoints are all unverified against the real API. First real run is the test, same posture contact sourcing shipped with for Apollo people search.

None of these block using the app — they're small, scoped cleanups for whenever this area gets touched next.

## Next likely asks

- Deploying it somewhere the SDR can reach without your machine running
