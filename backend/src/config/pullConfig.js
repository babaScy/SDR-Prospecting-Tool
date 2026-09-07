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
  // pool is exhausted. Only give up after this many empty rounds in a row.
  MAX_CONSECUTIVE_EMPTY_ROUNDS: 3,
  ENRICH_CONCURRENCY: 5,
  APOLLO_PER_PAGE: 25,
  RESET_TZ: 'Asia/Jerusalem',
};
