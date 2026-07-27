module.exports = {
  DAILY_QUALIFIED_QUOTA: 5,
  FIRST_BATCH_SIZE: 10,
  SYNC_THRESHOLD: 3,     // chunk < 3 → sync Messages API; >= 3 → Batches API
  SESSION_MAX_PULLED: 60,
  ENRICH_CONCURRENCY: 5,
  APOLLO_PER_PAGE: 25,
  RESET_TZ: 'Asia/Jerusalem',
};
