const axios = require('axios');
const Company = require('../models/Company');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── OAuth token management (refresh-token flow) ─────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

const trim = (v) => (typeof v === 'string' ? v.trim() : v);

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const refresh = trim(process.env.HUBSPOT_REFRESH_TOKEN);
  const clientId = trim(process.env.HUBSPOT_CLIENT_ID);
  const clientSecret = trim(process.env.HUBSPOT_CLIENT_SECRET);
  if (!refresh || !clientId || !clientSecret) {
    throw new Error('HubSpot OAuth creds missing (need HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REFRESH_TOKEN)');
  }
  const res = await axios.post(
    'https://api.hubapi.com/oauth/v1/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

// Authed request. Retries once on 401 (stale cached token — re-fetch and retry)
// or on 429/5xx (HubSpot rate limit / transient).
async function hsRequest(method, path, data) {
  const token = await getAccessToken();
  const cfg = {
    method,
    url: `https://api.hubapi.com${path}`,
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  try {
    return await axios(cfg);
  } catch (err) {
    const status = err.response?.status;
    try {
      if (status === 401) {
        cachedToken = null; // stale/invalidated — force a fresh token on next getAccessToken()
        const freshToken = await getAccessToken();
        return await axios({ ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${freshToken}` } });
      }
      if (status === 429 || (status >= 500 && status < 600)) {
        const parsed = parseInt(err.response?.headers?.['retry-after'] || '2', 10);
        const wait = (Number.isFinite(parsed) ? parsed : 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        return await axios(cfg);
      }
    } catch (retryErr) {
      // Surface HubSpot's own detail (plain string only — never the raw error/config/headers,
      // which would carry the bearer token via retryErr.config / retryErr.response.config).
      throw new Error(retryErr.response?.data?.message || retryErr.message);
    }
    throw new Error(err.response?.data?.message || err.message);
  }
}

// ─── Normalization (the real anti-duplicate work) ────────────────────────────
function normalizeDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d || null;
}

function normalizeEmail(input) {
  if (!input) return null;
  const e = String(input).trim().toLowerCase();
  return e.includes('@') ? e : null;
}

function linkedinCore(input) {
  if (!input) return null;
  let u = String(input).trim().toLowerCase();
  if (!u) return null;
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  u = u.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return u.includes('linkedin.com') ? u : null;
}

function normalizeLinkedIn(input) {
  const core = linkedinCore(input);
  return core ? `https://${core}` : null;
}

// All plausible stored formats, for exact-match search (HubSpot search is exact).
function linkedinVariants(input) {
  const core = linkedinCore(input);
  if (!core) return [];
  const hosts = [core, `www.${core}`];
  const out = [];
  for (const h of hosts) for (const proto of ['https://', 'http://']) for (const slash of ['', '/']) out.push(proto + h + slash);
  return [...new Set(out)];
}

// ─── Owner lookup (cached — owners rarely change) ────────────────────────────
const ownerCache = new Map(); // lowercased email -> HubSpot owner id (positive results only — see getOwnerIdByEmail)

async function getOwnerIdByEmail(email, deps = {}) {
  const request = deps.request || hsRequest;
  const key = String(email).toLowerCase();
  if (ownerCache.has(key)) return ownerCache.get(key);
  const res = await request('get', `/crm/v3/owners?email=${encodeURIComponent(key)}`);
  const owner = (res.data.results || [])[0];
  const id = owner ? owner.id : null;
  if (id) ownerCache.set(key, id); // never cache a negative result — an SDR can be added to HubSpot later
  return id;
}

function clearCaches() {
  cachedToken = null;
  tokenExpiresAt = 0;
  ownerCache.clear();
}

// ─── Property mapping ────────────────────────────────────────────────────────
const prune = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));

const resolveDomain = (company, contact) => normalizeDomain(contact?.domain || company?.website);

const companyProps = (company, domain, ownerId) => prune({
  name: company.companyName,
  domain,
  country: company.country,
  numberofemployees: company.employees,
  linkedin_company_page: normalizeLinkedIn(company.companyLinkedinUrl),
  hubspot_owner_id: ownerId,
  inbound_outbound: 'OUTBOUND',
  lifecyclestage: '209865412', // "Outbound Qualified Lead"
});

// `company` is the contact's own "Company Name" field — independent of the
// name on its associated company record — and `country` has no HubSpot-side
// automation to fill it in at all. Without setting them here explicitly, both
// sit blank on every contact we push unless HubSpot's own domain-matching
// automation happens to fill `company` in (it never touches `country`).
//
// Company size is deliberately NOT set here: `number_of_employees_contact`
// looked like the right target (a plain numeric custom property) but HubSpot
// rejects writes to it with READ_ONLY_VALUE — it's a calculated property,
// presumably a rollup from the associated company, so it should populate on
// its own once the contact is associated to a company that has
// numberofemployees set. `numemployees` (bucketed enum, meant for Company) and
// `company_size` (wired to the Facebook Lead Ads integration) aren't right either.
const contactProps = (contact, ownerId, company) => prune({
  firstname: contact.firstName,
  lastname: contact.lastName,
  email: normalizeEmail(contact.email),
  jobtitle: contact.title,
  linkedin_profile: normalizeLinkedIn(contact.linkedinUrl),
  company: company?.companyName,
  country: company?.country,
  hs_marketable_status: false,
  hubspot_owner_id: ownerId,
  hs_lead_status: 'NEW',
  lead_source: 'Outbound',
  mql_sql: 'SQL',
});

// ─── Dedup lookups (read-only) ────────────────────────────────────────────────
async function findCompanyByDomain(domain, deps = {}) {
  const request = deps.request || hsRequest;
  const d = normalizeDomain(domain);
  if (!d) return null;
  const res = await request('post', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: d }] }],
    properties: ['domain', 'name'],
    limit: 2,
  });
  const total = res.data.total || 0;
  if (total === 0) return null;
  if (total > 1) return { ambiguous: true, count: total };
  return { id: res.data.results[0].id };
}

async function findContactByEmailOrLinkedIn(email, linkedinUrl, deps = {}) {
  const request = deps.request || hsRequest;
  const e = normalizeEmail(email);
  const liVariants = linkedinVariants(linkedinUrl);
  const filterGroups = [];
  if (e) filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: e }] });
  if (liVariants.length) filterGroups.push({ filters: [{ propertyName: 'linkedin_profile', operator: 'IN', values: liVariants }] });
  if (!filterGroups.length) return null;
  const res = await request('post', '/crm/v3/objects/contacts/search', {
    filterGroups,
    properties: ['email', 'linkedin_profile'],
    limit: 2,
  });
  const total = res.data.total || 0;
  if (total === 0) return null;
  if (total > 1) return { ambiguous: true, count: total };
  const hit = res.data.results[0];
  const matchedOn = e && hit.properties?.email?.toLowerCase() === e ? 'email' : 'linkedin';
  return { id: hit.id, matchedOn };
}

// ─── Orchestrator: dedup gate + insert-only write for ONE contact ────────────
class HubspotPushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ─── Company resolution, decided once per Company record and cached ─────────
// HubSpot's company-search API is eventually consistent — search-then-create
// is never safe to rely on for concurrency, no matter how carefully it's timed
// or locked, because the thing we'd be racing against (HubSpot's own index) is
// outside our control. So the correctness guarantee here lives entirely on our
// side instead: whether a HubSpot company has been resolved for this Mongo
// Company record is decided exactly once, via a single atomic update against
// our own database, and every later push for the same company is then a plain
// DB read — no HubSpot search involved at all, so nothing to race.
//
// This also closes the "no domain at all" gap for free: that case used to skip
// dedup entirely and create a fresh company on every single push, because
// there was nothing to search or lock on. The claim here is keyed on
// company._id, not domain, so it applies just as well with no domain.
const PENDING = 'PENDING';
const CLAIM_STALE_MS = 60_000; // a claim older than this is treated as abandoned (its holder crashed) and can be retaken
const RESOLVE_WAIT_INTERVAL_MS = 500;
const RESOLVE_WAIT_MAX_ATTEMPTS = 40; // ~20s — long enough to cover a concurrent holder's HubSpot create call

async function resolveOrCreateCompany(company, domain, ownerId, deps = {}) {
  const request = deps.request || hsRequest;
  const CompanyModel = deps.companyModel || Company;
  const wait = deps.sleep || sleep;

  const fresh = await CompanyModel.findById(company._id);
  if (fresh?.hubspotCompanyId && fresh.hubspotCompanyId !== PENDING) return fresh.hubspotCompanyId;

  const claimed = await CompanyModel.findOneAndUpdate(
    {
      _id: company._id,
      $or: [
        { hubspotCompanyId: { $exists: false } },
        { hubspotCompanyId: PENDING, hubspotCompanyClaimedAt: { $lt: new Date(Date.now() - CLAIM_STALE_MS) } },
      ],
    },
    { $set: { hubspotCompanyId: PENDING, hubspotCompanyClaimedAt: new Date() } }
  );

  if (claimed) {
    try {
      const existing = domain ? await findCompanyByDomain(domain, { request }) : null;
      if (existing?.ambiguous) {
        throw new HubspotPushError(
          'AMBIGUOUS_COMPANY',
          `${existing.count} HubSpot companies already match domain ${domain} — resolve manually.`
        );
      }
      let resolvedId = existing?.id;
      if (!resolvedId) {
        const created = await request('post', '/crm/v3/objects/companies', { properties: companyProps(company, domain, ownerId) });
        resolvedId = created.data.id;
      }
      await CompanyModel.updateOne({ _id: company._id }, { $set: { hubspotCompanyId: resolvedId } });
      return resolvedId;
    } catch (err) {
      // Release the claim so this doesn't sit blocked for CLAIM_STALE_MS after a failure.
      await CompanyModel.updateOne(
        { _id: company._id, hubspotCompanyId: PENDING },
        { $unset: { hubspotCompanyId: '', hubspotCompanyClaimedAt: '' } }
      ).catch(() => {});
      throw err;
    }
  }

  // Someone else holds the claim — poll our OWN database (fast, strongly
  // consistent) instead of HubSpot's search index.
  for (let attempt = 0; attempt < RESOLVE_WAIT_MAX_ATTEMPTS; attempt += 1) {
    await wait(RESOLVE_WAIT_INTERVAL_MS);
    const doc = await CompanyModel.findById(company._id);
    if (doc?.hubspotCompanyId && doc.hubspotCompanyId !== PENDING) return doc.hubspotCompanyId;
  }
  throw new HubspotPushError(
    'COMPANY_CREATE_TIMEOUT',
    'Timed out waiting for a concurrent HubSpot company resolve for this company — try again.'
  );
}

async function pushContact(company, contact, ownerEmail, deps = {}) {
  const request = deps.request || hsRequest;

  const ownerId = await getOwnerIdByEmail(ownerEmail, { request });
  if (!ownerId) {
    throw new HubspotPushError(
      'NO_HUBSPOT_OWNER',
      `No HubSpot user found for ${ownerEmail} — ask an admin to check their HubSpot account email.`
    );
  }

  const existingContact = await findContactByEmailOrLinkedIn(contact.email, contact.linkedinUrl, { request });
  if (existingContact?.ambiguous) {
    throw new HubspotPushError(
      'AMBIGUOUS_CONTACT',
      `${existingContact.count} HubSpot contacts already match this email/LinkedIn — resolve manually.`
    );
  }
  if (existingContact) {
    return { status: 'already_existed', hubspotContactId: existingContact.id, hubspotCompanyId: null };
  }

  const domain = resolveDomain(company, contact);
  const companyId = await resolveOrCreateCompany(company, domain, ownerId, {
    request, companyModel: deps.companyModel, sleep: deps.sleep,
  });

  const createdContact = await request('post', '/crm/v3/objects/contacts', { properties: contactProps(contact, ownerId, company) });
  const contactId = createdContact.data.id;

  await request('put', `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`);

  return { status: 'synced', hubspotContactId: contactId, hubspotCompanyId: companyId };
}

module.exports = {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedIn,
  linkedinVariants,
  getOwnerIdByEmail,
  findCompanyByDomain,
  findContactByEmailOrLinkedIn,
  companyProps,
  contactProps,
  resolveDomain,
  resolveOrCreateCompany,
  pushContact,
  HubspotPushError,
  clearCaches,
  hsRequest,
};
