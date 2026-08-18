# Objection handler (design)

## Background

A standalone static file (`objection_handler_6.html`) was built as a sales-enablement
cheatsheet: 17 common objections, each with a few numbered rebuttal scripts
(some with collapsible "if they say X" follow-up branches), searchable in a
card grid, with a modal per objection. Its content (`OBJECTIONS` JSON) is
baked in from a Notion database, refreshed by manually re-running the export
process — the file literally says "Updated Notion or new team feedback? Ask
Claude" as its refresh instruction. It also has two personal-device features:
starring a favorite rebuttal, and leaving "team feedback" on an objection —
but feedback is **not actually shared**: it's saved to `localStorage` and,
best case, copied to the clipboard with a prompt to paste it into a Notion
board by hand. There is no real submit-to-anywhere behavior.

This brings that tool into Prospector as a second top-level section, styled
to match, with feedback that's genuinely shared (stored server-side, tied to
the real signed-in user) instead of the clipboard/Notion workaround.

## Scope

- New "Objection Handler" section, reachable by making the "Prospector"
  wordmark a clickable app-switcher.
- Port the existing 17 objections / 72 rebuttal boxes verbatim.
- Real, shared feedback storage (new backend model + route), replacing the
  localStorage/clipboard mechanism entirely.
- Keep the star/favorite feature exactly as today: personal, per-device,
  `localStorage`, no backend.

**Out of scope:** Notion sync in either direction, in-app editing of
objection content, feedback edit/delete, any role restriction beyond normal
sign-in (any SDR or admin can read/post feedback).

## Navigation

`App.jsx`'s wordmark (currently a static `<span>`) becomes a button. Clicking
it opens a small new component, `AppSwitcher.jsx` — a dropdown with two
entries, **Prospector** and **Objection Handler** (click-outside/Escape to
close). Picking one sets `view.name` (`'objections'` is a new value alongside
the existing `'pull'`/`'lists'`/`'list'`). The wordmark text mirrors whichever
section is active, and the Pull/Lists nav buttons only render when `view.name`
is one of the Prospector-side values — they're irrelevant inside Objection
Handler, so they disappear rather than sitting there unusable.

## Content

`frontend/src/data/objections.js` exports the `OBJECTIONS` array ported
directly from the static file: `[{ name, boxes: [{ title, html, collapsed }] }]`.

Each box's `html` stays a raw HTML string carrying the same sub-structure the
original used (`.text`, `.branch` / `.branch-toggle` for collapsible "if they
say X" follow-ups, `.label`, etc.) rather than being modeled as nested data.
That's a deliberate call: this content is static and developer-authored (not
user input), refreshed the same manual way it already is today — re-run the
Notion export, replace this file — so porting it as literal markup is a
straight copy instead of a data-model rewrite. It renders via
`dangerouslySetInnerHTML`, with the class names re-themed in CSS to
Prospector's actual tokens (indigo/pink, Montserrat/Space Grotesk) instead of
the demo's own purple palette.

**Known fragility, accepted:** feedback links to an objection by its `name`
string (see below), since content isn't database-backed — there's no stable
id to reference instead. If an objection is ever renamed on a future refresh,
its prior feedback stops matching under the old name rather than erroring.
Objection categories don't change often, so this is an acceptable risk rather
than something to build machinery around.

Interactivity (branch toggles, star buttons) is one delegated `onClick` on
the modal body, keyed off `data-` attributes on the injected markup — the same
technique the original vanilla-JS version used (`e.target.closest(...)`),
which works the same whether the DOM came from React or raw HTML.

## Backend — feedback

New model, `backend/src/models/ObjectionFeedback.js`:

```js
{
  objection: { type: String, required: true }, // objection's `name`, see fragility note above
  text: { type: String, required: true },
  authorEmail: { type: String, required: true }, // req.user.email — never a free-text name field
}
```
(`{ timestamps: true }`)

New route file, `backend/src/routes/objectionFeedback.js`, mounted in
`app.js` as `app.use('/api/objection-feedback', require('./routes/objectionFeedback'))`
— after the existing `currentUser` middleware, so it's authenticated like
every other route in the app (401 if not signed in, no extra role check).

- `GET /api/objection-feedback` → all entries, newest first. The dataset is
  small (dozens of rows, growing slowly) so this fetches everything once;
  the frontend filters by `objection` client-side rather than adding a
  query-param endpoint for it.
- `POST /api/objection-feedback` body `{ objection, text }` → 400 if
  `objection` is missing or `text` is empty/whitespace-only; otherwise
  creates `{ objection, text: text.trim(), authorEmail: req.user.email }`
  and returns it (201).

## Frontend — screen

`ObjectionsScreen.jsx`:
- Fetches all feedback once on mount (`GET /api/objection-feedback`).
- Search input filters the objection list by name (client-side, same as the
  original).
- Card grid, one card per objection, reusing the existing `.contact-card`
  surface/grid pattern from `ContactsScreen` rather than inventing new card
  CSS — shows the objection name and a feedback-count pill.
- Clicking a card opens a modal (reusing the `.overlay`/`.dialog` pattern
  from the recent SDR-override work) containing:
  - the numbered rebuttal boxes for that objection, collapsible branches,
    star toggle per box (persisted to `localStorage`, unchanged behavior —
    key renamed to fit Prospector's own naming, e.g. `prospector-objection-stars`)
  - a feedback section: existing entries for this objection (author email +
    relative timestamp + text, newest first), a textarea, and a submit
    button that `POST`s and appends the new entry to local state on success

New `frontend/src/api.js` helpers: `fetchObjectionFeedback()` and
`postObjectionFeedback(objection, text)`.

## Testing

Backend: `test/objectionFeedback.test.js`, following the existing
session/auth-helper conventions (`test/helpers/auth.js`, `test/helpers/db.js`)
used by `dashboardRoutes.test.js` / `contactRoutes.test.js`. Covers: POST
creates an entry with `authorEmail` taken from the session (not from the
request body, even if one is passed); 400 on missing `objection` or
empty/whitespace `text`; GET returns entries newest-first; unauthenticated
requests to either route get 401 via the existing global `currentUser`
middleware (no route-specific auth code to write or test).

Frontend stays build-verified only — no frontend test suite exists anywhere
else in this repo, so this doesn't introduce a new gap, it matches the
existing one.
