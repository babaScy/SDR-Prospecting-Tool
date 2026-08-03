const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/hubspotService');

beforeEach(() => svc.clearCaches());

test('normalizeDomain strips protocol, www, and path', () => {
  assert.equal(svc.normalizeDomain('https://www.acme.com/pricing'), 'acme.com');
  assert.equal(svc.normalizeDomain('acme.io'), 'acme.io');
  assert.equal(svc.normalizeDomain(''), null);
  assert.equal(svc.normalizeDomain(null), null);
});

test('normalizeEmail lowercases and rejects non-emails', () => {
  assert.equal(svc.normalizeEmail('Jane@Acme.COM'), 'jane@acme.com');
  assert.equal(svc.normalizeEmail('not-an-email'), null);
  assert.equal(svc.normalizeEmail(null), null);
});

test('normalizeLinkedIn canonicalizes to https, no www, no trailing slash', () => {
  assert.equal(svc.normalizeLinkedIn('http://www.linkedin.com/in/jane/'), 'https://linkedin.com/in/jane');
  assert.equal(svc.normalizeLinkedIn('not linkedin'), null);
});

test('linkedinVariants covers protocol/www/trailing-slash combinations', () => {
  const variants = svc.linkedinVariants('linkedin.com/in/jane');
  assert.ok(variants.includes('https://linkedin.com/in/jane'));
  assert.ok(variants.includes('https://www.linkedin.com/in/jane/'));
  assert.equal(svc.linkedinVariants(null).length, 0);
});

test('getOwnerIdByEmail returns the matching owner id', async () => {
  const request = async () => ({ data: { results: [{ id: 'owner-1' }] } });
  const id = await svc.getOwnerIdByEmail('davidv@scytale.ai', { request });
  assert.equal(id, 'owner-1');
});

test('getOwnerIdByEmail returns null when no HubSpot user matches', async () => {
  const request = async () => ({ data: { results: [] } });
  const id = await svc.getOwnerIdByEmail('nobody@scytale.ai', { request });
  assert.equal(id, null);
});

test('getOwnerIdByEmail caches by email (case-insensitive) — second call skips the request', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return { data: { results: [{ id: 'owner-2' }] } }; };
  await svc.getOwnerIdByEmail('davidv@scytale.ai', { request });
  await svc.getOwnerIdByEmail('DavidV@Scytale.ai', { request });
  assert.equal(calls, 1);
});
