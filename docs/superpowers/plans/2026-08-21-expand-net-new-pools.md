# Expand Net-New Company Pools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow Apollo net-new sourcing pools (especially benelux, nordics, and icp2) by removing the `organization_industry_tag_ids` include-restriction and adding two DB-validated keywords to `q_organization_keyword_tags`, both in `COMMON_FILTERS`.

**Architecture:** Two edits to the single shared `COMMON_FILTERS` object in `backend/src/config/filters.js`. No new files, no per-region/per-tier override mechanism (explicitly out of scope — see spec). `buildSearchBody` in `apolloService.js` already spreads `COMMON_FILTERS` into every request, so no other code changes are needed.

**Tech Stack:** Node.js, `node:test` + `node:assert/strict` (existing test runner, no new deps).

**Spec:** `docs/superpowers/specs/2026-08-21-expand-net-new-pools-design.md`

## Global Constraints

- Employee-count bands (`organization_num_employees_ranges`) are unchanged for all three ICP tiers — do not touch `ICP1_FILTERS`, `ICP2_FILTERS`, or `ICP3_FILTERS`.
- `organization_not_industry_tag_ids` (the exclude list) is unchanged.
- No per-region/per-tier filter override mechanism is being added in this plan.
- Both changes apply globally (all 8 regions, all 3 tiers) since they live in `COMMON_FILTERS`.

---

### Task 1: Update `COMMON_FILTERS` and verify

**Files:**
- Modify: `backend/src/config/filters.js:12-98` (the `COMMON_FILTERS` object)
- Test: `backend/test/apolloService.test.js`

**Interfaces:**
- Consumes: nothing new — `COMMON_FILTERS` is an existing plain object exported (via `ICP1_FILTERS`/`ICP2_FILTERS`/`ICP3_FILTERS` spreads) from `backend/src/config/filters.js`.
- Produces: `buildSearchBody(profile, region, page, perPage)` in `backend/src/services/apolloService.js` (unchanged signature) will now return a body with no `organization_industry_tag_ids` key and two extra entries in `q_organization_keyword_tags`. No other task depends on this one.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `backend/test/apolloService.test.js` (append after the existing `test('buildSearchBody uses icp3 employee ranges', ...)` block, before the "throws on unknown profile" test):

```javascript
test('buildSearchBody no longer restricts to the industry include-list', () => {
  const body = buildSearchBody('icp2', 'benelux', 1, 25);
  assert.equal('organization_industry_tag_ids' in body, false);
});

test('buildSearchBody keeps the industry exclude-list untouched', () => {
  const body = buildSearchBody('icp1', 'uk', 1, 25);
  assert.deepEqual(body.organization_not_industry_tag_ids, [
    '5567cd467369644d39040000',
    '5567e09973696410db020800',
    '5567cdd47369643dbf260000',
    '5567cd8e7369645409450000',
    '5567d1127261697f2b1d0000',
    '5567ce987369643b789e0000',
  ]);
});

test('buildSearchBody includes the two new keyword tags for every profile', () => {
  for (const profile of ['icp1', 'icp2', 'icp3']) {
    const body = buildSearchBody(profile, 'nordics', 1, 25);
    assert.ok(body.q_organization_keyword_tags.includes('computer systems design and related services'), `${profile} missing computer-systems-design keyword`);
    assert.ok(body.q_organization_keyword_tags.includes('data analytics'), `${profile} missing data-analytics keyword`);
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && node --test test/apolloService.test.js`
Expected: the 3 new tests FAIL (`organization_industry_tag_ids` is still present; the two keywords are missing). The 5 pre-existing tests in this file still PASS.

- [ ] **Step 3: Edit `COMMON_FILTERS` in `backend/src/config/filters.js`**

Remove the `organization_industry_tag_ids` field (lines 84-89 in the current file) entirely from `COMMON_FILTERS`. Add the two new terms to the end of `q_organization_keyword_tags`'s array (after `'workflow automation'`). The edited object should read:

```javascript
const COMMON_FILTERS = {
  person_titles: [
    'ceo', 'cto', 'ciso', 'co-founder', 'founder', 'managing director',
    'chief executive officer', 'chief technology officer', 'chief operating officer',
    'vp engineering', 'vp technology', 'vp product', 'vp operations',
    'head of engineering', 'head of technology', 'head of operations',
    'it director', 'head of security', 'technical director', 'director of technology',
    'director of engineering', 'director of product', 'director of operations',
    'director', 'general manager',
    // Security/compliance-buyer titles — added 2026-08-11 to better match
    // Scytale's actual buyer persona (see docs/superpowers/specs/2026-08-11-
    // broaden-apollo-sourcing-filters-design.md). Live-tested at ~0% pool-size
    // impact (the existing generic titles already admit most matching
    // companies), so these are for buyer-persona precision, not volume.
    'chief information security officer', 'cio', 'chief information officer',
    'vp security', 'head of information security', 'director of information security',
    'head of product security', 'head of trust', 'vp trust and safety',
    'head of compliance', 'compliance manager', 'vp compliance',
  ],
  prospected_by_current_team: ['no'],
  market_segments: ['b2b', 'saas'],
  q_organization_keyword_tags: [
    'saas',
    'paas',
    'platform',
    'cloud',
    'ai',
    'b2b software',
    'data platform',
    // Added 2026-08-11 — DB-correlation-backed (1.3x-2.2x qualify-rate lift)
    // and live-tested at +39%-+43% pool-size lift. See design doc above.
    'computer software',
    'software as a service',
    'api integration',
    'workflow automation',
    // Added 2026-08-21 — DB-correlation-backed on the larger 1317-company
    // decided set (1.3x-1.6x qualify-rate lift, present on 12%-27% of
    // qualified companies) and live-tested at 0%-+11% pool-size lift on the
    // thinnest regions. See docs/superpowers/specs/2026-08-21-expand-net-new-
    // pools-design.md.
    'computer systems design and related services',
    'data analytics',
  ],
  included_organization_keyword_fields: ['tags', 'name'],
  q_not_organization_keyword_tags: [
    'consulting services',
    'consulting',
    'it consulting',
    'b2c',
    'freelancer',
    'business consulting & services',
    'advisory',
    'bespoke solutions',
    'custom solutions',
    'custom software development',
    'technology consulting',
    // 'software development' (bare) replaced 2026-08-11 — it matched against
    // tags/name/social_media_description broadly and was suppressing roughly
    // half-to-two-thirds of each region's icp2 pool (live-tested), with no DB
    // evidence it was doing necessary exclusion work the more specific phrases
    // below don't already cover. Highest-uncertainty change in this batch —
    // see monitoring plan in the design doc.
    'software development services',
    'software development agency',
    'outsourced software development',
    'software development consultancy',
    'staffing & recruiting',
    'venture capital',
    'events',
    'game development',
    'game development tools',
    'recruitment & staffing',
    'magazine',
    'marketing services',
    'marketing and advertising',
    'consumer services',
    'management consulting',
  ],
  excluded_organization_keyword_fields: ['tags', 'name', 'social_media_description'],
  // organization_industry_tag_ids (the "must be tagged as IT & services /
  // health & fitness / financial services / internet" include-restriction)
  // removed 2026-08-21 — it was the single most restrictive filter in this
  // config (live-tested at +566% pool lift on benelux/icp2 alone when
  // removed) and one of its four included industries, "financial services",
  // independently underperformed the other three by 1.5x-3x. The newly-
  // admitted companies are unvalidated by the AI qualifier — see monitoring
  // plan in docs/superpowers/specs/2026-08-21-expand-net-new-pools-design.md.
  organization_not_industry_tag_ids: [
    '5567cd467369644d39040000',
    '5567e09973696410db020800',
    '5567cdd47369643dbf260000',
    '5567cd8e7369645409450000',
    '5567d1127261697f2b1d0000',
    '5567ce987369643b789e0000',
  ],
};
```

- [ ] **Step 4: Run the full backend test suite**

Run: `cd backend && npm test`
Expected: PASS — all tests including the 3 new ones and the pre-existing 5 in `apolloService.test.js`, plus every other test file (`test/**/*.test.js`). No file other than `backend/src/config/filters.js` and `backend/test/apolloService.test.js` should show a diff.

- [ ] **Step 5: Live sanity check against Apollo**

Run: `cd backend && node scripts/netNewCounts.js`
Expected: grand total substantially higher than the pre-change baseline of 37,146 (projected ~91,780 per the spec's live count capture) — confirms the deployed filter actually changed Apollo's live result set, not just the test mocks.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/filters.js backend/test/apolloService.test.js
git commit -m "feat(prospector): drop industry-tag include restriction, add 2 keyword tags

Removes organization_industry_tag_ids from COMMON_FILTERS (was the most
restrictive single filter; live-tested +566% pool lift on benelux/icp2)
and adds 'computer systems design and related services' + 'data
analytics' to q_organization_keyword_tags (DB-validated 1.3x-1.6x
qualify-rate lift). See docs/superpowers/specs/2026-08-21-expand-net-new-
pools-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Post-implementation (not a task — do after merge, per spec's monitoring plan)

After the next real pull batch runs in each region under these filters, re-run `backend/scripts/qualifiedRateReport.js` and compare against today's baseline (46.1% aggregate, 733/1589). If the aggregate qualified rate drops meaningfully, the isolated rollback is re-adding `organization_industry_tag_ids` (revert the `filters.js` change from this task) — the keyword addition is independently low-risk and does not need to be reverted alongside it.
