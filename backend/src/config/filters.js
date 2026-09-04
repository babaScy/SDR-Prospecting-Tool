const REGIONS = {
  uk:      ['United Kingdom', 'Ireland'],
  us:      ['United States'],
  benelux: ['Luxembourg', 'Netherlands', 'Belgium'],
  nordics: ['Norway', 'Finland', 'Denmark', 'Sweden'],
  dach:    ['Germany', 'Switzerland', 'Austria'],
  aus:     ['Australia', 'New Zealand'],
  poland:  ['Poland'],
  taiwan:  ['Taiwan','Singapore','South Korea'],
};

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

// Region-specific additions to COMMON_FILTERS.q_not_organization_keyword_tags,
// layered on top of (not replacing) the shared exclude list. Added 2026-09-04
// for benelux only, after the 2026-08-21 industry-tag-restriction removal
// (see filters.js history) left benelux's pool disproportionately diluted
// with non-software companies (Nordics/UK/DACH held up fine on the same
// shared filters — see docs/superpowers/2026-09-04 benelux investigation).
//
// These 2 keywords were chosen from real disqualified-vs-qualified keyword
// frequency on the last 5 benelux lists, then verified against a LIVE Apollo
// count (not just our own already-pulled sample, which underestimated the
// true pool-wide impact by roughly half for several candidates — e.g.
// 'manufacturing' alone looked like a ~17%-of-disqualified hit retrospectively
// but was a live -25.7% pool cut). This 2-keyword combo is live-verified at
// -17.9% pool size, removing 89/574 (16%) of benelux's disqualified companies
// for a cost of 19/287 (7%) of already-qualified ones (4.7:1 ratio) — the
// best live-verified tradeoff found that stays near the size-impact range
// discussed. Other candidates (manufacturing, nonprofit organization
// management, mechanical or industrial engineering) had comparable or better
// retrospective ratios but cut the live pool by 20-49% combined — too
// aggressive for what was asked ("without reducing the region size too much").
const REGION_KEYWORD_EXCLUDES = {
  benelux: [
    'education management',
    'energy & utilities',
  ],
};

const ICP1_FILTERS = {
  ...COMMON_FILTERS,
  organization_num_employees_ranges: ['1,10', '11,20', '21,50'],
};

const ICP2_FILTERS = {
  ...COMMON_FILTERS,
  organization_num_employees_ranges: ['51,100', '101,200', '201,250'],
};

const ICP3_FILTERS = {
  ...COMMON_FILTERS,
  organization_num_employees_ranges: ['251,500', '501,1000', '1001,5000', '5001,10000', '10001,'],
};

module.exports = { ICP1_FILTERS, ICP2_FILTERS, ICP3_FILTERS, REGIONS, REGION_KEYWORD_EXCLUDES };
