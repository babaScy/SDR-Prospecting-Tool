# Prospector

Standalone prospecting app (external to WOLF+). Pulls companies from Apollo by
count/region/ICP profile, AI-qualifies them against the Scytale ICP rubric
(Claude), and gives an SDR a per-list accept/reject review flow. Accepted leads
will later be pushed to Clay (not built yet).

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

- One pull runs at a time (409 otherwise); max 200 leads per pull.
- Progress is polled from the List document — no SSE.
- Restarting the backend mid-pull marks the running list `failed`; its
  already-saved leads remain reviewable.
