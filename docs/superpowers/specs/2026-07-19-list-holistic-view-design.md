# Holistic list view — design

## Problem

The only way to see a list's companies today is `ReviewScreen`: one company card
at a time, in a fixed bucket order (qualified → nei → disqualified), decide
accept/reject/undo, repeat. There's no way to see the whole list at once —
scan names, compare tiers, spot-check what the AI decided — without clicking
through every card. Separately, `ListsScreen` shows per-list counts but no
totals across lists.

## Goals

1. A table view of all companies in a single list, viewable/filterable/sortable
   at a glance, with the same accept/reject/undo actions available inline.
2. Keep the existing card-by-card review flow exactly as-is, reachable via a
   toggle — this is an additional way to work a list, not a replacement.
3. A small cross-list summary (totals + tier breakdown) on the Lists screen.

## Non-goals

- No bulk actions (e.g. "accept all qualified") — out of scope for this pass.
- No new columns/detail beyond what's specified below (no full firmographic
  dump, no expandable qualification reasoning in the table).
- No changes to the AI qualification pipeline, `List.status` transitions, or
  the `POST /api/leads/:id/decision` contract.

## Architecture

```
App.jsx
  view 'lists'  → ListsScreen        (existing table + new summary strip)
  view 'list'   → ListDetailScreen   (NEW — replaces direct ReviewScreen mount)
                    ├─ mode 'table'  → ListTable      (NEW)
                    └─ mode 'card'   → ReviewScreen    (existing, unchanged)
```

`ListDetailScreen` owns only the mode toggle and the list header (name, back
button); it renders `ListTable` or `ReviewScreen` depending on mode. Each of
those two components fetches its own data independently — no shared fetch
layer. This keeps `ReviewScreen` completely untouched and keeps `ListTable`
free to have its own fetch/filter/sort state without coordinating with the
card flow.

### Backend: `GET /api/lists/:id/leads` — `bucket` becomes optional

Currently `bucket` is required and validated against
`['qualified', 'nei', 'disqualified']`. Change: if `bucket` is provided, keep
today's exact behavior (validate + filter). If omitted, skip the status filter
entirely and return all companies in the list (any `status`, including
AI-`pending`), same `{ tier: 1, companyName: 1 }` sort. `ReviewScreen` keeps
passing `bucket` explicitly, so its behavior does not change.

`ListTable` calls this endpoint once, with no `bucket`, and does verdict/status
filtering client-side (see below) — one round trip instead of three.

### Backend: tier counts in `countsByList`

`countsByList` (`backend/src/routes/lists.js`) adds three grouped counts —
`tierA`, `tierB`, `tierC` — via the same `countIf('$tier', 'A')` pattern
already used for status counts. `EMPTY_COUNTS` gets matching zeroed fields.
This is additive: existing fields are untouched, so `ListsScreen`'s current
table needs no changes to keep working.

### Frontend: `ListTable.jsx` (new)

- On mount: `fetchLeads(listId)` (no bucket) → one array of companies.
- Local state: the fetched array (source of truth for SDR status), plus two
  filter selections (AI verdict: all/qualified/nei/disqualified; SDR status:
  all/pending/accepted/rejected) and a sort column + direction.
- Columns: Name, Tier, Employees, Country, AI Verdict (`status`), SDR Status
  (`sdrStatus`), Actions.
- Actions column: Accept/Reject buttons when `sdrStatus === 'pending'`, Undo
  button otherwise — same three-state semantics as `ReviewScreen`.
- Row action handler: call `sendDecision(id, decision)` (existing API
  function, unchanged); only update the row's local `sdrStatus` after the
  request resolves (optimistic-after-success, matching `ReviewScreen`'s
  pattern — a failed request leaves the row untouched and surfaces the error).
- Column headers are clickable to toggle sort (ascending/descending) on that
  field; default sort is the server order (tier, name).
- Error/empty/loading states reuse the existing `error`/`muted` CSS classes
  already used across the app.

### Frontend: `ListDetailScreen.jsx` (new)

- Props: `listId`, `onBack`.
- Local state: `mode` ('table' | 'card'), default `'table'`.
- Renders a header row: back button, list name (fetched via `fetchList(id)`),
  and a two-button toggle ("Table" / "Card review").
- Renders `<ListTable listId={listId} />` or `<ReviewScreen listId={listId}
  onBack={onBack} />` depending on `mode`. `ReviewScreen`'s own back button
  still works (goes to Lists); switching modes via the toggle does not
  navigate away from the list.

### Frontend: `App.jsx`

`view.name === 'review'` becomes `view.name === 'list'`, rendering
`ListDetailScreen` instead of `ReviewScreen` directly. `ListsScreen`'s
`onOpen` callback is unchanged (`onOpen={(listId) => setView({ name: 'list',
listId })}`).

### Frontend: `ListsScreen.jsx` — summary strip

Above the existing table, a strip summing the already-fetched `lists` array
client-side (no new request): total `pulledCount`, total `qualified`
(summed across lists' `counts.qualified`), total `accepted`, and
Tier A/B/C totals (from the new `counts.tierA/tierB/tierC` fields). Computed
with a plain `reduce` over `lists` on every render — cheap, no memoization
needed at this scale.

## Data flow (table mode, accept example)

1. `ListTable` mounts → `GET /api/lists/:id/leads` → renders all companies.
2. User clicks Accept on a row → `POST /api/leads/:id/decision
   {decision:'accepted'}` (existing endpoint, existing side effects: sets
   `sdrStatus`/`sdrReviewedAt`, flips `List.status` ready↔reviewed when the
   pending count hits zero).
3. On success, `ListTable` updates that row's `sdrStatus` locally and its
   Actions cell swaps to an Undo button. On failure, the row is untouched and
   an error banner shows (same UX as `ReviewScreen`).
4. Nothing else changes: if the user switches to Card mode afterward,
   `ReviewScreen` fetches fresh and reflects the same state from the server.

## Error handling

- `ListTable` fetch failure: show the existing `error` banner with a retry
  affordance (reload), matching `ListsScreen`'s pattern.
- Row-level decision failure: don't mutate local state; show the error banner
  above the table (single shared error slot, not per-row) — consistent with
  how `ReviewScreen` already surfaces `sendDecision` failures.
- Backend: omitted `bucket` is a valid, intentional input, not an error case —
  no new error paths introduced there. Invalid `bucket` values still 400 as
  today.

## Testing

- Backend (`backend/test/dashboardRoutes.test.js`): add cases —
  - `GET /api/lists/:id/leads` with no `bucket` returns all companies
    regardless of status (including AI-`pending`).
  - Invalid `bucket` still 400s (existing behavior, regression guard).
  - `countsByList` response includes correct `tierA`/`tierB`/`tierC` values
    for a seeded mix of tiers.
- Frontend: no test suite exists in this repo; verify manually in-browser
  (table renders, filters/sort work, accept/reject/undo update rows and
  persist across a reload, toggle preserves list context, summary strip
  totals match the sum of visible per-list rows).
