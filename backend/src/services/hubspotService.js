const axios = require('axios');

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

// Authed request. Retries once on 429/5xx (HubSpot rate limit / transient).
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
    if (status === 429 || (status >= 500 && status < 600)) {
      const wait = parseInt(err.response?.headers?.['retry-after'] || '2', 10) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return axios(cfg);
    }
    throw err;
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
const ownerCache = new Map(); // lowercased email -> HubSpot owner id, or null (checked, not found)

async function getOwnerIdByEmail(email, deps = {}) {
  const request = deps.request || hsRequest;
  const key = String(email).toLowerCase();
  if (ownerCache.has(key)) return ownerCache.get(key);
  const res = await request('get', `/crm/v3/owners?email=${encodeURIComponent(key)}`);
  const owner = (res.data.results || [])[0];
  const id = owner ? owner.id : null;
  ownerCache.set(key, id);
  return id;
}

function clearCaches() {
  cachedToken = null;
  tokenExpiresAt = 0;
  ownerCache.clear();
}

module.exports = {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedIn,
  linkedinVariants,
  getOwnerIdByEmail,
  clearCaches,
  // internal, exposed only so Task 2 extends the same module cleanly:
  hsRequest,
};
