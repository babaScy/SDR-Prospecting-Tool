# Objection Handler: Per-SDR Stars + Team Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move objection-handler starring from `localStorage` (per-device, leaks across users sharing a machine) to real per-SDR server state, and add team-wide upvote/downvote per rebuttal response, reordering each objection's responses — your stars first, then everything else, each group ranked by net score.

**Architecture:** One new Mongo collection (`ObjectionInteraction`) holds each SDR's own star/vote per response, following the exact same session-derived-identity pattern as `ObjectionFeedback`. One new route computes a team-wide aggregate (`netScore`) alongside the caller's own `myVote`/`myStarred`. The frontend fetches this once per `ObjectionsScreen` mount, and `ObjectionModal` computes render order from it locally (no server-side sorting needed — the dataset is tiny).

**Tech Stack:** Express 5 + Mongoose (backend, CommonJS), React 18 + Vite (frontend, ESM), Node's built-in `node:test` + `supertest` + `mongodb-memory-server` (backend tests). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-objection-voting-and-stars-design.md`

## Global Constraints

- `userEmail` on every interaction always comes from `req.user.email` (the session) — never from a request body field.
- `boxTitle` alone (no array index) is the response identity within an objection — verified unique per objection.
- `netScore` is a team-wide aggregate visible to everyone; an individual SDR's own `vote`/`starred` is visible only to that SDR — `GET` must never expose one caller's row to another caller.
- Sending the vote value you already have clears it back to `0` (neutral), it does not error or no-op silently.
- The old `prospector-objection-stars` `localStorage` mechanism is removed entirely, not kept as a fallback.
- No Notion sync, no vote/star history, no role restriction beyond normal sign-in (same as the rest of the Objection Handler feature).

---

## Task 1: Backend — ObjectionInteraction model, route, and tests

**Files:**
- Create: `backend/src/models/ObjectionInteraction.js`
- Create: `backend/src/routes/objectionResponses.js`
- Modify: `backend/src/app.js`
- Test: `backend/test/objectionResponses.test.js`

**Interfaces:**
- Produces: `GET /api/objection-responses` → `[{ objection, boxTitle, netScore, myVote, myStarred }]`. `POST /api/objection-responses/star` body `{ objection, boxTitle }` → same row shape. `POST /api/objection-responses/vote` body `{ objection, boxTitle, value }` (`value` ∈ `{1, -1}`) → same row shape. All three sit behind the existing global `currentUser` auth middleware (401 if not signed in).
- Consumes: `req.user.email` (already used the same way in `backend/src/routes/objectionFeedback.js`).

- [ ] **Step 1: Write the failing tests**

Create `backend/test/objectionResponses.test.js`:

```js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => db.clear());

const asSdr = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));
const asOtherSdr = (req) => req.set('Cookie', sessionCookie('khadym@scytale.ai'));

test('POST /api/objection-responses/star toggles the caller\'s star on then off', async () => {
  const on = await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  assert.equal(on.status, 200);
  assert.equal(on.body.myStarred, true);
  assert.equal(on.body.netScore, 0);

  const off = await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  assert.equal(off.status, 200);
  assert.equal(off.body.myStarred, false);
});

test('POST /api/objection-responses/vote sets, clears on repeat, switches on opposite value', async () => {
  const up = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  assert.equal(up.status, 200);
  assert.equal(up.body.myVote, 1);
  assert.equal(up.body.netScore, 1);

  const upAgain = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  assert.equal(upAgain.body.myVote, 0);
  assert.equal(upAgain.body.netScore, 0);

  const down = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: -1 });
  assert.equal(down.body.myVote, -1);
  assert.equal(down.body.netScore, -1);
});

test('POST /api/objection-responses/vote 400s on missing fields or an invalid value', async () => {
  const noTitle = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', value: 1 });
  assert.equal(noTitle.status, 400);

  const badValue = await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 2 });
  assert.equal(badValue.status, 400);
});

test('netScore sums votes across multiple SDRs; GET never exposes another SDR\'s own vote/star', async () => {
  await asSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });
  await asSdr(request(app).post('/api/objection-responses/star'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1' });
  await asOtherSdr(request(app).post('/api/objection-responses/vote'))
    .send({ objection: 'Not Interested', boxTitle: 'Initial Response 1', value: 1 });

  const asDavid = await asSdr(request(app).get('/api/objection-responses'));
  assert.equal(asDavid.status, 200);
  const davidRow = asDavid.body.find((r) => r.boxTitle === 'Initial Response 1');
  assert.equal(davidRow.netScore, 2);
  assert.equal(davidRow.myVote, 1);
  assert.equal(davidRow.myStarred, true);

  const asKhady = await asOtherSdr(request(app).get('/api/objection-responses'));
  const khadyRow = asKhady.body.find((r) => r.boxTitle === 'Initial Response 1');
  assert.equal(khadyRow.netScore, 2);
  assert.equal(khadyRow.myVote, 1);
  assert.equal(khadyRow.myStarred, false);
});

test('objection-responses routes are 401 without a session', async () => {
  const res = await request(app).get('/api/objection-responses');
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test test/objectionResponses.test.js`
Expected: FAIL — `Cannot GET /api/objection-responses` / 404s (route doesn't exist yet).

- [ ] **Step 3: Create the model**

Create `backend/src/models/ObjectionInteraction.js`:

```js
const mongoose = require('mongoose');

// One SDR's relationship to one rebuttal response: whether they've starred
// it (personal, visible only to them) and how they voted (shared, summed
// into a team-wide net score). `objection`/`boxTitle` link by name/title
// strings, not ObjectId — same reasoning as ObjectionFeedback: the content
// lives in frontend/src/data/objections.js, not the database. `boxTitle`
// alone is a stable identity within an objection (verified: no objection
// has two boxes sharing a title). See
// docs/superpowers/specs/2026-08-18-objection-voting-and-stars-design.md.
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

- [ ] **Step 4: Create the route**

Create `backend/src/routes/objectionResponses.js`:

```js
const express = require('express');
const ObjectionInteraction = require('../models/ObjectionInteraction');

const router = express.Router();

async function netScoreFor(objection, boxTitle) {
  const [row] = await ObjectionInteraction.aggregate([
    { $match: { objection, boxTitle } },
    { $group: { _id: null, netScore: { $sum: '$vote' } } },
  ]);
  return row?.netScore ?? 0;
}

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
    const netScore = await netScoreFor(objection, boxTitle);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});

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
    const netScore = await netScoreFor(objection, boxTitle);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

- [ ] **Step 5: Mount the route**

In `backend/src/app.js`, add one line alongside the other `/api/*` mounts:

```js
app.use('/api/objection-feedback', require('./routes/objectionFeedback'));
app.use('/api/objection-responses', require('./routes/objectionResponses'));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && node --test test/objectionResponses.test.js`
Expected: 5 tests passing, 0 failing.

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npm test`
Expected: same pass count as before plus 5, with the same single pre-existing unrelated failure (`test/apolloService.test.js` — `buildSearchBody uses icp3 employee ranges`, a `taiwan`/region-roster mismatch that predates this work) and no other regressions.

- [ ] **Step 8: Commit**

```bash
cd /Users/yonia/Documents/Prospector
git add backend/src/models/ObjectionInteraction.js backend/src/routes/objectionResponses.js backend/src/app.js backend/test/objectionResponses.test.js
git commit -m "feat(prospector): add per-SDR objection stars + team voting backend"
```

---

## Task 2: Frontend API client for stars/votes

**Files:**
- Modify: `frontend/src/api.js`

**Interfaces:**
- Produces: `fetchObjectionResponses(): Promise<Array>`, `starObjectionResponse(objection: string, boxTitle: string): Promise<Object>`, `voteObjectionResponse(objection: string, boxTitle: string, value: number): Promise<Object>` — used by Task 3's `ObjectionModal` and Task 4's `ObjectionsScreen`.

No test file — this repo has no frontend test suite; verified by the build and by the components that call these helpers.

- [ ] **Step 1: Add the three helpers**

At the end of `frontend/src/api.js`, add:

```js
export const fetchObjectionResponses = () => request('/api/objection-responses');

export const starObjectionResponse = (objection, boxTitle) =>
  request('/api/objection-responses/star', { method: 'POST', body: JSON.stringify({ objection, boxTitle }) });

export const voteObjectionResponse = (objection, boxTitle, value) =>
  request('/api/objection-responses/vote', { method: 'POST', body: JSON.stringify({ objection, boxTitle, value }) });
```

- [ ] **Step 2: Verify the build is still clean**

Run: `cd frontend && npm run build`
Expected: clean build, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/yonia/Documents/Prospector
git add frontend/src/api.js
git commit -m "feat(prospector): add frontend API client for objection stars/votes"
```

---

## Task 3: ObjectionModal — per-SDR stars, voting, reordering

**Files:**
- Modify: `frontend/src/components/ObjectionModal.jsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `starObjectionResponse`/`voteObjectionResponse`/`fetchObjectionResponses` (Task 2), `IconChevronUp`/`IconChevronDown` (already exported from `frontend/src/icons.jsx` — used elsewhere for sort arrows in `ListTable.jsx`).
- Produces: `ObjectionModal` gains two new props: `responses` (the full array from `fetchObjectionResponses()`, filtered here by `objection.name` the same way `feedback` already is) and `onResponseChanged(updatedRow)` (called after a successful star/vote POST, for the parent to merge into its own state). Used by Task 4's `ObjectionsScreen`.

This is presentational/interactive UI with no dedicated test file (matches this repo's existing frontend precedent for the Objection Handler feature) — verified by a clean build plus a manual read-through against the steps below.

- [ ] **Step 1: Update the CSS**

In `frontend/src/styles.css`, replace:

```css
.reb-head { display: flex; align-items: flex-start; gap: 8px; }
.reb-head .opt-toggle { flex: 1; }
.reb-head .rebuttal-num + .star-btn { margin-left: auto; }
```

with:

```css
.reb-head { display: flex; align-items: flex-start; gap: 8px; }
.reb-head .opt-toggle { flex: 1; }
.reb-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
```

(The old adjacent-sibling selector targeted `.star-btn` directly following `.rebuttal-num` — inserting vote controls between them would break that selector, so the margin now lives on a shared wrapper around both instead.)

Then, in the same file, replace:

```css
.star-btn { background: transparent; border: none; cursor: pointer; color: var(--muted); padding: 4px; flex-shrink: 0; transition: transform var(--dur-fast); }
.star-btn:hover { color: var(--amber); transform: scale(1.15); }
.star-btn.starred { color: var(--amber); }
```

with:

```css
.star-btn { background: transparent; border: none; cursor: pointer; color: var(--muted); padding: 4px; flex-shrink: 0; transition: transform var(--dur-fast); }
.star-btn:hover { color: var(--amber); transform: scale(1.15); }
.star-btn.starred { color: var(--amber); }
.star-btn:disabled, .vote-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

.vote-controls { display: flex; align-items: center; gap: 4px; }
.vote-btn {
  background: transparent; border: none; cursor: pointer; color: var(--muted);
  padding: 4px; display: flex; align-items: center; justify-content: center;
  transition: color var(--dur-fast), transform var(--dur-fast);
}
.vote-btn:hover:not(:disabled) { color: var(--scy-indigo-200); transform: scale(1.15); }
.vote-btn.active.up { color: var(--green); }
.vote-btn.active.down { color: var(--red); }
.vote-score { font-size: 12px; font-weight: 700; color: var(--text-2); min-width: 16px; text-align: center; }

.starred-section-label {
  display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700;
  color: var(--amber); text-transform: uppercase; letter-spacing: 0.08em;
  margin: 4px 0 10px;
}
```

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `frontend/src/components/ObjectionModal.jsx` with:

```jsx
import { useMemo, useState } from 'react';
import { IconStar, IconChevronUp, IconChevronDown } from '../icons';
import { postObjectionFeedback, starObjectionResponse, voteObjectionResponse } from '../api';

export default function ObjectionModal({ objection, feedback, responses, onClose, onFeedbackPosted, onResponseChanged }) {
  const [openBoxes, setOpenBoxes] = useState(() => new Set());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [busyTitle, setBusyTitle] = useState(null);
  const [actionError, setActionError] = useState('');

  const toggleBox = (i) => {
    setOpenBoxes((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  // .branch-toggle sits inside box.html's raw markup (dangerouslySetInnerHTML),
  // so it has no React handler attached — toggle it imperatively via classList,
  // same technique the source tool used. .opt-toggle is React-owned (state above).
  // Star/vote buttons are also React-owned but wired with direct onClick handlers
  // (see renderBox below) rather than delegation, since each now triggers an
  // async network call.
  const handleBodyClick = (e) => {
    const branchToggle = e.target.closest('.branch-toggle');
    if (branchToggle) {
      branchToggle.closest('.branch')?.classList.toggle('open');
      return;
    }
    const optToggle = e.target.closest('.opt-toggle');
    if (optToggle) {
      const wrapper = optToggle.closest('[data-box-index]');
      if (wrapper) toggleBox(Number(wrapper.dataset.boxIndex));
    }
  };

  const responseFor = (title) =>
    responses.find((r) => r.objection === objection.name && r.boxTitle === title) || { netScore: 0, myVote: 0, myStarred: false };

  const runAction = async (title, action) => {
    setBusyTitle(title);
    setActionError('');
    try {
      onResponseChanged(await action());
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyTitle(null);
    }
  };

  const toggleStar = (title) => runAction(title, () => starObjectionResponse(objection.name, title));
  const castVote = (title, value) => runAction(title, () => voteObjectionResponse(objection.name, title, value));

  const ordered = useMemo(() => {
    const withMeta = objection.boxes.map((box, i) => ({ box, i, ...responseFor(box.title) }));
    const byScoreThenOrder = (a, b) => b.netScore - a.netScore || a.i - b.i;
    return {
      starred: withMeta.filter((m) => m.myStarred).sort(byScoreThenOrder),
      rest: withMeta.filter((m) => !m.myStarred).sort(byScoreThenOrder),
    };
  }, [objection, responses]);

  const renderBox = ({ box, i, netScore, myVote, myStarred }) => {
    const busy = busyTitle === box.title;
    const voteControls = (
      <div className="vote-controls">
        <button
          className={`vote-btn up${myVote === 1 ? ' active' : ''}`}
          onClick={() => castVote(box.title, 1)}
          disabled={busy}
          type="button"
          title="Upvote this response"
        >
          <IconChevronUp width={14} height={14} />
        </button>
        <span className="vote-score">{netScore}</span>
        <button
          className={`vote-btn down${myVote === -1 ? ' active' : ''}`}
          onClick={() => castVote(box.title, -1)}
          disabled={busy}
          type="button"
          title="Downvote this response"
        >
          <IconChevronDown width={14} height={14} />
        </button>
      </div>
    );
    const starBtn = (
      <button
        className={`star-btn${myStarred ? ' starred' : ''}`}
        onClick={() => toggleStar(box.title)}
        disabled={busy}
        type="button"
        title="Star this option"
      >
        <IconStar width={16} height={16} fill={myStarred ? 'currentColor' : 'none'} />
      </button>
    );

    if (box.collapsed) {
      const open = openBoxes.has(i);
      return (
        <div className={`rebuttal${open ? ' open' : ''}`} key={i} data-box-index={i}>
          <div className="reb-head">
            <button className="opt-toggle" type="button">
              <span className="chev">▶</span><span>{box.title}</span>
            </button>
            <div className="reb-actions">{voteControls}{starBtn}</div>
          </div>
          <div className="opt-body" dangerouslySetInnerHTML={{ __html: box.html }} />
        </div>
      );
    }
    return (
      <div className="rebuttal" key={i}>
        <div className="reb-head">
          <div className="rebuttal-num">{box.title}</div>
          <div className="reb-actions">{voteControls}{starBtn}</div>
        </div>
        <div dangerouslySetInnerHTML={{ __html: box.html }} />
      </div>
    );
  };

  const entries = feedback.filter((f) => f.objection === objection.name);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    setPostError('');
    try {
      const created = await postObjectionFeedback(objection.name, trimmed);
      onFeedbackPosted(created);
      setText('');
    } catch (err) {
      setPostError(err.message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>{objection.name}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">×</button>
        </div>
        <div className="dialog-body" onClick={handleBodyClick}>
          {actionError && <p className="error">{actionError}</p>}

          {ordered.starred.length > 0 && (
            <>
              <div className="starred-section-label">⭐ Your starred picks</div>
              {ordered.starred.map(renderBox)}
            </>
          )}
          {ordered.rest.map(renderBox)}

          <div className="fb-wrap">
            <button className={`fb-toggle${feedbackOpen ? ' open' : ''}`} onClick={() => setFeedbackOpen((o) => !o)} type="button">
              <span className="chev">▶</span> Team feedback
              <span className="fb-count-badge">{entries.length}</span>
            </button>
            {feedbackOpen && (
              <div className="fb-panel">
                {entries.length
                  ? entries.map((e) => (
                      <div className="fb-entry" key={e._id}>
                        <div className="fb-entry-meta">
                          <span className="who">{e.authorEmail}</span>
                          <span>{new Date(e.createdAt).toLocaleDateString()}</span>
                        </div>
                        <div className="fb-entry-text">{e.text}</div>
                      </div>
                    ))
                  : <div className="fb-empty">No feedback yet — be the first to leave a note for the team.</div>}
                <div className="fb-form">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Feedback on this objection's responses… (e.g. 'Response 2 lands better if you pause after the question')"
                  />
                  <div className="fb-actions">
                    <div className="fb-note">Shared with the whole Prospector team — everyone signed in sees it immediately.</div>
                    <button className="btn small" onClick={submit} disabled={posting || !text.trim()} type="button">
                      {posting ? 'Posting…' : 'Post feedback'}
                    </button>
                  </div>
                  {postError && <p className="error">{postError}</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

Note what was removed from the previous version: `starsKey`, `loadStars`, `saveStars`, the `stars` state, and the `useEffect` that persisted it to `localStorage` — starring is now server state, passed in via `responses` like everything else.

- [ ] **Step 3: Verify the build is clean**

Run: `cd frontend && npm run build`
Expected: clean build. (`ObjectionModal` now requires a `responses` prop — `ObjectionsScreen` doesn't supply one yet until Task 4, but a missing prop just makes `responses` `undefined` at runtime, not a build error; the real integration check is Task 4's build plus a manual click-through.)

- [ ] **Step 4: Commit**

```bash
cd /Users/yonia/Documents/Prospector
git add frontend/src/components/ObjectionModal.jsx frontend/src/styles.css
git commit -m "feat(prospector): move objection stars to per-SDR server state, add voting + reordering"
```

---

## Task 4: ObjectionsScreen — wire up responses fetch and merge

**Files:**
- Modify: `frontend/src/components/ObjectionsScreen.jsx`

**Interfaces:**
- Consumes: `fetchObjectionResponses` (Task 2), `ObjectionModal`'s new `responses`/`onResponseChanged` props (Task 3).

- [ ] **Step 1: Update the component**

In `frontend/src/components/ObjectionsScreen.jsx`, replace:

```jsx
import { useEffect, useState } from 'react';
import { OBJECTIONS } from '../data/objections';
import { fetchObjectionFeedback } from '../api';
import ObjectionModal from './ObjectionModal';

export default function ObjectionsScreen() {
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // one OBJECTIONS entry, or null

  useEffect(() => {
    fetchObjectionFeedback().then(setFeedback).catch((e) => setError(e.message));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? OBJECTIONS.filter((o) => o.name.toLowerCase().includes(q) || o.search.toLowerCase().includes(q))
    : OBJECTIONS;

  const countFor = (name) => feedback.filter((f) => f.objection === name).length;
  const onFeedbackPosted = (entry) => setFeedback((prev) => [entry, ...prev]);
```

with:

```jsx
import { useEffect, useState } from 'react';
import { OBJECTIONS } from '../data/objections';
import { fetchObjectionFeedback, fetchObjectionResponses } from '../api';
import ObjectionModal from './ObjectionModal';

export default function ObjectionsScreen() {
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState([]);
  const [responses, setResponses] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // one OBJECTIONS entry, or null

  useEffect(() => {
    fetchObjectionFeedback().then(setFeedback).catch((e) => setError(e.message));
    fetchObjectionResponses().then(setResponses).catch((e) => setError(e.message));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? OBJECTIONS.filter((o) => o.name.toLowerCase().includes(q) || o.search.toLowerCase().includes(q))
    : OBJECTIONS;

  const countFor = (name) => feedback.filter((f) => f.objection === name).length;
  const onFeedbackPosted = (entry) => setFeedback((prev) => [entry, ...prev]);
  const onResponseChanged = (updated) => setResponses((prev) => {
    const idx = prev.findIndex((r) => r.objection === updated.objection && r.boxTitle === updated.boxTitle);
    if (idx === -1) return [...prev, updated];
    const next = [...prev];
    next[idx] = updated;
    return next;
  });
```

Then replace:

```jsx
      {selected && (
        <ObjectionModal
          objection={selected}
          feedback={feedback}
          onClose={() => setSelected(null)}
          onFeedbackPosted={onFeedbackPosted}
        />
      )}
```

with:

```jsx
      {selected && (
        <ObjectionModal
          objection={selected}
          feedback={feedback}
          responses={responses}
          onClose={() => setSelected(null)}
          onFeedbackPosted={onFeedbackPosted}
          onResponseChanged={onResponseChanged}
        />
      )}
```

- [ ] **Step 2: Verify the build is clean**

Run: `cd frontend && npm run build`
Expected: clean build.

- [ ] **Step 3: Manual smoke test**

Run both dev servers and click through it once, since this repo has no frontend test suite and this task is what actually wires everything together end to end:

```bash
cd backend && npm run dev   # port 4000, separate terminal
cd frontend && npm run dev  # port 5174
```

Open `http://localhost:5174`, sign in, go to Objection Handler → open "Not Interested". Star "Initial Response 1" — confirm it moves to a "⭐ Your starred picks" section at the top. Upvote a different response a couple of times to give it a positive score, then downvote another — confirm the unstarred list reorders by score. Click your active vote arrow again — confirm it clears back to neutral and the score updates. Sign in as a second SDR (or open an incognito window) and confirm they see the shared net scores but none of the first SDR's own stars/votes.

- [ ] **Step 4: Commit**

```bash
cd /Users/yonia/Documents/Prospector
git add frontend/src/components/ObjectionsScreen.jsx
git commit -m "feat(prospector): wire objection response stars/votes into ObjectionsScreen"
```
