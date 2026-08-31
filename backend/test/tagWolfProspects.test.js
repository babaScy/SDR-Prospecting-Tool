const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCsv } = require('../scripts/tagWolfProspects');

const tmpFiles = [];
function writeTmpCsv(content) {
  const file = path.join(os.tmpdir(), `tagWolfProspects-test-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(file, content);
  tmpFiles.push(file);
  return file;
}

after(() => {
  for (const file of tmpFiles) fs.rmSync(file, { force: true });
});

test('parseCsv: parses plain rows into header-keyed objects', () => {
  const file = writeTmpCsv('Company,Domain,HubSpot Company ID\nAcme,acme.com,123\n');
  assert.deepEqual(parseCsv(file), [{ Company: 'Acme', Domain: 'acme.com', 'HubSpot Company ID': '123' }]);
});

test('parseCsv: unquotes a comma-containing field written by hubspotGapReport.js writeCsv()', () => {
  const file = writeTmpCsv('Company,Domain\n"Acme, Inc.",acme.com\n');
  assert.deepEqual(parseCsv(file), [{ Company: 'Acme, Inc.', Domain: 'acme.com' }]);
});

test('parseCsv: unescapes a doubled quote inside a quoted field', () => {
  const file = writeTmpCsv('Company,Domain\n"Say ""Hi"" Inc.",acme.com\n');
  assert.deepEqual(parseCsv(file), [{ Company: 'Say "Hi" Inc.', Domain: 'acme.com' }]);
});

test('parseCsv: handles multiple rows', () => {
  const file = writeTmpCsv('Company,Domain\nAcme,acme.com\nBeta,beta.com\n');
  assert.deepEqual(parseCsv(file), [
    { Company: 'Acme', Domain: 'acme.com' },
    { Company: 'Beta', Domain: 'beta.com' },
  ]);
});
