# Expand net-new company pools (design)

## Background

The 2026-08-11 filter broadening (`docs/superpowers/specs/2026-08-11-broaden-apollo-sourcing-filters-design.md`) is live and reflected in the current baseline: 1590 companies pulled, 733 qualified (46.1% overall). Several segments remain thin and/or underperforming: benelux (876 net-new, 36% qualify rate; icp2 alone 45 pulled, 17.8%), nordics (865 net-new, 43.8%; icp2 alone 41 pulled, 29.3%), and icp2 overall (34.7% vs icp1's 48.1%). Poland is explicitly out of scope for this round (deprioritized by the business).

Goal: grow net-new pool size, especially in benelux and nordics and in the icp2 tier generally, while keeping the *aggregate* qualified rate close to the current 46.1% baseline (a per-segment floor — e.g. benelux/icp2 staying at 17.8% — is explicitly not required; only the overall number matters). Filters may differ by region and by ICP tier if that produces better pool size ("mix and match"); the AI qualifier's criteria for judging a company are unchanged and identical everywhere — only the Apollo sourcing filters (what makes it into the pool) are in scope.

## Research summary

Two research passes, following the same methodology as the 08-11 doc (DB correlation against `qualification.reasoning`/`disqualifyReason`, plus live count-only Apollo experiments), targeted specifically at levers the 08-11 doc left out of scope: employee-range bands, and the opaque `organization_industry_tag_ids`/`organization_not_industry_tag_ids` IDs. Throwaway scripts are preserved under `backend/scripts/research_v2_*.js`.

**Employee-count band widening → rejected.** Tested widening icp2's `organization_num_employees_ranges` down to include 41-50 and up to include 251-300. The 41-50 band qualifies at 26.7% overall (n=45) — worse than icp2's own current bands (33-35%) in every slice, including 0% in nordics (n=5) and 25% in benelux (n=8). Spot-checking disqualified 41-50 companies' `qualification.reasoning` confirmed genuine business-model mismatches (non-profits, hardware makers, food-tech, agencies), not sampling noise. 251-300 has essentially no data (n=1 globally). Live Apollo count lift for the 41-50 widen was +23% to +39% on thin regions, but that lift reads as mostly-bad companies. Not implemented.

**Region-specific keyword signal → none found.** Searched specifically for a benelux- or nordics-only keyword/tag pattern (as opposed to a global one). Found none with real signal — the only high-lift tokens were either tiny-n noise (2-4 companies) or local-language description artifacts (Dutch, Swedish, Danish terms) unlikely to match Apollo's structured `tags`/`name` fields. Two candidate keywords surfaced instead as *global* signals on the larger 1317-company decided set: `computer systems design and related services` (n=249, 78.7% qualify, 1.57x lift, present on 26.7% of qualified companies) and `data analytics` (n=128, 70.3%, 1.30x lift, 12.3% of qualified) — these are exactly the two terms the 08-11 doc flagged as "cautious, not tested," now supported by DB-correlation confidence comparable to what was already shipped. Live-tested lift on adding both: 0% (poland) to +11% (benelux) — modest, non-negative everywhere tested.

**`organization_industry_tag_ids` (industry include-list) → major, high-uncertainty lever.** All 10 opaque IDs resolved via Apollo's own `breadcrumbs.display_name` field in the search response (previously only 1/10 was confidently known):
- Include (`organization_industry_tag_ids`): information technology & services, health/wellness & fitness, financial services, internet.
- Exclude (`organization_not_industry_tag_ids`): marketing & advertising, staffing & recruiting, management consulting, events services, consumer services, consumer goods.

Within the include list, "financial services" underperforms the other three by 1.5-3x consistently (e.g. benelux icp2: 16.7% vs 21.2%) — a real, DB-backed signal on its own. But the larger finding: **removing the include-list restriction entirely** grew benelux/icp2's live Apollo count from 47 → 313 (+566%), dwarfing every lever in the 08-11 batch. There is no qualify-rate data for the newly-admitted companies — they were never tagged by Apollo as IT/software/etc. before, so nobody has seen how the AI qualifier treats them. Flagged to the user as categorically larger and less validated than anything shipped before; decision below.

The exclude list (`organization_not_industry_tag_ids`) was separately confirmed low-risk: removing it entirely only grew benelux/icp2 by +6% (47→50), and all 6 excluded industries map cleanly onto keyword excludes already in `q_not_organization_keyword_tags`. No accidental exclusion of a benelux/nordics-heavy category was found. Not changed.

Apollo has a real tag search/typeahead endpoint (`api/v1/tags/search`), confirmed via a 403 scope-denied response rather than a 404 — follow-up item (not in this change) is requesting a broader-scoped API key to resolve additional industry tags directly instead of reverse-engineering via breadcrumbs.

## Decision

Ship the industry-include-list removal globally (all regions, all tiers) despite the unvalidated risk, per explicit user direction — same "ship now, monitor after" philosophy as 08-11's exclude-list narrowing, applied to a larger lever. Ship the two global keyword additions alongside it (low-risk, DB-validated). Do not build a per-region/per-tier filter-override mechanism: both research areas that specifically hunted for a region-specific lever (employee bands, keyword tokens) came back empty — the two changes that did work are uniform, global improvements. Building override scaffolding nothing currently uses is deferred until a genuine per-segment case appears.

## Changes

Both changes are to `COMMON_FILTERS` in `backend/src/config/filters.js`, applied identically across all 8 regions and all 3 ICP tiers.

**1. Remove `organization_industry_tag_ids` entirely** (delete the field from `COMMON_FILTERS`). `organization_not_industry_tag_ids` is unchanged.

**2. `q_organization_keyword_tags` — add 2 terms:**
```
'computer systems design and related services', 'data analytics',
```

**Out of scope for this change:** employee-range bands (tested, rejected — see research summary), a per-region/per-tier filter override mechanism (no validated use case found this round), requesting a broader-scoped Apollo API key to resolve more industry tags (follow-up).

## Projected impact

Live Apollo counts, current filters vs. candidate (industry-include removed + 2 keywords added), captured 2026-08-21 via `backend/scripts/research_v2_projected_counts.js`:

| region | current total | projected total | icp2 current → new |
|---|---|---|---|
| benelux | 876 | 3,505 | 47 → 343 |
| nordics | 865 | 3,072 | 38 → 238 |
| poland | 413 | 1,036 | 26 → 86 |
| dach | 1,964 | 5,828 | 65 → 451 |
| uk | 4,489 | 13,961 | 215 → 960 |
| aus | 1,399 | 5,049 | 44 → 298 |
| taiwan | 1,440 | 3,159 | 160 → 356 |
| us | 25,700 | 56,170 | 2,872 → 6,592 |
| **grand total** | **37,146** | **91,780** | **+147%** |

Both benelux and nordics clear 1,000 by more than 3x; icp2 grows roughly 6-7x in the thin regions. This is a substantially larger jump than the 08-11 batch, driven almost entirely by change #1.

## Monitoring / rollback

Same mechanism as 08-11: re-run `backend/scripts/qualifiedRateReport.js` after the next pull batch completes in each region. Baseline for comparison is today's aggregate: 46.1% (733/1589). If the aggregate qualified rate drops meaningfully below baseline, the isolated response is to revert change #1 (re-add `organization_industry_tag_ids`) specifically, since it's the only high-uncertainty change here — change #2 is DB-correlation-backed and independently low-risk regardless of change #1's outcome, same logic the 08-11 doc used for its own two-tier risk split.

## Testing

`backend/test/apolloService.test.js` asserts `organization_num_employees_ranges` per profile — unaffected, employee ranges are not changing. No test references `organization_industry_tag_ids`, `organization_not_industry_tag_ids`, or the contents of `q_organization_keyword_tags`, so no test changes are required. `qualifiedRateReport.js` remains the verification mechanism for the change itself (sourcing config, not logic), run manually pre/post rollout as described above.
