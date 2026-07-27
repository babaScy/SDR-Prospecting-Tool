const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startOfTodayInTz } = require('../src/util/dayBoundary');

const wallClock = (instant, tz) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(instant);

test('result is midnight wall-clock in the target tz', () => {
  const now = new Date('2026-07-27T09:30:00Z'); // any instant
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.equal(wallClock(start, 'Asia/Jerusalem'), '00:00:00');
});

test('result is at or before now, within the last 24h', () => {
  const now = new Date('2026-07-27T09:30:00Z');
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.ok(start.getTime() <= now.getTime());
  assert.ok(now.getTime() - start.getTime() < 24 * 60 * 60 * 1000);
});

test('an instant just after local midnight maps to that same day', () => {
  // 2026-07-27T00:05 Jerusalem (UTC+3 in summer) == 2026-07-26T21:05Z
  const now = new Date('2026-07-26T21:05:00Z');
  const start = startOfTodayInTz('Asia/Jerusalem', now);
  assert.equal(wallClock(start, 'Asia/Jerusalem'), '00:00:00');
  assert.ok(now.getTime() - start.getTime() < 60 * 60 * 1000); // ~5 min after midnight
});
