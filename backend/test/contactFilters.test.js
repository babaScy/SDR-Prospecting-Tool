const { test } = require('node:test');
const assert = require('node:assert/strict');
const cf = require('../src/config/contactFilters');

test('exports the WOLF+ contact-search constants', () => {
  assert.ok(Array.isArray(cf.BROAD_SEARCH_TITLES) && cf.BROAD_SEARCH_TITLES.includes('ceo'));
  assert.ok(cf.BROAD_SEARCH_TITLES.includes('chief technology officer'));
  assert.ok(Array.isArray(cf.EXCLUDED_TITLES) && cf.EXCLUDED_TITLES.every((r) => r instanceof RegExp));
  // sales/marketing/hr must be excluded
  assert.ok(cf.EXCLUDED_TITLES.some((r) => r.test('VP of Sales')));
  assert.ok(cf.EXCLUDED_TITLES.some((r) => r.test('Head of Marketing')));
  assert.ok(cf.PROFILE_CONTEXT.icp1 && cf.PROFILE_CONTEXT.icp2);
  assert.match(cf.PICKER_SYSTEM_PROMPT, /Scytale/);
});
