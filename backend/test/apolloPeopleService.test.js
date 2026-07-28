const { test } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/apolloPeopleService');

test('domainFromWebsite strips protocol and www', () => {
  assert.equal(svc.domainFromWebsite('https://www.acme.com/pricing'), 'acme.com');
  assert.equal(svc.domainFromWebsite('http://acme.io'), 'acme.io');
  assert.equal(svc.domainFromWebsite(''), null);
  assert.equal(svc.domainFromWebsite('not a url'), null);
});

test('buildSearchBody uses domain, titles, per_page 25', () => {
  const body = svc.buildSearchBody('acme.com');
  assert.equal(body.per_page, 25);
  assert.deepEqual(body.q_organization_domains_list, ['acme.com']);
  assert.equal(body.include_similar_titles, true);
  assert.ok(body.person_titles.includes('ceo'));
});

test('searchCandidates returns people via injected post', async () => {
  const post = async (url, body) => ({ data: { people: [{ id: 'p1', title: 'CTO' }] } });
  const people = await svc.searchCandidates('acme.com', { post });
  assert.equal(people.length, 1);
  assert.equal(people[0].id, 'p1');
});

test('bulkMatch batches by 10 and maps by id', async () => {
  const calls = [];
  const post = async (url, body) => {
    calls.push(body.details.length);
    return { data: { matches: body.details.map((d) => ({ id: d.id, email: `${d.id}@x.com` })) } };
  };
  const items = Array.from({ length: 23 }, (_, i) => ({ person: { id: `p${i}` }, domain: 'acme.com' }));
  const map = await svc.bulkMatch(items, { post });
  assert.deepEqual(calls, [10, 10, 3]); // three batches
  assert.equal(map.get('p0').email, 'p0@x.com');
  assert.equal(map.size, 23);
});
