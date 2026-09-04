process.env.APOLLO_API_KEY ||= 'test-key';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchBody, mapOrganization } = require('../src/services/apolloService');

test('buildSearchBody merges profile filters, region locations, paging', () => {
  const body = buildSearchBody('icp1', 'uk', 3, 25);
  assert.equal(body.page, 3);
  assert.equal(body.per_page, 25);
  assert.deepEqual(body.organization_locations, ['United Kingdom', 'Ireland']);
  assert.deepEqual(body.organization_num_employees_ranges, ['1,10', '11,20', '21,50']);
  assert.deepEqual(body.market_segments, ['b2b', 'saas']);
});

test('buildSearchBody uses icp2 employee ranges', () => {
  const body = buildSearchBody('icp2', 'us', 1, 25);
  assert.deepEqual(body.organization_num_employees_ranges, ['51,100', '101,200', '201,250']);
  assert.deepEqual(body.organization_locations, ['United States']);
});

test('buildSearchBody uses icp3 employee ranges', () => {
  const body = buildSearchBody('icp3', 'taiwan', 1, 25);
  assert.deepEqual(body.organization_num_employees_ranges, ['251,500', '501,1000', '1001,5000', '5001,10000', '10001,']);
  assert.deepEqual(body.organization_locations, ['Taiwan', 'Singapore', 'South Korea']);
});

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

test('buildSearchBody adds benelux-only keyword excludes (2026-09-04 quality fix), untouched elsewhere', () => {
  const BENELUX_ONLY_EXCLUDES = ['education management', 'energy & utilities'];

  const benelux = buildSearchBody('icp1', 'benelux', 1, 25);
  for (const kw of BENELUX_ONLY_EXCLUDES) {
    assert.ok(benelux.q_not_organization_keyword_tags.includes(kw), `benelux missing exclude: ${kw}`);
  }
  // The shared exclude list underneath is still there too, untouched.
  assert.ok(benelux.q_not_organization_keyword_tags.includes('management consulting'));

  for (const region of ['uk', 'us', 'nordics', 'dach', 'aus', 'poland', 'taiwan']) {
    const body = buildSearchBody('icp1', region, 1, 25);
    for (const kw of BENELUX_ONLY_EXCLUDES) {
      assert.equal(body.q_not_organization_keyword_tags.includes(kw), false, `${region} should not have benelux-only exclude: ${kw}`);
    }
  }
});

test('buildSearchBody includes the two new keyword tags for every profile', () => {
  for (const profile of ['icp1', 'icp2', 'icp3']) {
    const body = buildSearchBody(profile, 'nordics', 1, 25);
    assert.ok(body.q_organization_keyword_tags.includes('computer systems design and related services'), `${profile} missing computer-systems-design keyword`);
    assert.ok(body.q_organization_keyword_tags.includes('data analytics'), `${profile} missing data-analytics keyword`);
  }
});

test('buildSearchBody throws on unknown profile or region', () => {
  assert.throws(() => buildSearchBody('icp9', 'uk', 1, 25), /Unknown profile/);
  assert.throws(() => buildSearchBody('icp1', 'mars', 1, 25), /Unknown region/);
});

test('mapOrganization maps Apollo fields, falls back to primary_domain', () => {
  const mapped = mapOrganization({
    id: 'org1',
    name: 'Acme',
    website_url: null,
    primary_domain: 'acme.io',
    industry: 'software',
    estimated_num_employees: 40,
    organization_revenue_printed: '5M',
    country: 'United Kingdom',
    city: 'London',
    founded_year: 2020,
    short_description: 'B2B SaaS',
    keywords: ['saas'],
    technology_names: ['AWS'],
    total_funding_printed: '2M',
    latest_funding_stage: 'Seed',
    latest_funding_round_date: '2025-01-01',
    linkedin_url: 'https://linkedin.com/company/acme',
  });
  assert.equal(mapped.apolloAccountId, 'org1');
  assert.equal(mapped.companyName, 'Acme');
  assert.equal(mapped.website, 'https://acme.io');
  assert.equal(mapped.employees, 40);
  assert.deepEqual(mapped.technologies, ['AWS']);
});

test('mapOrganization leaves website unset when Apollo has no domain', () => {
  const mapped = mapOrganization({ id: 'org9', name: 'NoWeb', website_url: null, primary_domain: null });
  assert.ok(!mapped.website, `expected no website, got ${JSON.stringify(mapped.website)}`);
  assert.notEqual(mapped.website, 'https://null');
});

test('mapOrganization leaves website unset when primary_domain is undefined', () => {
  const mapped = mapOrganization({ id: 'org10', name: 'NoWeb2' });
  assert.ok(!mapped.website, `expected no website, got ${JSON.stringify(mapped.website)}`);
  assert.notEqual(mapped.website, 'https://undefined');
});
