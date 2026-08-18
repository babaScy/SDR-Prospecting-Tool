# Objection Handler: per-SDR stars + team voting (design)

## Background

The Objection Handler (shipped earlier today) has a "star a rebuttal" feature
that's currently `localStorage`-only — a personal favorite that lives on one
device. Two problems: it leaks across users who share a machine (there's no
real per-SDR boundary), and it doesn't do anything with the star besides
remembering it — starred responses render in the same place as everything
else.

This adds two things: starring becomes real per-SDR server state (so it
follows the signed-in user, not the device, and one SDR never sees another's
stars), and a new team-wide upvote/downvote on each response, with responses
within an objection reordered by net score — starred-for-you first, then the
rest, each group ranked by the team's votes.

## Scope

- Move starring from `localStorage` to the backend, tied to `req.user.email`
  (same pattern as `ObjectionFeedback.authorEmail` — never client-supplied).
- Add upvote/downvote per rebuttal response, one vote per user per response,
  changeable, clearable (clicking your current vote again clears it back to
  neutral).
- Reorder each objection's rebuttal boxes: your starred responses first
  (ranked by net score among themselves), then the rest (ranked by net
  score), ties broken by original order.
- Remove the old `prospector-objection-stars` `localStorage` mechanism
  entirely — nobody has used the shipped feature yet, so there's no data to
  migrate.

**Out of scope:** vote/star history or audit trail, undoing another SDR's
vote (there isn't one — each SDR only ever affects their own row), any
change to the feedback feature, any content/data changes to
`frontend/src/data/objections.js`.

## Data model

One collection covers both stars and votes, since both are "this one SDR's
relationship to this one response":

`backend/src/models/ObjectionInteraction.js`:
```js
const mongoose = require('mongoose');

// One SDR's relationship to one rebuttal response: whether they've starred
// it (personal, visible only to them) and how they voted (shared, summed
// into a team-wide net score). `objection`/`boxTitle` link by name/title
// strings, not ObjectId — same reasoning as ObjectionFeedback: the content
// lives in frontend/src/data/objections.js, not the database. `boxTitle`
// alone is a stable identity within an objection (verified: no objection
// has two boxes sharing a title).
const objectionInteractionSchema = new mongoose.Schema(
  {
    objection: { type: String, required: true },
    boxTitle: { type: String, required: true },
    userEmail: { type: String, required: true }, // always req.user.email, never client-supplied
    starred: { type: Boolean, default: false },
    vote: { type: Number, enum: [-1, 0, 1], default: 0 },
  },
  { timestamps: true }
);

objectionInteractionSchema.index({ objection: 1, boxTitle: 1, userEmail: 1 }, { unique: true });

module.exports = mongoose.model('ObjectionInteraction', objectionInteractionSchema);
```

A doc only exists once an SDR has starred and/or voted on that response —
most (objection, boxTitle) pairs will have zero docs. `vote: 0` (the default)
means "no vote," not "downvote" — it's what a star-only doc has, and it's
what a cleared vote reverts to.

## Backend endpoints

New route file, `backend/src/routes/objectionResponses.js`, mounted in
`app.js` as `app.use('/api/objection-responses', require('./routes/objectionResponses'))`
(after `currentUser`, same as every other route — no extra auth code).

**`GET /api/objection-responses`** → one row per response that has *any*
interaction from *anyone*, sourced from two queries merged in memory (the
collection is tiny — at most 72 responses × however many SDRs ever star or
vote — so this is simpler and just as fast as a single fancier aggregation):

```js
router.get('/', async (req, res, next) => {
  try {
    const scores = await ObjectionInteraction.aggregate([
      { $group: { _id: { objection: '$objection', boxTitle: '$boxTitle' }, netScore: { $sum: '$vote' } } },
    ]);
    const mine = await ObjectionInteraction.find({ userEmail: req.user.email });
    const mineByKey = new Map(mine.map((m) => [`${m.objection}||${m.boxTitle}`, m]));

    const rows = scores.map(({ _id, netScore }) => {
      const mineRow = mineByKey.get(`${_id.objection}||${_id.boxTitle}`);
      return {
        objection: _id.objection,
        boxTitle: _id.boxTitle,
        netScore,
        myVote: mineRow?.vote ?? 0,
        myStarred: mineRow?.starred ?? false,
      };
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
```

Note: `netScore` here is the *sum of every SDR's vote*, but a response an SDR
only starred (never voted on) still appears — its doc's `vote: 0` still
produces a group via `$group`, it just contributes 0 to the sum. No response
with a real interaction is silently dropped.

**`POST /api/objection-responses/star`** `{ objection, boxTitle }` — toggles
the caller's own star, upserting their row:

```js
router.post('/star', async (req, res, next) => {
  try {
    const { objection, boxTitle } = req.body || {};
    if (!objection || !boxTitle) return res.status(400).json({ error: 'objection and boxTitle are required' });

    const existing = await ObjectionInteraction.findOne({ objection, boxTitle, userEmail: req.user.email });
    const doc = await ObjectionInteraction.findOneAndUpdate(
      { objection, boxTitle, userEmail: req.user.email },
      { $set: { starred: !existing?.starred } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const [{ netScore } = { netScore: 0 }] = await ObjectionInteraction.aggregate([
      { $match: { objection, boxTitle } },
      { $group: { _id: null, netScore: { $sum: '$vote' } } },
    ]);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});
```

**`POST /api/objection-responses/vote`** `{ objection, boxTitle, value }`
(`value` must be `1` or `-1`) — sets the caller's vote; sending the value
they already have clears it back to `0`:

```js
router.post('/vote', async (req, res, next) => {
  try {
    const { objection, boxTitle, value } = req.body || {};
    if (!objection || !boxTitle) return res.status(400).json({ error: 'objection and boxTitle are required' });
    if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });

    const existing = await ObjectionInteraction.findOne({ objection, boxTitle, userEmail: req.user.email });
    const newVote = existing?.vote === value ? 0 : value;
    const doc = await ObjectionInteraction.findOneAndUpdate(
      { objection, boxTitle, userEmail: req.user.email },
      { $set: { vote: newVote } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const [{ netScore } = { netScore: 0 }] = await ObjectionInteraction.aggregate([
      { $match: { objection, boxTitle } },
      { $group: { _id: null, netScore: { $sum: '$vote' } } },
    ]);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});
```

Both POSTs return the same `{ objection, boxTitle, netScore, myVote,
myStarred }` shape as a GET row, so the frontend has one merge function for
all three response shapes.

## Frontend

`frontend/src/api.js` — three new helpers, same pattern as the feedback ones:
```js
export const fetchObjectionResponses = () => request('/api/objection-responses');
export const starObjectionResponse = (objection, boxTitle) =>
  request('/api/objection-responses/star', { method: 'POST', body: JSON.stringify({ objection, boxTitle }) });
export const voteObjectionResponse = (objection, boxTitle, value) =>
  request('/api/objection-responses/vote', { method: 'POST', body: JSON.stringify({ objection, boxTitle, value }) });
```

`ObjectionsScreen.jsx` — fetches `fetchObjectionResponses()` once on mount
alongside the existing feedback fetch, holds it in state, and passes
`responses` + an `onResponseChanged(updated)` merge callback down to
`ObjectionModal` (mirrors the existing `feedback`/`onFeedbackPosted` pair
exactly). `onResponseChanged` replaces the matching `(objection, boxTitle)`
row in state, or appends it if this is the first interaction anyone's had
with that response.

`ObjectionModal.jsx`:
- **Remove entirely:** `starsKey`, `loadStars`, `saveStars`, the `stars`
  state, and the `useEffect` that persisted it to `localStorage`.
- **New props:** `responses` (the full array, filtered here by
  `objection.name` the same way `feedback` already is) and
  `onResponseChanged`.
- A lookup per box: `responseFor(title)` returns the matching row or
  `{ netScore: 0, myVote: 0, myStarred: false }` if this response has no
  interactions yet.
- New handlers, both `async`, both calling their API helper then
  `onResponseChanged(result)`:
  - `toggleStar(boxTitle)` → `starObjectionResponse(objection.name, boxTitle)`
  - `castVote(boxTitle, value)` → `voteObjectionResponse(objection.name, boxTitle, value)`
- A single `busyTitle` state (string title or `null`) disables that one
  response's star/up/down buttons while its own request is in flight —
  simpler than tracking busy state per button, and sufficient since these
  are quick, infrequent clicks, not a bulk-action UI.
- **Star and vote buttons switch from the delegated-click pattern to direct
  `onClick` handlers.** They're React-rendered elements (not inside
  `box.html`'s raw markup), and now that they trigger an async network call
  each, wiring them directly is simpler than routing through the shared
  synchronous delegated handler. The delegated handler stays exactly as-is
  for `.branch-toggle` (still inside raw HTML, still needs the imperative
  `classList` approach) and `.opt-toggle` (unchanged, still React state) —
  only the star button's `data-key`/delegation wiring is replaced.
- **Ordering**, computed with `useMemo` off `objection` + `responses`:
  ```js
  const ordered = useMemo(() => {
    const withMeta = objection.boxes.map((box, i) => ({ box, i, ...responseFor(box.title) }));
    const byScoreThenOrder = (a, b) => b.netScore - a.netScore || a.i - b.i;
    return {
      starred: withMeta.filter((m) => m.myStarred).sort(byScoreThenOrder),
      rest: withMeta.filter((m) => !m.myStarred).sort(byScoreThenOrder),
    };
  }, [objection, responses]);
  ```
  The existing per-box render logic (collapsed/branch/star markup) becomes a
  shared `renderBox({ box, i, netScore, myVote, myStarred })` function so it
  isn't duplicated between the two groups. `data-box-index={i}` keeps using
  the *original* index (unaffected by display order), so the existing
  `openBoxes` collapse-state tracking needs no changes.
  When `ordered.starred.length > 0`, render a small "⭐ Your starred picks"
  label above that group; the `rest` group gets no header, matching how a
  "pinned" section usually reads. A response never renders twice — it's in
  exactly one of the two groups.
- Vote UI sits next to the existing star button: a down arrow, the net
  score number, an up arrow — `myVote` drives which arrow (if either) shows
  as active/highlighted.

New CSS (`frontend/src/styles.css`): `.vote-controls`/`.vote-btn`/`.vote-score`
for the up/down/score cluster, and `.starred-section-label` for the "⭐ Your
starred picks" heading — styled with the same tokens already established for
this feature (`--scy-indigo-200`, `--amber` for the active/starred states,
`--muted` for the label).

## Testing

Backend: `test/objectionResponses.test.js`, same session/auth-helper
conventions as `test/objectionFeedback.test.js`. Covers: starring toggles on
then off; voting up, voting the same value again clears it, voting the
opposite value switches it; `netScore` sums correctly across *multiple*
different users' votes on the same response; one SDR's `GET` never exposes
another SDR's individual `myVote`/`myStarred` (only the aggregate
`netScore`) — seed two users' interactions, assert the response for each
caller only reflects their own row; 400 on missing `objection`/`boxTitle`
and on a `value` outside `{1, -1}`; 401 without a session.

Frontend stays build-verified only, matching this repo's existing precedent
(no frontend test suite anywhere else either).
