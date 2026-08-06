# Compliance badge on company visuals

## Problem

The AI qualifier already records `qualification.isCompliant` ('Yes' |
'Not confirmed') and `qualification.frameworks` (free text, e.g. "ISO 27001,
SOC 2") on every `Company`. Today this is invisible on the card view (buried
as one signal tile among a dozen others, and `isCompliant` itself is never
shown at all) and entirely absent from the table view. SDRs have no quick way
to see whether a company is compliant, or with what, without reading through
the AI reasoning.

## Goal

Surface compliance status + frameworks prominently on both company visuals:

- **LeadCard** (`ReviewScreen`'s one-at-a-time SDR review card)
- **ListTable** (the list-detail table view)

No backend changes: `GET /lists/:id/leads` already returns full `Company`
docs via `Company.find().lean()`, so `qualification.isCompliant` and
`qualification.frameworks` are already in the payload both components
receive.

## Design

### Shared helper — `frontend/src/utils/compliance.js`

```js
export function complianceBadge(qualification) {
  const q = qualification || {};
  if (q.isCompliant === 'Yes') {
    return { compliant: true, label: `Compliant · ${q.frameworks || '—'}`, frameworks: q.frameworks };
  }
  return { compliant: false, label: 'Not confirmed', frameworks: null };
}
```

Centralizes the Yes/Not-confirmed → label/class logic so LeadCard and
ListTable render identically.

### LeadCard.jsx

- Render the badge in `.lead-card-header`, right after the existing AI
  verdict badge (`<span className={`badge ${status}`}>`).
- Remove the now-redundant "Compliance frameworks" `Signal` tile from the
  grid — the badge supersedes it.
- Keep "Compliance language" (`q.complianceLanguage`, the quoted evidence)
  since it's supporting detail the badge doesn't carry.

### ListTable.jsx

- Add a `Compliance` column between `Country` and `AI Verdict`.
- Cell renders the same badge. Frameworks text is CSS-truncated to one line
  (`text-overflow: ellipsis`) with the full string available via the `title`
  attribute on hover.
- Not sortable — no natural ordering for a Yes/frameworks-list field (same
  treatment as the existing unsorted `Actions` column).

### styles.css

Two new badge modifiers, reusing existing color tokens for consistency:

- `.badge.compliant` — green (same tokens as `.badge.qualified`)
- `.badge.compliance-unconfirmed` — neutral/indigo (same tokens as
  `.badge.pending`) — "not confirmed" isn't a bad verdict, just unknown, so
  it shouldn't read as red/failed.

## Testing

No frontend test infra exists in this repo yet (noted in `ce45f6a`). Verify
with `npm run build` and a manual check in the browser, consistent with how
prior frontend-only changes here were handled.

## Out of scope

- Standing up frontend test infra (separate effort if wanted later).
- Backend changes (data is already available).
