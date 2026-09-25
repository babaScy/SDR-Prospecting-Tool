#!/usr/bin/env node
/**
 * Read-only follow-up to hubspotGapReport.js: for every company that IS a
 * WOLF Prospect (wolf_prospect=true in HubSpot), are all of ITS associated
 * HubSpot contacts also properly attributed to WOLF?
 *
 * This catches a blind spot hubspotGapReport.js's own contact-level check
 * can't see: that check only ever evaluates contacts Prospector's own
 * Contact collection already knows about (sourced via the app's people
 * search). A contact who exists in HubSpot under a WOLF company, but whom
 * Prospector never sourced at all (e.g. because contact sourcing never ran —
 * see Blindspot / Tijl Van Mierlo), is invisible to that check. This script
 * instead walks HubSpot's own company→contact associations directly, so it
 * finds those "invisible" contacts too.
 *
 * Policy (explicit, per product decision — a contact does NOT get its own
 * predates-WOLF check): once a company is confirmed WOLF (that's what being
 * in company-gaps.csv already means — see hubspotGapReport.js), every
 * contact on it is WOLF too, regardless of that contact's own HubSpot
 * history. A contact is only left alone if it's already fine on its own
 * terms — hs_object_source_detail_1 === 'AI-SDR-App' (Prospector's own push
 * created it) or wolf_prospect === 'true' already — otherwise it's a gap,
 * full stop, no date comparison.
 *
 * Usage:
 *   node scripts/checkCompanyContactCoverage.js <company-gaps.csv> [--csv <outDir>]
 *   <company-gaps.csv> is the file written by hubspotGapReport.js --csv.
 *
 * READ-ONLY against both Mongo and HubSpot. Writes nothing.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const hubspotService = require('../src/services/hubspotService');
const { parseCsv } = require('./csvParse');
const { classifySourceDetail } = require('./hubspotGapReport');

function normalizeDomain(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(filePath, rows, columns) {
  const lines = [columns.map((c) => csvEscape(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c.key])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

// Core check, reusable by other scripts (e.g. tagWolfProspects.js chains
// this in automatically so tagging a run's gaps also catches contacts that
// are invisible to Mongo). Requires an open mongoose connection — callers own
// connect/disconnect since they may be doing other Mongo work in the same
// process. companyRows is the parsed contents of a company-gaps.csv (or
// anything with the same Company/Domain/HubSpot Company ID columns).
async function findCoverageGaps(companyRows) {
  const byDomain = new Map();
  for (const c of await Company.find({ sdrStatus: 'accepted' }).select('website createdAt companyName').lean()) {
    const d = normalizeDomain(c.website);
    if (d) byDomain.set(d, c);
  }

  const alreadyFine = [];
  const newGaps = [];
  const errors = [];
  let noAssociations = 0;
  let noProspectorMatch = 0;

  for (const row of companyRows) {
    const hubspotCompanyId = row['HubSpot Company ID'];
    const domain = normalizeDomain(row.Domain);
    const prospectorCompany = byDomain.get(domain);
    if (!prospectorCompany) {
      noProspectorMatch++;
      continue;
    }
    try {
      const assoc = await hubspotService.hsRequest('get', `/crm/v4/objects/companies/${hubspotCompanyId}/associations/contacts`);
      const contactIds = assoc.data.results.map((a) => a.toObjectId);
      if (!contactIds.length) {
        noAssociations++;
        continue;
      }
      for (const contactId of contactIds) {
        const rec = await hubspotService.hsRequest(
          'get',
          `/crm/v3/objects/contacts/${contactId}?properties=hs_object_source_detail_1,wolf_prospect,firstname,lastname,email`
        );
        const p = rec.data.properties;
        const label = `${row.Company} — ${p.firstname || ''} ${p.lastname || ''}`.trim();
        const sourceClass = classifySourceDetail(p.hs_object_source_detail_1);
        const entry = { contact: label, email: p.email || '', company: row.Company, hubspotContactId: contactId };
        if (sourceClass.bucket === 'known' || p.wolf_prospect === 'true') alreadyFine.push(entry);
        else newGaps.push(entry); // belongs to a WOLF company → WOLF too, no date check
      }
    } catch (err) {
      errors.push({ company: row.Company, hubspotCompanyId, error: err.message });
    }
  }

  return { alreadyFine, newGaps, errors, noAssociations, noProspectorMatch };
}

async function main() {
  const csvFlagIndex = process.argv.indexOf('--csv');
  const csvOutDir = csvFlagIndex !== -1 ? process.argv[csvFlagIndex + 1] : null;
  const companyGapsPath = process.argv.find((a, i) => i >= 2 && !a.startsWith('--') && a !== csvOutDir);
  if (!companyGapsPath) {
    console.error('Usage: node scripts/checkCompanyContactCoverage.js <company-gaps.csv> [--csv <outDir>]');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const companies = parseCsv(companyGapsPath);
  const { alreadyFine, newGaps, errors, noAssociations, noProspectorMatch } = await findCoverageGaps(companies);

  console.log(`\n=== Contact coverage check — ${companies.length} WOLF companies ===`);
  console.log(`${noProspectorMatch} skipped — no matching Prospector company by domain, ${noAssociations} have no associated HubSpot contacts at all\n`);

  console.log(`=== NEW CONTACT GAPS (invisible to hubspotGapReport.js — tag-eligible): ${newGaps.length} ===`);
  newGaps.forEach((g) => console.log(`  ${g.contact} <${g.email}> [${g.hubspotContactId}]`));

  console.log(`\n(${alreadyFine.length} already fine — created by Prospector's push or already tagged)`);

  if (errors.length) {
    console.log(`\n=== ERRORS: ${errors.length} ===`);
    errors.forEach((e) => console.log(`  ${e.company} [${e.hubspotCompanyId}]: ${e.error}`));
  }

  if (csvOutDir) {
    fs.mkdirSync(csvOutDir, { recursive: true });
    const columns = [
      { key: 'contact', header: 'Contact' },
      { key: 'email', header: 'Email' },
      { key: 'company', header: 'Company' },
      { key: 'hubspotContactId', header: 'HubSpot Contact ID' },
    ];
    writeCsv(path.join(csvOutDir, 'contact-coverage-gaps.csv'), newGaps, columns);
    console.log(`\nCSVs written to ${csvOutDir}: contact-coverage-gaps.csv (${newGaps.length})`);
  }

  await mongoose.disconnect();
}

module.exports = { findCoverageGaps, normalizeDomain };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
