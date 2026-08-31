#!/usr/bin/env node
/**
 * Creates a "WOLF Prospect" checkbox property on HubSpot Companies and
 * Contacts (if not already present), then sets it to Yes on every record in
 * a hubspotGapReport.js CSV export — so these "in HubSpot but not pushed via
 * Prospector" records are filterable/reportable in HubSpot, given that
 * HubSpot's own "Record source detail" fields are read-only and can't be
 * changed after the fact (see hubspotGapReport.js for how the gap lists were
 * built).
 *
 * If company-pre-existing.csv is also present in the directory (companies
 * hubspotGapReport.js found predate WOLF sourcing them — see predatesWolf),
 * this also sets wolf_prospect=false on those, correcting any that were
 * previously mis-tagged by an older run that didn't check dates.
 *
 * WRITES to HubSpot: creates one property definition per object type (only
 * if missing) and batch-updates wolf_prospect on each record in the CSVs
 * (true for gaps, false for pre-existing). Touches no other property, and
 * creates/deletes/associates nothing.
 *
 * Usage: node scripts/tagWolfProspects.js <gapReportDir>
 *   <gapReportDir> must contain company-gaps.csv and contact-gaps.csv, as
 *   written by `node scripts/hubspotGapReport.js --csv <gapReportDir>`.
 *   company-pre-existing.csv is optional.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const hubspotService = require('../src/services/hubspotService');

const PROPERTY_NAME = 'wolf_prospect';
const PROPERTY_LABEL = 'WOLF Prospect';
const GROUP_NAME = { companies: 'companyinformation', contacts: 'contactinformation' };
const ID_COLUMN = { companies: 'HubSpot Company ID', contacts: 'HubSpot Contact ID' };

// Minimal CSV parser — only needs to round-trip what writeCsv() in
// hubspotGapReport.js produces (comma-separated, "-quoted when a field has a
// comma/quote/newline, "" for an escaped quote).
function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const parseLine = (line) => {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  };
  const [headerLine, ...lines] = text.split('\n');
  const headers = parseLine(headerLine);
  return lines.map((line) => Object.fromEntries(headers.map((h, i) => [h, parseLine(line)[i]])));
}

async function ensureProperty(objectType) {
  const existing = await hubspotService.hsRequest('get', `/crm/v3/properties/${objectType}`);
  if (existing.data.results.some((p) => p.name === PROPERTY_NAME)) {
    console.log(`[${objectType}] "${PROPERTY_LABEL}" property already exists — skipping create`);
    return;
  }
  await hubspotService.hsRequest('post', `/crm/v3/properties/${objectType}`, {
    name: PROPERTY_NAME,
    label: PROPERTY_LABEL,
    type: 'bool',
    fieldType: 'booleancheckbox',
    groupName: GROUP_NAME[objectType],
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  });
  console.log(`[${objectType}] created "${PROPERTY_LABEL}" property in group "${GROUP_NAME[objectType]}"`);
}

async function batchSetProperty(objectType, ids, value) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await hubspotService.hsRequest('post', `/crm/v3/objects/${objectType}/batch/update`, {
      inputs: chunk.map((id) => ({ id, properties: { [PROPERTY_NAME]: value } })),
    });
    console.log(`[${objectType}] set ${PROPERTY_NAME}=${value} on ${Math.min(i + 100, ids.length)}/${ids.length}`);
  }
}

async function main() {
  const dir = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  const contactsOnly = process.argv.includes('--contacts-only');
  if (!dir) {
    console.error('Usage: node scripts/tagWolfProspects.js [--contacts-only] <gapReportDir>');
    process.exitCode = 1;
    return;
  }

  await ensureProperty('contacts');
  if (!contactsOnly) await ensureProperty('companies');

  const contacts = parseCsv(path.join(dir, 'contact-gaps.csv'));
  if (contactsOnly) {
    console.log(`\nTagging ${contacts.length} contacts as "${PROPERTY_LABEL}" (companies skipped — --contacts-only)...`);
    await batchSetProperty('contacts', contacts.map((c) => c[ID_COLUMN.contacts]), 'true');
    console.log('\nDone.');
    return;
  }

  const companies = parseCsv(path.join(dir, 'company-gaps.csv'));
  console.log(`\nTagging ${companies.length} companies and ${contacts.length} contacts as "${PROPERTY_LABEL}"...`);

  await batchSetProperty('companies', companies.map((c) => c[ID_COLUMN.companies]), 'true');
  await batchSetProperty('contacts', contacts.map((c) => c[ID_COLUMN.contacts]), 'true');

  const preExistingPath = path.join(dir, 'company-pre-existing.csv');
  if (fs.existsSync(preExistingPath)) {
    const preExisting = parseCsv(preExistingPath);
    if (preExisting.length) {
      console.log(`\nCorrecting ${preExisting.length} companies that predate WOLF sourcing them (unsetting "${PROPERTY_LABEL}")...`);
      await batchSetProperty('companies', preExisting.map((c) => c[ID_COLUMN.companies]), 'false');
    }
  }

  console.log('\nDone.');
}

module.exports = { parseCsv };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
