# Prospector

Standalone prospecting app (external to WOLF+). SDRs can self-serve pull companies
from Apollo (region + ICP profile; system pulls in batches until 5 AI-qualified
leads reached), or admins can assign count-based pulls to an SDR. AI-qualifies
companies against the Scytale ICP rubric (Claude) and gives an SDR a per-list
accept/reject review flow. Accepted leads will later be pushed to HubSpot (not
built yet).

Spec: `../docs/superpowers/specs/2026-07-19-prospector-design.md`

## Run

Backend (port 4000):

    cd backend && npm install && npm run dev

Frontend (port 5174):

    cd frontend && npm install && npm run dev

Open http://localhost:5174

## Environment

`backend/.env` needs `MONGODB_URI`, `APOLLO_API_KEY`, `ANTHROPIC_API_KEY`
(same values as `The-Wolf/.env`). Data lives in the `PROSPECTOR` database on
the shared Atlas cluster — the `WOLF+` database is never touched.

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
- Progress is polled from the List document — no SSE.
- Restarting the backend mid-pull marks the running list `failed`; its
  already-saved leads remain reviewable.
