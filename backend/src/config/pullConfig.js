// Default daily qualified-quota per SDR, for any region not listed in
// REGION_DAILY_CAPS below.
const DAILY_QUALIFIED_QUOTA = 5;

// Higher-pool regions get a raised daily cap; everything else falls back to
// DAILY_QUALIFIED_QUOTA. Keyed by the same region keys as config/filters.js.
const REGION_DAILY_CAPS = {
  us: 7,
  uk: 7,
  dach: 7,
  aus: 7,
  taiwan: 7,
};

const getDailyQuota = (region) => REGION_DAILY_CAPS[region] ?? DAILY_QUALIFIED_QUOTA;

module.exports = {
  DAILY_QUALIFIED_QUOTA,
  REGION_DAILY_CAPS,
  getDailyQuota,
  FIRST_BATCH_SIZE: 10,
  SYNC_THRESHOLD: 3,     // chunk < 3 → sync Messages API; >= 3 → Batches API
  SESSION_MAX_PULLED: 40,
  // A round can save 0 new companies just from bad luck (the handful of items
  // it reserved happen to already exist) — that isn't proof the region/profile
  // pool is exhausted. Counted in ITEMS checked, not rounds: a region/profile's
  // pull cursor is shared across every SDR and never resets, so once its raw
  // counter passes totalItems it wraps and starts re-walking positions from
  // earlier passes — which the apolloAccountId dedup skips as "already
  // exists", not "doesn't exist". A round-based threshold (the old
  // MAX_CONSECUTIVE_EMPTY_ROUNDS: 3) means as few as ~15-20 checked positions
  // near quota (rounds can be as small as k=1) before giving up — nowhere
  // near enough to prove a wrapped, partially-covered pool (e.g. 60% saved)
  // is actually exhausted; it just proves that particular contiguous stretch
  // was covered on an earlier pass. 2026-09-09: benelux/icp1 lapped once and
  // gave up 3 rounds (20 checked items) into a re-walk, even though ~910 real
  // net-new companies remained elsewhere in the same pool. Checking items
  // (cheap — a dedup existence check, no enrich/qualify cost) instead of
  // rounds gives far more runway to walk past an already-covered stretch
  // before concluding the pool is actually dry, while staying bounded/cheap.
  MAX_CONSECUTIVE_EMPTY_ITEMS: 200,
  ENRICH_CONCURRENCY: 5,
  APOLLO_PER_PAGE: 25,
  RESET_TZ: 'Asia/Jerusalem',
};
