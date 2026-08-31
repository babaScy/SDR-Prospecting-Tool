#!/usr/bin/env node
/**
 * Read-only audit: which accepted companies/contacts are actually sitting in
 * HubSpot (checked live) despite never being pushed through the app's own
 * HubSpot button — i.e. sourced in Prospector ("the wolf") then added to
 * HubSpot some other way (Apollo export, manual entry, ...).
 *
 * Scope: Company.sdrStatus === 'accepted' only — rejected/pending companies
 * were never meant to reach HubSpot, so their HubSpot presence (if any)
 * isn't a gap worth reporting.
 *
 * Policy: a company found live in HubSpot only counts as a genuine WOLF gap
 * (tag-eligible) if it appeared in HubSpot at or after the moment Prospector
 * pulled it (see predatesWolf). If the HubSpot record predates that pull, it
 * was already a real CRM company before WOLF ever touched it — filed under
 * companyPreExisting instead, and never tagged. A createdate that can't be
 * compared goes to companyDateUnknown for manual review.
 *
 * For each accepted company:
 *   - contactStatus 'pending'/'sourcing' → contact sourcing isn't done yet
 *     (no Contact docs to check below, tracked via stillSourcing), but the
 *     company itself can still independently exist in HubSpot (e.g. via
 *     HubSpot's own Apollo integration) — so it still gets the full
 *     company-level check below, same as any other accepted company.
 *   - company-level: hubspotCompanyId set → NOT automatically "known". Our
 *     own resolveOrCreateCompany() searches HubSpot by domain first and just
 *     reuses/associates to a match if one exists — it only creates a company
 *     when nothing was found. So hubspotCompanyId being set only proves we
 *     resolved to *some* HubSpot company, not that we created it. We verify
 *     by reading that record's own hs_object_source_detail_1: 'AI-SDR-App'
 *     means our push created it (clean); '"Create and associate companies
 *     with contacts" setting' is HubSpot's own automation that can fire off
 *     a contact WE pushed just as easily as an external one, so that case
 *     gets one more check — the company's associated contacts — and only
 *     counts as a gap if not every one of them is ours; anything else means
 *     we found and reused a pre-existing company (a gap). No hubspotCompanyId
 *     + no website → not checkable. No hubspotCompanyId + a website → live
 *     domain lookup.
 *   - contactStatus 'found': each Contact checked individually — 'synced' →
 *     clean (contacts are only ever created by our push, never reused — see
 *     pushContact, so this one has no analogous company-style ambiguity);
 *     'already_existed' → a historical record from whenever the SDR clicked
 *     push, re-verified live (HubSpot's own match may since have been
 *     deleted) before counting it as a current gap; 'none'/'failed' with no
 *     email or LinkedIn → not checkable; otherwise → live lookup.
 *
 * IMPORTANT: this script is READ-ONLY against HubSpot. It only calls
 * hubspotService's search lookups (findCompanyByDomain,
 * findContactByEmailOrLinkedIn), plain GETs on individual company/contact
 * records (to check hs_object_source_detail_1 and confirm a record still
 * exists), GETs on a company's contact associations, and the account-info
 * endpoint (to build clickable record links) — all read-only. It never
 * creates, updates, or associates anything in HubSpot, and never writes
 * back to Mongo.
 *
 * Usage:
 *   node scripts/hubspotGapReport.js                     # console report only
 *   node scripts/hubspotGapReport.js --csv <outDir>       # also write CSVs there
 *   node scripts/hubspotGapReport.js --contacts-only ...  # skip company-level checks entirely
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const List = require('../src/models/List');
const hubspotService = require('../src/services/hubspotService');

// ─── Pure classification (unit-tested in test/hubspotGapReport.test.js) ──────
// No I/O in here — these just decide what to do with a record already in
// hand, or a lookup result already returned. Keeping them pure is what makes
// them testable without a live Mongo/HubSpot connection.

// What to do with one Contact record, before any live lookup.
function classifyContactRecord(contact) {
  if (contact.hubspotStatus === 'synced') return { bucket: 'synced' };
  if (contact.hubspotStatus === 'already_existed') {
    return { bucket: 'gap', reason: 'already_existed', hubspotContactId: contact.hubspotContactId };
  }
  if (!contact.email && !contact.linkedinUrl) return { bucket: 'not-checkable' };
  return { bucket: 'needs-check' };
}

// What to do with one Company record, before any live lookup. A real
// (non-PENDING) hubspotCompanyId only proves we RESOLVED to some HubSpot
// company, not that we created it — resolveOrCreateCompany() reuses a
// domain match if one already existed. So 'has-id' still needs a source
// check, it just skips the domain search since we already know the id.
function classifyCompanyRecord(company) {
  if (company.hubspotCompanyId && company.hubspotCompanyId !== 'PENDING') return { bucket: 'has-id' };
  if (!company.website) return { bucket: 'not-checkable' };
  return { bucket: 'needs-domain-search' };
}

// AI-SDR-App is the hs_object_source_detail_1 value HubSpot stamps on
// records this app's own integration actually creates. Anything else means
// the company predates our push and we just resolved/reused it — EXCEPT one
// case: HubSpot's own "Create and associate companies with contacts"
// workspace setting auto-creates a company the moment ANY contact with a
// matching domain is created, including a contact WE just pushed. So that
// specific source needs one more check (classifyAssociatedContactSources)
// before it's trusted as a real gap.
const CREATED_BY_APP_SOURCE = 'AI-SDR-App';
const AUTO_ASSOCIATE_SOURCE = '"Create and associate companies with contacts" setting';
function classifySourceDetail(sourceDetail) {
  if (sourceDetail === CREATED_BY_APP_SOURCE) return { bucket: 'known' };
  return { bucket: 'gap', reason: 'resolved-to-pre-existing' };
}
function isAutoAssociateSource(sourceDetail) {
  return sourceDetail === AUTO_ASSOCIATE_SOURCE;
}
// Given the hs_object_source_detail_1 of every contact associated with an
// auto-associated company: if literally every one of them is ours, the
// company was purely a side effect of our own push, not an external add.
function classifyAssociatedContactSources(sources) {
  if (sources.length && sources.every((s) => s === CREATED_BY_APP_SOURCE)) return { bucket: 'known' };
  return { bucket: 'gap', reason: 'resolved-to-pre-existing' };
}

// axios's default error message is "Request failed with status code NNN" —
// hsRequest discards the actual status code when it wraps errors, so this is
// the only reliable way left to tell "genuinely gone" apart from a real
// failure worth retrying.
function isNotFoundError(err) {
  return /status code 404/.test(err.message);
}

// Interpret a hubspotService findXByY() result (used for both companies and
// contacts — both return null | { ambiguous, count } | { id, matchedOn? }).
function classifyLookupResult(hit) {
  if (!hit) return { bucket: 'clean' };
  if (hit.ambiguous) return { bucket: 'ambiguous', count: hit.count };
  return { bucket: 'gap', reason: 'found-live', hubspotId: hit.id, matchedOn: hit.matchedOn };
}

// Policy: a company found live in HubSpot only counts as a genuine WOLF gap
// (and gets wolf_prospect tagged) if it showed up in HubSpot at or after the
// moment Prospector pulled it. If the HubSpot record predates that pull, it
// was already a real CRM company before WOLF ever touched it — not a WOLF
// find — so it's excluded rather than tagged. Returns null (not a guess)
// when either date can't be parsed, so the caller can route it to manual
// review instead of silently deciding either way.
function predatesWolf(hubspotCreatedAt, prospectorCreatedAt) {
  const hs = new Date(hubspotCreatedAt).getTime();
  const pros = new Date(prospectorCreatedAt).getTime();
  if (Number.isNaN(hs) || Number.isNaN(pros)) return null;
  return hs < pros;
}

module.exports = {
  classifyContactRecord,
  classifyCompanyRecord,
  classifySourceDetail,
  isAutoAssociateSource,
  classifyAssociatedContactSources,
  isNotFoundError,
  classifyLookupResult,
  predatesWolf,
};

// ─── CSV export (optional, only when --csv <outDir> is passed) ──────────────
function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.map((c) => csvEscape(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c.key])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

const companyRecordUrl = (portalId, id) => `https://app.hubspot.com/contacts/${portalId}/record/0-2/${id}`;
const contactRecordUrl = (portalId, id) => `https://app.hubspot.com/contacts/${portalId}/record/0-1/${id}`;
const companySearchUrl = (portalId, domain) =>
  `https://app.hubspot.com/contacts/${portalId}/objects/0-2/views/all/list?query=${encodeURIComponent(hubspotService.normalizeDomain(domain) || '')}`;

// ─── Report printing ──────────────────────────────────────────────────────
function printTable(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.header)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  rows.forEach((r) => console.log(line(columns.map((c) => r[c.key] ?? ''))));
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const csvFlagIndex = process.argv.indexOf('--csv');
  const csvOutDir = csvFlagIndex !== -1 ? process.argv[csvFlagIndex + 1] : null;
  const contactsOnly = process.argv.includes('--contacts-only');
  if (csvFlagIndex !== -1 && !csvOutDir) {
    console.error('Usage: node scripts/hubspotGapReport.js [--contacts-only] --csv <outDir>');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const lists = await List.find({}).select('assignedTo').lean();
  const sdrByListId = new Map(lists.map((l) => [l._id.toString(), l.assignedTo]));

  const companies = await Company.find({ sdrStatus: 'accepted' }).lean();

  const r = {
    stillSourcing: 0,
    companyGaps: [],
    companyPreExisting: [], // found live in HubSpot, but predates WOLF sourcing it — not tagged
    companyDateUnknown: [], // found live, but a createdate couldn't be compared — needs manual review
    companyAmbiguous: [],
    companyErrors: [],
    companyClean: 0,
    companyNotCheckable: 0,
    companyVerifiedWolf: 0,
    contactGaps: [],
    contactAmbiguous: [],
    contactErrors: [],
    contactSynced: 0,
    contactClean: 0,
    contactNotCheckable: 0,
    contactStale: 0,
  };

  // Given a confirmed company-level HubSpot match, decide whether it's a
  // genuine WOLF gap (tag-eligible) or predates WOLF sourcing it (excluded
  // per policy — see predatesWolf) and file it into the right result bucket.
  function fileCompanyGap({ company, hubspotCompanyId, reason, sdr, hubspotCreatedAt }) {
    const entry = { company: company.companyName, domain: company.website, reason, hubspotCompanyId, sdr };
    const predates = predatesWolf(hubspotCreatedAt, company.createdAt);
    if (predates === true) r.companyPreExisting.push(entry);
    else if (predates === false) r.companyGaps.push(entry);
    else r.companyDateUnknown.push(entry);
  }

  for (const company of companies) {
    // Contact sourcing not done yet — no Contact docs to check below — but
    // the company itself can still independently exist in HubSpot (e.g. via
    // HubSpot's own Apollo integration), so it still needs the company-level
    // check. stillSourcing is tracked for visibility only, it no longer
    // skips the company-level check.
    if (company.contactStatus === 'pending' || company.contactStatus === 'sourcing') {
      r.stillSourcing++;
    }
    const sdr = sdrByListId.get(company.listId?.toString()) || 'unknown';

    // ── Company-level: is the company itself in HubSpot? ── (skipped entirely with --contacts-only)
    const companyClass = contactsOnly ? null : classifyCompanyRecord(company);
    if (contactsOnly) {
      // no-op — company-level checks intentionally skipped
    } else if (companyClass.bucket === 'not-checkable') {
      r.companyNotCheckable++;
    } else if (companyClass.bucket === 'needs-domain-search') {
      try {
        const hit = await hubspotService.findCompanyByDomain(company.website);
        const outcome = classifyLookupResult(hit);
        if (outcome.bucket === 'gap') {
          // findCompanyByDomain only returns the id — fetch the record's own
          // createdAt so fileCompanyGap can check it against WOLF's pull time.
          const rec = await hubspotService.hsRequest('get', `/crm/v3/objects/companies/${outcome.hubspotId}`);
          fileCompanyGap({ company, hubspotCompanyId: outcome.hubspotId, reason: 'found-live', sdr, hubspotCreatedAt: rec.data.createdAt });
        } else if (outcome.bucket === 'ambiguous') {
          r.companyAmbiguous.push({ company: company.companyName, domain: company.website, matches: outcome.count });
        } else {
          r.companyClean++;
        }
      } catch (err) {
        r.companyErrors.push({ company: company.companyName, domain: company.website, error: err.message });
      }
    } else {
      // 'has-id' — a hubspotCompanyId doesn't prove we CREATED the company
      // (resolveOrCreateCompany reuses a pre-existing domain match rather
      // than always creating), so confirm via that record's own source. This
      // GET also transparently resolves a merged-away id to the surviving
      // record (unlike the batch endpoints, which just drop it) — always use
      // the id it returns from here on, not the one stored in Mongo.
      try {
        const rec = await hubspotService.hsRequest('get', `/crm/v3/objects/companies/${company.hubspotCompanyId}?properties=hs_object_source_detail_1`);
        const survivingId = rec.data.id;
        const sourceDetail = rec.data.properties.hs_object_source_detail_1;
        let outcome = classifySourceDetail(sourceDetail);
        if (outcome.bucket === 'gap' && isAutoAssociateSource(sourceDetail)) {
          const assoc = await hubspotService.hsRequest('get', `/crm/v4/objects/companies/${survivingId}/associations/contacts`);
          const contactIds = assoc.data.results.map((a) => a.toObjectId);
          const sources = [];
          for (const cid of contactIds) {
            const c = await hubspotService.hsRequest('get', `/crm/v3/objects/contacts/${cid}?properties=hs_object_source_detail_1`);
            sources.push(c.data.properties.hs_object_source_detail_1);
          }
          outcome = classifyAssociatedContactSources(sources);
        }
        if (outcome.bucket === 'gap') {
          fileCompanyGap({ company, hubspotCompanyId: survivingId, reason: outcome.reason, sdr, hubspotCreatedAt: rec.data.createdAt });
        } else {
          r.companyVerifiedWolf++; // genuinely created by our own push — distinct from companyClean (not in HubSpot at all)
        }
      } catch (err) {
        r.companyErrors.push({ company: company.companyName, domain: company.website, error: err.message });
      }
    }

    // ── Contact-level: which of this company's contacts are in HubSpot? ──
    if (company.contactStatus !== 'found') continue;
    const contacts = await Contact.find({ companyId: company._id }).lean();
    for (const contact of contacts) {
      const label = `${company.companyName} — ${contact.firstName} ${contact.lastName}`;
      const contactClass = classifyContactRecord(contact);
      if (contactClass.bucket === 'synced') {
        r.contactSynced++;
      } else if (contactClass.bucket === 'gap') {
        // contactClass.hubspotContactId here is a historical record from
        // whenever the SDR clicked push — it may since have been deleted or
        // merged in HubSpot, so confirm it's still actually there before
        // trusting it as a current gap.
        try {
          await hubspotService.hsRequest('get', `/crm/v3/objects/contacts/${contactClass.hubspotContactId}`);
          r.contactGaps.push({ contact: label, email: contact.email || '', reason: contactClass.reason, hubspotContactId: contactClass.hubspotContactId, sdr });
        } catch (err) {
          if (isNotFoundError(err)) r.contactStale++;
          else r.contactErrors.push({ contact: label, error: err.message });
        }
      } else if (contactClass.bucket === 'not-checkable') {
        r.contactNotCheckable++;
      } else {
        try {
          const hit = await hubspotService.findContactByEmailOrLinkedIn(contact.email, contact.linkedinUrl);
          const outcome = classifyLookupResult(hit);
          if (outcome.bucket === 'gap') {
            r.contactGaps.push({ contact: label, email: contact.email || '', reason: `${outcome.reason} (${outcome.matchedOn})`, hubspotContactId: outcome.hubspotId, sdr });
          } else if (outcome.bucket === 'ambiguous') {
            r.contactAmbiguous.push({ contact: label, email: contact.email || '', matches: outcome.count });
          } else {
            r.contactClean++;
          }
        } catch (err) {
          r.contactErrors.push({ contact: label, error: err.message });
        }
      }
    }
  }

  console.log(`\n=== HubSpot gap report — ${companies.length} accepted companies (as of now)${contactsOnly ? ' — contacts only, company-level checks skipped' : ''} ===`);
  console.log(`${r.stillSourcing} still sourcing contacts (company-level checked anyway)\n`);

  if (!contactsOnly) {
    console.log(`=== COMPANY GAPS: ${r.companyGaps.length} in HubSpot, not pushed via Prospector — tag-eligible ===`);
    printTable(r.companyGaps, [
      { key: 'company', header: 'COMPANY' },
      { key: 'domain', header: 'DOMAIN' },
      { key: 'reason', header: 'REASON' },
      { key: 'hubspotCompanyId', header: 'HUBSPOT ID' },
    ]);
    console.log(`(${r.companyVerifiedWolf} verified genuinely created by Prospector, ${r.companyClean} clean / not in HubSpot, ${r.companyNotCheckable} not checkable — no domain)\n`);

    if (r.companyPreExisting.length) {
      console.log(`=== COMPANY PRE-EXISTING (found live, but predates WOLF sourcing it — NOT tagged): ${r.companyPreExisting.length} ===`);
      printTable(r.companyPreExisting, [
        { key: 'company', header: 'COMPANY' },
        { key: 'domain', header: 'DOMAIN' },
        { key: 'reason', header: 'REASON' },
        { key: 'hubspotCompanyId', header: 'HUBSPOT ID' },
      ]);
      console.log('');
    }

    if (r.companyDateUnknown.length) {
      console.log(`=== COMPANY DATE UNKNOWN (needs manual review — createdate couldn't be compared): ${r.companyDateUnknown.length} ===`);
      printTable(r.companyDateUnknown, [
        { key: 'company', header: 'COMPANY' },
        { key: 'domain', header: 'DOMAIN' },
        { key: 'reason', header: 'REASON' },
        { key: 'hubspotCompanyId', header: 'HUBSPOT ID' },
      ]);
      console.log('');
    }

    if (r.companyAmbiguous.length) {
      console.log(`=== COMPANY AMBIGUOUS (needs manual review): ${r.companyAmbiguous.length} ===`);
      printTable(r.companyAmbiguous, [
        { key: 'company', header: 'COMPANY' },
        { key: 'domain', header: 'DOMAIN' },
        { key: 'matches', header: 'MATCHES' },
      ]);
      console.log('');
    }

    if (r.companyErrors.length) {
      console.log(`=== COMPANY LOOKUP ERRORS (retry these — not counted as clean): ${r.companyErrors.length} ===`);
      printTable(r.companyErrors, [
        { key: 'company', header: 'COMPANY' },
        { key: 'domain', header: 'DOMAIN' },
        { key: 'error', header: 'ERROR' },
      ]);
      console.log('');
    }
  }

  console.log(`=== CONTACT GAPS: ${r.contactGaps.length} in HubSpot, not pushed via Prospector ===`);
  printTable(r.contactGaps, [
    { key: 'contact', header: 'CONTACT' },
    { key: 'email', header: 'EMAIL' },
    { key: 'reason', header: 'REASON' },
    { key: 'hubspotContactId', header: 'HUBSPOT ID' },
  ]);
  console.log(`(${r.contactSynced} already synced via Prospector, ${r.contactClean} clean / not in HubSpot, ${r.contactNotCheckable} not checkable — no email/LinkedIn, ${r.contactStale} stale — HubSpot recorded a match that's since been deleted)\n`);

  if (r.contactAmbiguous.length) {
    console.log(`=== CONTACT AMBIGUOUS (needs manual review): ${r.contactAmbiguous.length} ===`);
    printTable(r.contactAmbiguous, [
      { key: 'contact', header: 'CONTACT' },
      { key: 'email', header: 'EMAIL' },
      { key: 'matches', header: 'MATCHES' },
    ]);
    console.log('');
  }

  if (r.contactErrors.length) {
    console.log(`=== CONTACT LOOKUP ERRORS (retry these — not counted as clean): ${r.contactErrors.length} ===`);
    printTable(r.contactErrors, [
      { key: 'contact', header: 'CONTACT' },
      { key: 'error', header: 'ERROR' },
    ]);
    console.log('');
  }

  if (csvOutDir) {
    fs.mkdirSync(csvOutDir, { recursive: true });
    const account = await hubspotService.hsRequest('get', '/account-info/v3/details');
    const portalId = account.data.portalId;

    if (!contactsOnly) {
      writeCsv(
        path.join(csvOutDir, 'company-gaps.csv'),
        r.companyGaps.map((g) => ({ ...g, hubspotUrl: companyRecordUrl(portalId, g.hubspotCompanyId) })),
        [
          { key: 'company', header: 'Company' },
          { key: 'domain', header: 'Domain' },
          { key: 'reason', header: 'Reason' },
          { key: 'sdr', header: 'SDR' },
          { key: 'hubspotCompanyId', header: 'HubSpot Company ID' },
          { key: 'hubspotUrl', header: 'HubSpot Link' },
        ]
      );

      writeCsv(
        path.join(csvOutDir, 'company-ambiguous.csv'),
        r.companyAmbiguous.map((g) => ({ ...g, hubspotUrl: companySearchUrl(portalId, g.domain) })),
        [
          { key: 'company', header: 'Company' },
          { key: 'domain', header: 'Domain' },
          { key: 'matches', header: 'Matching HubSpot companies' },
          { key: 'hubspotUrl', header: 'HubSpot Search Link' },
        ]
      );

      const companyGapColumns = [
        { key: 'company', header: 'Company' },
        { key: 'domain', header: 'Domain' },
        { key: 'reason', header: 'Reason' },
        { key: 'sdr', header: 'SDR' },
        { key: 'hubspotCompanyId', header: 'HubSpot Company ID' },
        { key: 'hubspotUrl', header: 'HubSpot Link' },
      ];
      writeCsv(
        path.join(csvOutDir, 'company-pre-existing.csv'),
        r.companyPreExisting.map((g) => ({ ...g, hubspotUrl: companyRecordUrl(portalId, g.hubspotCompanyId) })),
        companyGapColumns
      );
      writeCsv(
        path.join(csvOutDir, 'company-date-unknown.csv'),
        r.companyDateUnknown.map((g) => ({ ...g, hubspotUrl: companyRecordUrl(portalId, g.hubspotCompanyId) })),
        companyGapColumns
      );
    }

    const contactGapColumns = [
      { key: 'contact', header: 'Contact' },
      { key: 'email', header: 'Email' },
      { key: 'reason', header: 'Reason' },
      { key: 'sdr', header: 'SDR' },
      { key: 'hubspotContactId', header: 'HubSpot Contact ID' },
      { key: 'hubspotUrl', header: 'HubSpot Link' },
    ];
    const contactGapsWithUrl = r.contactGaps.map((g) => ({ ...g, hubspotUrl: contactRecordUrl(portalId, g.hubspotContactId) }));
    writeCsv(path.join(csvOutDir, 'contact-gaps.csv'), contactGapsWithUrl, contactGapColumns);

    // One file per SDR, so each can be handed/emailed to just that person —
    // same columns minus SDR (redundant once the file is already theirs).
    const perSdrDir = path.join(csvOutDir, 'by-sdr');
    fs.mkdirSync(perSdrDir, { recursive: true });
    const bySdr = new Map();
    for (const row of contactGapsWithUrl) {
      if (!bySdr.has(row.sdr)) bySdr.set(row.sdr, []);
      bySdr.get(row.sdr).push(row);
    }
    const perSdrColumns = contactGapColumns.filter((c) => c.key !== 'sdr');
    for (const [sdr, rows] of bySdr) {
      const safeName = sdr.split('@')[0].replace(/[^a-z0-9_-]/gi, '_');
      writeCsv(path.join(perSdrDir, `${safeName}.csv`), rows, perSdrColumns);
    }
    console.log(`Per-SDR contact lists written to ${perSdrDir}/ (${bySdr.size} SDRs)`);

    console.log(
      contactsOnly
        ? `CSVs written to ${csvOutDir}: contact-gaps.csv (${r.contactGaps.length})`
        : `CSVs written to ${csvOutDir}: company-gaps.csv (${r.companyGaps.length}), company-ambiguous.csv (${r.companyAmbiguous.length}), contact-gaps.csv (${r.contactGaps.length})`
    );
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
