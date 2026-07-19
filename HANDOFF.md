# Prospector — Handoff

Standalone prospecting app, built external to WOLF+ (the `The-Wolf`/`wolf-frontend` project). Pulls companies from Apollo by count/region/ICP profile, AI-qualifies them with Claude using the same rubric WOLF+ uses, groups each pull into a **list**, and gives an SDR a review flow to accept/reject leads. Nothing downstream yet — no HubSpot push, no contact finding. This repo has its own git history (16 commits, `main` branch) split out of a WOLF+ working branch — WOLF+ itself no longer contains any of this code.

## Layout

```
backend/    Express 5 + Mongoose, port 4000, CommonJS
frontend/   React 18 + Vite, port 5174, no auth
```

Full design/build history (spec, plan, per-task review notes) lived in the WOLF+ repo during development:
- `WOLF+/docs/superpowers/specs/2026-07-19-prospector-design.md` — the approved design
- `WOLF+/docs/superpowers/plans/2026-07-19-prospector.md` — the task-by-task implementation plan (has the original code for every file, useful if you need to see "why does it look like this")

## Data

New MongoDB database **`PROSPECTOR`** on the same Atlas cluster WOLF+ uses (`wolf.mmsclxg.mongodb.net`). WOLF+'s own `WOLF+` database is untouched. Collections: `lists`, `companies`, `pipelinestates`.

## Run it

```bash
cd backend && npm install && npm run dev   # port 4000
cd frontend && npm install && npm run dev  # port 5174
```

`backend/.env` (gitignored, not in the repo — recreate it) needs:
```
MONGODB_URI=<same value as The-Wolf/.env>
APOLLO_API_KEY=<same value as The-Wolf/.env>
ANTHROPIC_API_KEY=<same value as The-Wolf/.env>
PORT=4000
```

Backend tests: `cd backend && npm test` (31/31 passing, in-memory Mongo, no real API calls).

## What's built

- **Pull**: `POST /api/pull { profile, region, count }` → creates a List, runs in-process (Apollo search+enrich → Claude batch qualify), progress polled via `GET /api/lists/:id` (no SSE/WebSockets by design). One pull at a time (409 otherwise), max 200/pull.
- **Qualify**: Claude `claude-sonnet-4-6` via the Message Batches API, same ICP rubric/tools as WOLF+ (`backend/src/config/prompt.md`, copied verbatim). Verdict → `qualified` / `nei` (not enough info) / `disqualified`.
- **Review**: SDR works a list bucket-by-bucket (qualified → nei → disqualified), sees company + domain + qualification reasoning + signals, hits Accept/Reject. Their decision (`sdrStatus`) is final and overrides the AI verdict. `POST /api/leads/:id/decision`.
- **Frontend**: three screens — Pull, Lists (dashboard, polls every 5s), Review (bucket queue with undo).

Verified end-to-end with a real 5-lead pull against live Apollo/Claude/Atlas — all three screens screenshotted and working, console clean.

## Known non-blocking follow-ups (deferred at merge, not urgent)

- `apolloService.mapOrganization`'s website fallback can produce the literal string `"https://undefined"` when Apollo returns no domain at all (only affects already-disqualified no-domain companies).
- Qualification-chunk logic (chunks of 30) is only tested with small batches — never exercised with >30 companies in one pull.
- `qualifierService.persistResult` never clears a stale `tier` if a company is ever re-qualified to disqualified (no code path re-qualifies today, so currently unreachable).
- Dashboard counts' zero-company fallback and the ready/reviewed list-flip guard aren't directly unit tested (verified correct by code review, just not covered).
- ObjectId-validation is duplicated across `routes/lists.js` and `routes/leads.js` — could be a shared helper.
- `ReviewScreen`'s first "Undo last" on a list with prior-session decisions can revert one of those historical decisions rather than being a no-op (session's `done` array isn't sorted by `sdrReviewedAt`).
- Tier badge in `LeadCard.jsx` reuses the `.badge.pending` CSS class purely for its color.

None of these block using the app — they're small, scoped cleanups for whenever this area gets touched next.

## Next likely asks

- HubSpot push for `sdrStatus: 'accepted'` companies (WOLF+'s `The-Wolf/services/hubspotService.js` has the dedup/insert pattern to reuse)
- Contact/decision-maker finding (WOLF+'s `contactService.js` does this via Apollo people search + AI picking)
- Deploying it somewhere the SDR can reach without your machine running
