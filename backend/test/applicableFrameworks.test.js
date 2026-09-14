const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applicableFrameworks } = require('../src/util/applicableFrameworks');

test('returns at most 4 frameworks', () => {
  const lead = {
    industry: 'Hospital & Health Care',
    country: 'Germany',
    keywords: ['payments', 'automotive', 'defense contractor'],
    qualification: { productDescription: 'AI platform for medical devices', complianceLanguage: 'California residents, GDPR' },
  };
  const result = applicableFrameworks(lead);
  assert.ok(result.length <= 4);
});

test('healthcare company gets HIPAA, not ISO 13485, when it is not a medical-device maker', () => {
  const lead = {
    industry: 'Hospital & Health Care',
    country: 'United States',
    qualification: { productDescription: 'Patient scheduling software for clinics and hospitals' },
  };
  const result = applicableFrameworks(lead);
  assert.ok(result.includes('HIPAA'));
  assert.ok(!result.includes('ISO 13485'));
});

test('medical device maker gets ISO 13485 ahead of generic HIPAA', () => {
  const lead = {
    industry: 'Medical Devices',
    country: 'United States',
    qualification: { productDescription: 'FDA-cleared medical device for cardiac monitoring' },
  };
  const result = applicableFrameworks(lead);
  assert.equal(result[0], 'ISO 13485');
});

test('payments company gets PCI DSS', () => {
  const lead = {
    industry: 'Financial Services',
    country: 'United States',
    qualification: { productDescription: 'Checkout and payment processing for online merchants' },
  };
  const result = applicableFrameworks(lead);
  assert.ok(result.includes('PCI DSS'));
});

test('EU-based company gets GDPR', () => {
  const lead = {
    industry: 'Software',
    country: 'Netherlands',
    qualification: { productDescription: 'Generic B2B SaaS tool' },
  };
  const result = applicableFrameworks(lead);
  assert.ok(result.includes('GDPR'));
});

test('mention of California / CCPA in free text is picked up regardless of country', () => {
  const lead = {
    industry: 'Software',
    country: 'United States',
    qualification: { complianceLanguage: 'Complies with California privacy law for consumers' },
  };
  const result = applicableFrameworks(lead);
  assert.ok(result.includes('CCPA'));
});

test('generic US B2B SaaS company with no strong signals falls back to SOC 2 and ISO 27001', () => {
  const lead = {
    industry: 'Computer Software',
    country: 'United States',
    qualification: { isB2B: 'Yes', isSaaS: 'Yes', productDescription: 'Project management tool for remote teams' },
  };
  const result = applicableFrameworks(lead);
  assert.deepEqual(result, ['SOC 2', 'ISO 27001']);
});

test('never suggests a Half Framework', () => {
  const HALF_FRAMEWORKS = ['ISO 27017', 'ISO 27018', 'ISO 27701', 'ISO 27799', 'ISO 27032'];
  const leads = [
    { industry: 'Hospital & Health Care', country: 'Germany', qualification: { productDescription: 'cloud health records PII in the cloud' } },
    { industry: 'Computer Software', country: 'United States', qualification: {} },
  ];
  for (const lead of leads) {
    const result = applicableFrameworks(lead);
    assert.ok(result.every((f) => !HALF_FRAMEWORKS.includes(f)));
  }
});

test('handles missing/sparse fields without throwing', () => {
  assert.deepEqual(applicableFrameworks({}), ['SOC 2', 'ISO 27001']);
  assert.deepEqual(applicableFrameworks({ qualification: null }), ['SOC 2', 'ISO 27001']);
});

test('disqualified companies get no framework suggestions, regardless of signals', () => {
  const lead = {
    status: 'disqualified',
    industry: 'Hospital & Health Care',
    country: 'Germany',
    qualification: { productDescription: 'Checkout and payment processing for hospitals' },
  };
  assert.deepEqual(applicableFrameworks(lead), []);
});

test('non-disqualified statuses (qualified, nei, pending) still get suggestions', () => {
  for (const status of ['qualified', 'nei', 'pending', undefined]) {
    const lead = { status, industry: 'Hospital & Health Care', country: 'United States' };
    assert.ok(applicableFrameworks(lead).includes('HIPAA'), `expected HIPAA for status ${status}`);
  }
});
