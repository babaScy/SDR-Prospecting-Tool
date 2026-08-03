module.exports = {
  DAILY_QUALIFIED_QUOTA: 5,
  FIRST_BATCH_SIZE: 10,
  SYNC_THRESHOLD: 3,     // chunk < 3 → sync Messages API; >= 3 → Batches API
  SESSION_MAX_PULLED: 60,
  // A round can save 0 new companies just from bad luck (the handful of items
  // it reserved happen to already exist) — that isn't proof the region/profile
  // pool is exhausted. Only give up after this many empty rounds in a row.
  MAX_CONSECUTIVE_EMPTY_ROUNDS: 3,
  ENRICH_CONCURRENCY: 5,
  APOLLO_PER_PAGE: 25,
  RESET_TZ: 'Asia/Jerusalem',
};
