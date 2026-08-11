# Broaden Apollo sourcing filters (design)

## Background

Prospector sources companies from Apollo's `mixed_companies/search` API using a fixed set of filters (`backend/src/config/filters.js`) shared across all 3 ICP tiers and all 8 regions. Several region/ICP-tier pools are close to exhausted — e.g. benelux/icp2 had only ~23-29 organizations total matching our filters, and SDRs assigned to thin segments increasingly hit "pool exhausted, 0 qualified" outcomes on pulls (see `BENELUX · ICP2 · 8 Aug` list investigation, list id `6a777691811796c5eff13dda`).

This spec broadens the filters to grow available pools across all regions, without materially diluting the AI qualifier's pass rate (baseline: 40.3% overall, see breakdown below).

## Research summary

Two parallel research passes (DB analysis of `qualification.reasoning`/`disqualifyReason` history, industry-tag correlation, and web research) plus a live Apollo experiment (count-only calls comparing candidate filter variants against production filters on the four thinnest icp2 regions: poland, nordics, benelux, dach) produced the following findings:

**Baseline qualified rate** (all 572 companies in DB as of 2026-08-11): 40.3% overall (230 qualified / 252 disqualified / 89 nei / 1 pending). By region: aus 45.5%, benelux 32.6%, dach 40.9%, nordics 40.3%, poland 16.7%, taiwan 90% (n=10), uk 58.2%. By profile: icp1 42.0%, icp2 31.6% (thinner and lower-quality tier overall). `us` region and `icp3` tier have zero companies pulled so far — no data exists to validate changes there yet.

**Title broadening → ~0% pool impact.** `person_titles` is an OR match; the existing list already includes broad titles (`director`, `ceo`, `general manager`) that most companies already satisfy, so adding niche security/compliance titles rarely surfaces a company that wasn't already eligible. Live test: +0% to +3% lift across the four thin regions. Titles are being added anyway for buyer-persona precision, not volume.

**Positive keyword broadening → +39% to +43% live pool lift.** DB correlation (qualify rate given keyword present, against 419 already-filtered companies, using `keywords` as a proxy for Apollo's `tags`/`name` fields) identified `computer software` (65.9% qualify rate, 2.24x baseline lift, present on 84% of qualified companies but currently absent from the filter), `software as a service` (100%, n=12), `api integration` (81.3%), and `workflow automation` (80.0%) as strong, low-risk additions. Live-validated at +39-43% pool lift on poland/nordics/benelux/dach.

**Narrowing `software development` exclude → +100% to +160% live pool lift (dominant lever, highest uncertainty).** The bare term `software development` in `q_not_organization_keyword_tags` is checked against `tags`, `name`, AND `social_media_description` (a wider surface than the positive list). No DB evidence found a genuinely-correct exclusion that specifically relied on this bare term (other exclusions map cleanly to `consulting`, `bespoke solutions`, `staffing & recruiting`, etc.), and several correctly-excluded services/consultancy companies in the DB already passed the current filter anyway — suggesting the exclude list isn't tightly catching what it's meant to catch. Live test replacing the bare term with `software development services`, `software development agency`, `outsourced software development`, `software development consultancy` (keeping `custom software development` unchanged) showed the largest lift of anything tested. This is a real quality-regression risk that hasn't been directly observed on real companies (as opposed to inferred from proxy DB fields) — flagged and accepted knowingly per the chosen approach (see Decision below).

Full agent research transcripts and throwaway analysis scripts are preserved under `backend/scripts/research_titles_*.js` and `backend/scripts/research_keywords_*.js`; the live experiment script is `backend/scripts/research_apollo_experiment.js`.

## Decision

Ship all three changes together now (accepting the exclude-list narrowing's unvalidated risk in exchange for the larger, faster pool increase), rather than gating it behind a separate trial pull first. Mitigate via the monitoring step below instead of a pre-rollout trial.

## Changes

All changes are to `COMMON_FILTERS` in `backend/src/config/filters.js`, applied identically across all 8 regions and all 3 ICP tiers (icp1/icp2/icp3) since `COMMON_FILTERS` is shared.

**1. `person_titles` — add 12 titles:**
```
'chief information security officer', 'cio', 'chief information officer',
'vp security', 'head of information security', 'director of information security',
'head of product security', 'head of trust', 'vp trust and safety',
'head of compliance', 'compliance manager', 'vp compliance',
```
Explicitly excluding `data protection officer` / `dpo` — flagged as a mandated role at government/non-profit/large-data-controller orgs regardless of software-centricity; not part of any tested variant. Follow-up item, not in this change.

**2. `q_organization_keyword_tags` — add 4 terms:**
```
'computer software', 'software as a service', 'api integration', 'workflow automation',
```
Leaving out `computer systems design and related services` and `data analytics` (flagged "cautious" in research, not live-tested) as a documented follow-up.

**3. `q_not_organization_keyword_tags` — remove `software development`, add 4 more specific phrases:**
```
// remove: 'software development'
// add:
'software development services', 'software development agency',
'outsourced software development', 'software development consultancy',
```
`custom software development` is unchanged.

**Out of scope for this change:** `REGIONS` (geographic expansion), employee-range bands, `organization_industry_tag_ids`/`organization_not_industry_tag_ids` (opaque Apollo IDs — only one of the six was confidently resolved to "information technology & services"; resolving the rest needs direct Apollo API/dashboard access, not achievable from DB data or web search alone).

## Monitoring / rollback

Since this ships without a pre-rollout trial, add a small reusable report script (`backend/scripts/qualifiedRateReport.js`, formalizing the ad-hoc `research_titles_stats.js`) that computes qualified rate by region and by profile from the `Company` collection. Today's baseline (captured above) is the reference point.

After the next batch of pulls runs under the new filters in each region, re-run the report. If any region/profile's qualified rate drops meaningfully below its pre-change baseline, the isolated response is to revert change #3 (the exclude-list narrowing) specifically, since it's the change with no direct observation of real companies behind it — changes #1 and #2 are DB-correlation-backed and lower-risk independent of #3's outcome.

## Testing

`test/apolloPeopleService.test.js` asserts `person_titles.includes('ceo')` — still true after this change (additive only). No test hard-codes the full contents of any `COMMON_FILTERS` list, so no other test changes are required. No new automated test is proposed for the filter *values* themselves (they're sourcing config, not logic); `qualifiedRateReport.js` is the verification mechanism for this change, run manually pre/post rollout as described above.
