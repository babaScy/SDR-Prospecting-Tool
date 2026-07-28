# Prospector

Standalone prospecting app (external to WOLF+). SDRs can self-serve pull companies
from Apollo (region + ICP profile; system pulls in batches until 5 AI-qualified
leads reached), or admins can assign count-based pulls to an SDR. AI-qualifies
companies against the Scytale ICP rubric (Claude) and gives an SDR a per-list
accept/reject review flow. Once the SDR confirms their review, the app sources
up to 4 ranked decision-maker contacts per accepted company (Apollo people
search + Claude picker). Accepted leads will later be pushed to HubSpot (not
built yet).

Spec: `../docs/superpowers/specs/2026-07-19-prospector-design.md`
Contact sourcing: `docs/superpowers/specs/2026-07-27-contact-sourcing-design.md`

## Run

Backend (port 4000):

    cd backend && npm install && npm run dev

Frontend (port 5174):

    cd frontend && npm install && npm run dev

Open http://localhost:5174

## Environment

`backend/.env` needs `MONGODB_URI`, `APOLLO_API_KEY`, `ANTHROPIC_API_KEY`,
`APOLLO_PEOPLE_KEY` (same values as `The-Wolf/.env`). Data lives in the
`PROSPECTOR` database on the shared Atlas cluster — the `WOLF+` database is
never touched.

`APOLLO_PEOPLE_KEY` is a **separate Apollo credential** from `APOLLO_API_KEY`
(different account/credit pool) and is only used by contact sourcing — company
pulls work without it, contact sourcing does not.

## Tests

    cd backend && npm test

## Notes

- **SDR self-serve pulls**: SDR picks region + ICP profile only; system pulls in
  batches (first 10, then top-ups) until 5 AI-qualified leads reached. Daily
  quota: 5 AI-qualified leads per SDR, resets at midnight `Asia/Jerusalem`
  (returns 429 if quota exceeded). Each SDR is assigned specific regions and can
  only pull from those (returns 403 for unauthorized region).
- **Per-SDR concurrency**: Multiple SDRs can pull simultaneously (even same
  region) safely via atomic item-index cursor — no skipped or double-pulled
  companies. This replaced the old single-global-pull serialization.
- **Admin pulls**: Unchanged — admin still does count-based pulls assigned to an
  SDR (no daily quota, no region restriction).
- **Contact sourcing**: when the SDR finishes a list they hit *Confirm list
  review*. That locks every accept/reject decision on the list (further
  `POST /api/leads/:id/decision` calls return 409) and kicks off sourcing for
  the accepted companies. Each one gets an Apollo people search, a bulk email/
  phone match, and a Claude pick of up to 4 decision makers ranked best-first
  (rank 1 is flagged primary). Companies with no domain or no viable
  decision-maker end as `contactStatus: 'none'` — that's a normal outcome, not
  a failure. List status runs `reviewed → sourcing → sourced` (or `failed`);
  a list with zero accepted companies goes straight to `sourced`.
- HubSpot push and any outreach/sequencing remain out of scope.
- Progress is polled from the List document — no SSE.
- Restarting the backend mid-pull marks the running list `failed`; its
  already-saved leads remain reviewable.
