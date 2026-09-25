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
 * The predates-WOLF check (see hubspotGapReport.js's classifyGapByDate) is a
 * COMPANY-level decision only. If company-pre-existing.csv is present
 * (companies that predate WOLF sourcing them), this sets wolf_prospect=false
 * on those, correcting any that were previously mis-tagged. If
 * contact-pre-existing.csv is present (contacts on those pre-existing
 * companies), same correction. Once a company IS confirmed WOLF, though,
 * every contact on it is WOLF too — no individual date check — see
 * contact-gaps.csv's policy note in hubspotGapReport.js for why.
 *
 * Also chains in checkCompanyContactCoverage.js's check (unless
 * --contacts-only) against the same company-gaps.csv: a contact who belongs
 * to a WOLF company but was never sourced through Prospector's own Contact
 * collection (contact sourcing never ran, or HubSpot's own automation added
 * one later) is invisible to hubspotGapReport.js's contact-level check,
 * which only ever looks at contacts Prospector's Mongo already knows about.
 * Same policy: it belongs to a WOLF company, so it's tagged true — no date
 * check on the contact itself.
 *
 * WRITES to HubSpot: creates one property definition per object type (only
 * if missing) and batch-updates wolf_prospect on each record in the CSVs
 * (true for gaps, false for pre-existing), plus whatever
 * checkCompanyContactCoverage.js's findCoverageGaps() turns up on those same
 * companies. Touches no other property, and creates/deletes/associates
 * nothing.
 *
 * Usage: node scripts/tagWolfProspects.js <gapReportDir>
 *   <gapReportDir> must contain company-gaps.csv and contact-gaps.csv, as
 *   written by `node scripts/hubspotGapReport.js --csv <gapReportDir>`.
 *   company-pre-existing.csv is optional.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const hubspotService = require('../src/services/hubspotService');
const { findCoverageGaps } = require('./checkCompanyContactCoverage');
const { parseCsv } = require('./csvParse');

const PROPERTY_NAME = 'wolf_prospect';
const PROPERTY_LABEL = 'WOLF Prospect';
const GROUP_NAME = { companies: 'companyinformation', contacts: 'contactinformation' };
const ID_COLUMN = { companies: 'HubSpot Company ID', contacts: 'HubSpot Contact ID' };

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

  // Same correction for contacts on those pre-existing companies — a contact
  // whose own HubSpot createdate predates the company's Prospector pull is
  // just as much "not WOLF's" as the company itself (see classifyGapByDate).
  const contactPreExistingPath = path.join(dir, 'contact-pre-existing.csv');
  if (fs.existsSync(contactPreExistingPath)) {
    const contactPreExisting = parseCsv(contactPreExistingPath);
    if (contactPreExisting.length) {
      console.log(`\nCorrecting ${contactPreExisting.length} contacts that predate WOLF sourcing their company (unsetting "${PROPERTY_LABEL}")...`);
      await batchSetProperty('contacts', contactPreExisting.map((c) => c[ID_COLUMN.contacts]), 'false');
    }
  }

  // Any contact belonging to one of these WOLF companies gets tagged too,
  // whether or not Prospector's own Contact collection knows about it — see
  // checkCompanyContactCoverage.js. Needs its own Mongo connection (domain
  // matching against Company docs); tagWolfProspects.js otherwise has none.
  console.log(`\nChecking contact coverage on these ${companies.length} companies for contacts invisible to Prospector's own Mongo...`);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });
  const coverage = await findCoverageGaps(companies);
  await mongoose.disconnect();
  console.log(
    `Coverage check: ${coverage.newGaps.length} new contact gaps (tag-eligible — belongs to a WOLF company), ` +
      `${coverage.errors.length} errors (skipped)`
  );
  if (coverage.newGaps.length) {
    await batchSetProperty('contacts', coverage.newGaps.map((g) => g.hubspotContactId), 'true');
  }

  console.log('\nDone.');
}

module.exports = { parseCsv };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
