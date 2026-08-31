const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyContactRecord,
  classifyCompanyRecord,
  classifySourceDetail,
  isAutoAssociateSource,
  classifyAssociatedContactSources,
  isNotFoundError,
  classifyLookupResult,
  predatesWolf,
} = require('../scripts/hubspotGapReport');

// ─── classifyContactRecord ───────────────────────────────────────────────
test('classifyContactRecord: synced contact needs no check', () => {
  assert.deepEqual(classifyContactRecord({ hubspotStatus: 'synced' }), { bucket: 'synced' });
});

test('classifyContactRecord: already_existed is a confirmed gap, no live check needed', () => {
  const result = classifyContactRecord({ hubspotStatus: 'already_existed', hubspotContactId: 'hs123' });
  assert.deepEqual(result, { bucket: 'gap', reason: 'already_existed', hubspotContactId: 'hs123' });
});

test('classifyContactRecord: none/failed with an email needs a live check', () => {
  assert.deepEqual(classifyContactRecord({ hubspotStatus: 'none', email: 'a@b.com' }), { bucket: 'needs-check' });
  assert.deepEqual(classifyContactRecord({ hubspotStatus: 'failed', email: 'a@b.com' }), { bucket: 'needs-check' });
});

test('classifyContactRecord: none/failed with a LinkedIn URL but no email still needs a check', () => {
  assert.deepEqual(
    classifyContactRecord({ hubspotStatus: 'none', linkedinUrl: 'https://linkedin.com/in/x' }),
    { bucket: 'needs-check' }
  );
});

test('classifyContactRecord: none/failed with neither email nor LinkedIn is not checkable', () => {
  assert.deepEqual(classifyContactRecord({ hubspotStatus: 'none' }), { bucket: 'not-checkable' });
  assert.deepEqual(classifyContactRecord({ hubspotStatus: 'failed' }), { bucket: 'not-checkable' });
});

// ─── classifyCompanyRecord ───────────────────────────────────────────────
test('classifyCompanyRecord: a real hubspotCompanyId still needs a source check, not a free pass', () => {
  // resolveOrCreateCompany() reuses a pre-existing domain match rather than
  // always creating — so hubspotCompanyId alone doesn't prove we created it.
  assert.deepEqual(classifyCompanyRecord({ hubspotCompanyId: 'hs456' }), { bucket: 'has-id' });
});

test('classifyCompanyRecord: a PENDING claim marker is not a real id', () => {
  assert.deepEqual(classifyCompanyRecord({ hubspotCompanyId: 'PENDING', website: 'https://acme.com' }), { bucket: 'needs-domain-search' });
  assert.deepEqual(classifyCompanyRecord({ hubspotCompanyId: 'PENDING' }), { bucket: 'not-checkable' });
});

test('classifyCompanyRecord: no hubspotCompanyId and no website is not checkable', () => {
  assert.deepEqual(classifyCompanyRecord({}), { bucket: 'not-checkable' });
});

test('classifyCompanyRecord: no hubspotCompanyId but a website needs a domain search', () => {
  assert.deepEqual(classifyCompanyRecord({ website: 'https://acme.com' }), { bucket: 'needs-domain-search' });
});

// ─── classifySourceDetail ────────────────────────────────────────────────
test('classifySourceDetail: AI-SDR-App means Prospector genuinely created it', () => {
  assert.deepEqual(classifySourceDetail('AI-SDR-App'), { bucket: 'known' });
});

test('classifySourceDetail: any other source means we resolved to a pre-existing company', () => {
  assert.deepEqual(classifySourceDetail('CRM_UI'), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
  assert.deepEqual(classifySourceDetail(''), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
  assert.deepEqual(classifySourceDetail(undefined), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
});

// ─── isAutoAssociateSource / classifyAssociatedContactSources ────────────
// HubSpot's own "create a company from a contact's domain" automation can
// fire off a contact WE pushed just as easily as an external one, so that
// specific source needs the associated-contacts check below rather than
// being trusted as a gap outright.
test('isAutoAssociateSource: matches HubSpot\'s auto-associate setting exactly', () => {
  assert.equal(isAutoAssociateSource('"Create and associate companies with contacts" setting'), true);
  assert.equal(isAutoAssociateSource('AI-SDR-App'), false);
  assert.equal(isAutoAssociateSource('CRM_UI'), false);
});

test('classifyAssociatedContactSources: every contact ours means the company was our own side effect, not a gap', () => {
  assert.deepEqual(classifyAssociatedContactSources(['AI-SDR-App', 'AI-SDR-App']), { bucket: 'known' });
});

test('classifyAssociatedContactSources: any non-ours contact means a real external actor was involved', () => {
  assert.deepEqual(classifyAssociatedContactSources(['AI-SDR-App', 'Apollo Integration']), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
  assert.deepEqual(classifyAssociatedContactSources(['Apollo Integration']), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
});

test('classifyAssociatedContactSources: no associated contacts at all is treated conservatively as a gap', () => {
  assert.deepEqual(classifyAssociatedContactSources([]), { bucket: 'gap', reason: 'resolved-to-pre-existing' });
});

// ─── isNotFoundError ──────────────────────────────────────────────────────
test('isNotFoundError: recognizes axios\'s default 404 message', () => {
  assert.equal(isNotFoundError({ message: 'Request failed with status code 404' }), true);
});

test('isNotFoundError: does not misclassify other status codes or messages', () => {
  assert.equal(isNotFoundError({ message: 'Request failed with status code 500' }), false);
  assert.equal(isNotFoundError({ message: 'timeout of 15000ms exceeded' }), false);
});

// ─── classifyLookupResult ────────────────────────────────────────────────
test('classifyLookupResult: null means not in HubSpot', () => {
  assert.deepEqual(classifyLookupResult(null), { bucket: 'clean' });
});

test('classifyLookupResult: ambiguous match is flagged for manual review, not guessed', () => {
  assert.deepEqual(classifyLookupResult({ ambiguous: true, count: 3 }), { bucket: 'ambiguous', count: 3 });
});

test('classifyLookupResult: a clean single match is a gap', () => {
  assert.deepEqual(
    classifyLookupResult({ id: 'hs789', matchedOn: 'email' }),
    { bucket: 'gap', reason: 'found-live', hubspotId: 'hs789', matchedOn: 'email' }
  );
});

// ─── predatesWolf ─────────────────────────────────────────────────────────
// Policy: a company found live in HubSpot is only a genuine WOLF gap if it
// showed up in HubSpot *because of* (or after) WOLF sourcing it. If the
// HubSpot record already existed before Prospector ever pulled the company,
// it was a pre-existing CRM record, not a WOLF find — exclude it.
test('predatesWolf: HubSpot record created before Prospector pulled it → predates', () => {
  assert.equal(predatesWolf('2026-01-01T00:00:00.000Z', '2026-08-12T11:40:27.647Z'), true);
});

test('predatesWolf: HubSpot record created after Prospector pulled it → does not predate', () => {
  assert.equal(predatesWolf('2026-08-12T11:45:36.333Z', '2026-08-12T11:40:27.647Z'), false);
});

test('predatesWolf: unparseable/missing dates → unknown (null), not guessed', () => {
  assert.equal(predatesWolf(undefined, '2026-08-12T11:40:27.647Z'), null);
  assert.equal(predatesWolf('2026-08-12T11:45:36.333Z', undefined), null);
  assert.equal(predatesWolf('not-a-date', '2026-08-12T11:40:27.647Z'), null);
});
