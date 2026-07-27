# SDR self-serve pulls, regions & daily quota — design

## Problem

Today only the **admin** can run a pull, and every pull is **globally
serialized** — one pull at a time across the whole system (`pull.js:15,45`).
That doesn't scale to a real team. We want each SDR to pull their *own* leads,
limited to a small daily quota, restricted to the regions they cover, without
waiting behind other SDRs.

Concretely:

- SDRs pull for themselves — no admin in the loop.
- Each SDR is capped at **5 AI-qualified leads per day** (resets daily). Once
  they have 5 qualified today, they can't pull again until the reset.
- SDRs can only pull from **their own assigned regions** (hard limit).
- The pull is **self-sizing**: the SDR picks region + ICP profile only (no
  count). The system pulls and qualifies in batches under the hood until the
  SDR reaches 5 qualified today.
- Multiple SDRs can pull **simultaneously, including from the same region**,
  without stepping on each other.

## Goals

1. Full SDR roster with per-SDR region assignments; admin can still pull
   anywhere.
2. An SDR pull path that takes only `{ region, profile }`, forces
   `assignedTo` = self, and rejects regions the SDR doesn't cover.
3. A daily 5-qualified quota per SDR, derived from data (no drift), gating the
   pull.
4. An under-the-hood batching loop that lands the SDR at ~5 qualified/day.
5. True per-SDR concurrency that is safe even when two SDRs pull the same
   region at once.
6. A qualifier that uses sync (Messages API) for tiny chunks and batch
   (Batches API) for larger ones.

## Non-goals

- HubSpot / downstream — unchanged, still out of scope.
- Real authentication — still the header + allowlist model from the roles
  project.
- Multi-process / horizontally-scaled backend — the in-process latch and
  enrich limiter assume the **single Express process** the app runs today (the
  existing code already relies on this; see `pull.js:11-14`). If we ever run
  multiple instances, the latch/limiter move to Mongo/Redis. Noted, deferred.
- Per-SDR configurable quota or batch sizes — 5/day, first batch 10, sync
  threshold 3 are constants for now.
- Reassigning existing lists or backfilling regions onto old data.

## Roster & regions

`backend/src/config/users.js` is replaced. Each SDR gains a `regions` array;
admin has no regions (can pull anywhere). **All emails lowercased**
(`currentUser` does an exact string compare). `danielp` is **dropped**.

```js
module.exports = [
  { email: 'yonia@scytale.ai',       role: 'admin', regions: [] },
  { email: 'simamkelen@scytale.ai',  role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'darrent@scytale.ai',     role: 'sdr',   regions: ['aus', 'nordics'] },
  { email: 'katiem@scytale.ai',      role: 'sdr',   regions: ['aus', 'benelux'] },
  { email: 'jamesb@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'chumam@scytale.ai',      role: 'sdr',   regions: ['benelux', 'dach'] },
  { email: 'tylorvw@scytale.ai',     role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'ryane@scytale.ai',       role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'khadym@scytale.ai',      role: 'sdr',   regions: ['benelux', 'uk'] },
  { email: 'jillianl@scytale.ai',    role: 'sdr',   regions: ['dach', 'nordics'] },
  { email: 'davidv@scytale.ai',      role: 'sdr',   regions: ['dach', 'uk'] },
  { email: 'darrenm@scytale.ai',     role: 'sdr',   regions: ['dach'] },
  { email: 'lusandam@scytale.ai',    role: 'sdr',   regions: ['uk'] },
  { email: 'kristophers@scytale.ai', role: 'sdr',   regions: ['uk'] },
];
```

13 SDRs. `us` has no SDR — admin-only. `darrent` (aus/nordics) and `darrenm`
(dach) are distinct people.

The existing `SDR_EMAILS` derivation in `pull.js` keeps working (it filters by
role). Anywhere that needs "regions for this SDR" reads `req.user.regions`.

## Constants

Defined once (in `pullService.js` or a small `config`):

```
DAILY_QUALIFIED_QUOTA = 5     // qualified leads per SDR per day
FIRST_BATCH_SIZE      = 10    // first Apollo batch of a session
SYNC_THRESHOLD        = 3     // < this many → sync Messages API, else Batches
SESSION_MAX_PULLED    = 60    // safety cap on companies pulled per session
ENRICH_CONCURRENCY    = 5     // global cap on simultaneous Apollo enrich calls
APOLLO_PER_PAGE       = 25    // fixed Apollo page size — used for index→page math
RESET_TZ              = 'Asia/Jerusalem'   // daily quota reset boundary
```

## SDR pull path — `POST /api/pull`

The route branches on role.

**Admin** (unchanged): body `{ profile, region, count, assignedTo }`, full
control, can target any region and any SDR.

**SDR** (new): body `{ region, profile }` only.

- `assignedTo` is **forced to `req.user.email`** (body value ignored).
- `region` must be in `req.user.regions` → else `403 { error: 'Not one of
  your regions' }`.
- `profile` validated as `icp1`/`icp2` (400 otherwise).
- No `count` — the batching loop self-sizes.
- **Quota gate** (see below): if the SDR already has ≥5 qualified today →
  `429 { error: 'Daily limit reached — resets at midnight' }`.
- **Per-SDR latch** (see concurrency): if this SDR already has a pull running
  → `409 { error: 'You already have a pull running' }`.

One `List` is created per pull session, `assignedTo` = the SDR, and it grows
across batches. `requestedCount` is no longer meaningful for SDR pulls; it's
set to the running target and updated by the loop (or left as the safety cap —
implementation detail, doesn't affect behavior).

## Daily quota (5 qualified / SDR / day)

**Derived from data — no stored counter.** "Qualified today" =

```js
const listIds = await List.find({ assignedTo: sdrEmail }).distinct('_id');
const qualifiedToday = await Company.countDocuments({
  listId: { $in: listIds },
  status: 'qualified',
  createdAt: { $gte: startOfTodayInTz(RESET_TZ) },
});
```

- `createdAt` on `Company` is set at pull-insert time; qualification follows
  immediately in the same session, so `createdAt` is a faithful proxy for "when
  it was produced." (If we ever need precision, add a `qualifiedAt` timestamp;
  not needed now.)
- `startOfTodayInTz` computes midnight in `Asia/Jerusalem`. Everyone resets at
  the same wall-clock moment regardless of where they are.
- The count spans **all** the SDR's lists (any that produced qualified leads
  today), not just the current session — so a second pull the same day sees
  the earlier session's qualified leads and gates correctly.

The gate is checked (a) up front in the route before starting, and (b) as the
loop's stop condition, so a running session halts the instant the running
total reaches 5.

## Batching loop (under the hood)

Runs inside `pullService.runPull` for SDR sessions:

1. **First batch always 10.** Reserve 10 items from the cursor (see
   "No skipping"), fetch + save them, qualify → recount `qualifiedToday`.
2. While `qualifiedToday < 5` **and** `pulledThisSession < SESSION_MAX_PULLED`
   **and** the region pool isn't exhausted:
   - `needed = 5 − qualifiedToday`
   - reserve exactly `needed` items, fetch + save them
   - qualify them (see sync/batch rule)
   - recount `qualifiedToday`
3. Stop when `qualifiedToday ≥ 5` (the first batch of 10 may overshoot — that's
   accepted, "lucky them"), or the safety cap hits, or the pool is exhausted
   (a full cursor wrap with no new companies).

Pulling exactly `needed` assumes 100% qualification, which won't happen — so a
top-up round that yields 0 qualified simply loops again until 5 or a cap. It
converges.

Each round reserves **exactly** `needed` items and consumes exactly those (no
mid-page break), so no company between rounds is ever skipped — see "No
skipping companies" below.

The list oscillates `pulling ↔ qualifying` across rounds before landing on
`ready`. Progress messages are worded per round ("Round 2: qualifying 2
companies…") so the UI doesn't look like it's bouncing backward. Startup
recovery (`markStaleListsFailed`, `pullService.js:111`) already covers both
`pulling` and `qualifying`, so a mid-loop restart is still caught.

## Qualifier: sync vs. batch — `qualifierService`

`qualifyCompaniesBatch` currently always uses the Message Batches API. Add a
branch:

- chunk size **≥ 3** → Batches API (current path; 50% cheaper per company, but
  async with real latency).
- chunk size **< 3** (1–2 companies, typical of the trailing top-up rounds) →
  regular **synchronous Messages API** — faster and the batch discount is
  negligible at that size.

Both paths share the same prompt (`config/prompt.md`) and the same
`persistResult` verdict-writing logic; only the transport differs.

## Concurrency — per-SDR, region-safe (Option B)

Different SDRs pull concurrently, including the same region. Four changes make
the shared state safe.

### 1. Per-SDR latch (replaces the global one)

`pull.js` swaps the module-level `pullStarting` boolean for a set of in-flight
SDR emails, and scopes the DB backstop to the SDR:

```js
const pullsInFlight = new Set();               // was: let pullStarting = false
// ...
if (pullsInFlight.has(req.user.email)) return res.status(409)...;
if (await List.exists({ assignedTo: req.user.email,
                        status: { $in: ['pulling', 'qualifying'] } }))
  return res.status(409)...;
pullsInFlight.add(req.user.email);
try { /* create list + fire runPull */ }
finally { pullsInFlight.delete(req.user.email); }
```

Rule becomes "one pull *per SDR*" instead of "one pull *total*." (Admin pulls
can keep a small guard too, but are infrequent.)

### 2. Atomic item reservation (the cursor fix — also prevents skips)

Paging changes from "read a page number, consume part of it, write it back"
(which skips the unconsumed remainder — see "No skipping companies") to an
atomic reservation of **exactly the N items** a round needs:

```js
async function reserveItems(key, k) {
  const { value } = await PipelineState.findOneAndUpdate(
    { key }, { $inc: { 'value.next': k } }, { upsert: true, new: true }
  );
  return { start: value.next - k, end: value.next };  // half-open [start, end)
}
```

`$inc` is atomic in Mongo, so two concurrent uk pulls get **disjoint,
contiguous** index ranges (davidv 100–109, khadym 110–119). Every index in the
region's result stream is handed out **exactly once, in order** — so
concurrency can neither skip a company nor pull one twice, and the cursor never
corrupts.

### 3. Duplicate-key guard (belt-and-suspenders)

`Company.create` becomes non-fatal on the unique-index error, closing the
pre-existing check-then-create TOCTOU (`pullService.js:45,57`) that today would
fail an entire list:

```js
try { await Company.create({ ...mapped, listId: list._id }); saved++; }
catch (err) { if (err.code === 11000) continue; throw err; }
```

### 4. Enrich concurrency cap (Apollo guardrail)

A small in-process counting semaphore (`util/limiter.js`, ~15 lines) caps
simultaneous Apollo enrich calls at `ENRICH_CONCURRENCY` across all running
pulls, so 13 concurrent sessions can't trip Apollo rate limits. Excess calls
queue for a slot.

### Worked example — two uk SDRs at once

davidv and khadym both click Pull · uk · icp1 simultaneously:

1. Both pass the per-SDR latch (different SDRs). Two lists created.
2. Each reserves a disjoint, contiguous item range — davidv items 100–109,
   khadym 110–119. No overlap, and no index between them is skipped.
3. Enrich calls from both funnel through the shared limiter (≤5).
4. Each saves into its own list; the global `apolloAccountId` unique index +
   dup-guard guarantee no company lands in both and no crash on a tie.
5. Each qualifies and tops up toward its own 5-qualified target independently,
   reserving only as many further items as it still needs.

Neither waits on the other. Same region, parallel, safe, no skips.

## No skipping companies

The current cursor tracks **pages** but the pull consumes **partial pages**: it
saves companies until `requestedCount`, breaks mid-page (`pullService.js:44`),
yet still advances the page cursor (`:66-67`). Every unsaved company on that
last page is **skipped until a full wrap** — a latent bug even for a single
puller, and one our small top-up rounds would make severe (fetch a 25-company
page, save 2, skip 23).

The item-reservation model removes this: the cursor is a **monotonic item
index**, and each round reserves and consumes **exactly** the indices it needs.
The cursor advances by exactly the count consumed — never by a whole page — so
the next reservation resumes at the very next item (often the next org on the
same page). No index is ever jumped. Because reservation is atomic, this holds
across concurrent same-region pulls too: the index stream is partitioned among
them with no gaps and no overlaps.

## PipelineState (cursor) — what's stored

One document per `profile+region`, shared by every SDR who pulls that
combination (this sharing is intentional — the team walks the region's pool
progressively without re-scanning). `value` grows from a bare integer (a page
number) to an item-index cursor:

```js
{ key: 'apolloPage_icp1_uk', value: { next: 1520, perPage: 25, totalItems: 2200 } }
```

- **`next`** — monotonic item counter (atomic `$inc` by the reserved count);
  only ever grows. A reservation of K returns the range `[next−K, next)`.
- **`perPage`** — the fixed Apollo page size (`APOLLO_PER_PAGE`), used to map an
  item index to a real page+offset: `page = floor(i / perPage) + 1`,
  `offset = i % perPage`. A round's K items usually land on one page (two if
  they straddle a boundary); fetch those page(s), take exactly those offsets.
- **`totalItems`** — cached (`$set`) after the first fetch reports pagination
  totals, used for wrap: real index = `i % totalItems`. A session stops when it
  has advanced a full `totalItems` past where it started (pool walked); wrapped
  indices map to already-pulled companies, which dedup + the dup-guard skip.

Durable across restarts (unlike list statuses) so pulls continue where the
team left off. The **daily quota is NOT stored here** — it's derived from
`Company` data. Nothing SDR-specific lives in the cursor.

**Migration:** existing cursor docs have `value` as a plain integer (a page
number). Reshape to `{ next, perPage, totalItems }` — best-effort seed
`next = (oldPage − 1) * APOLLO_PER_PAGE`, leaving `totalItems` null until the
next fetch learns it. Exact positioning isn't critical: dedup guarantees
correctness even if the seed is slightly off (already-pulled companies are just
skipped). Folded into the implementation plan.

## Frontend

- **SDRs now see a Pull screen** (roles project hid it from them; that nav rule
  is relaxed for SDRs).
- SDR `PullScreen`: a **region** `<select>` limited to `req.user.regions`, an
  **ICP profile** `<select>` (icp1/icp2), and one **Pull** button. No count
  field, no assign-to field. A **quota indicator** shows "N / 5 qualified
  today"; when N ≥ 5 the button is disabled with an explainer and the reset
  time.
- Admin `PullScreen` unchanged (count + assign-to-SDR).
- The frontend's local email→role copy (from the roles project) gains region
  info so the SDR region dropdown can be populated client-side; the backend
  remains the authority (re-validates region membership on every pull).
- Live progress via the existing polling on `GET /api/lists/:id`.
- `429` (quota) and `409` (already running) surface through the existing
  per-screen error banner pattern.

## Error handling

- `403` — SDR pulling a region they don't cover; surfaced in `PullScreen`.
- `429` — daily quota reached; disables the button + explainer.
- `409` — SDR already has a pull running.
- `500`/failed pull — list marked `failed` with the error message, as today.

## Testing

Backend (`backend/test/`):

- **Roster/region config**: every SDR has ≥1 valid region; admin has none;
  emails are lowercase.
- **SDR pull route** (`pullRoute.test.js`): SDR pulling their region → 201 with
  `assignedTo` forced to self; pulling a non-covered region → 403; `count`/
  `assignedTo` in the body are ignored; admin path unchanged.
- **Quota gate**: 0/under-5 qualified today → allowed; exactly 5/over → 429;
  count spans multiple lists; respects the `Asia/Jerusalem` day boundary
  (inject a clock).
- **Batching loop** (`pullService`): mock qualify rates → first batch is 10,
  top-ups are `5 − qualifiedToday`, stops at ≥5, respects `SESSION_MAX_PULLED`,
  and terminates on pool exhaustion.
- **Sync vs. batch**: chunk of 2 → Messages API path; chunk of ≥3 → Batches
  API path (assert which transport is called).
- **Concurrency**: two simultaneous same-region pulls reserve disjoint,
  contiguous item ranges (atomic `reserveItems`); a forced duplicate-key on
  create is skipped, not fatal; the enrich limiter caps in-flight calls.
- **No skipping**: after a round consumes K items, the cursor advanced by
  exactly K and the next reservation resumes at the next index — assert no gap
  across a first batch of 10 followed by a top-up of 2 (indices 0–9 then 10–11,
  nothing skipped). Assert item→page/offset mapping straddling a page boundary.
- **Cursor migration**: an integer (page-number) cursor doc is reshaped to and
  read correctly by the new `{ next, perPage, totalItems }` logic.

Frontend: manual browser verification (no test suite) — SDR sees Pull screen,
region dropdown limited to their regions, quota indicator + disabled state at
5, a 403/429 surfacing cleanly, admin screen unchanged.

## Doc updates (incidental)

`README.md` / `HANDOFF.md` describe pulls as admin-only and globally
serialized. Update both to reflect SDR self-serve pulls, per-SDR concurrency,
the daily quota, and region assignments once this ships.
