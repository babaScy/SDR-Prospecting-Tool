const axios = require('axios');
const { BROAD_SEARCH_TITLES } = require('../config/contactFilters');

// People search runs on its own Apollo credential (APOLLO_PEOPLE_KEY) —
// separate plan/credits from the company search in apolloService.
const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const BULK_MATCH_URL = 'https://api.apollo.io/api/v1/people/bulk_match';

const headers = () => ({
  'X-Api-Key': process.env.APOLLO_PEOPLE_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

// `null`/`undefined` come from apolloService's `https://${primary_domain}` fallback
// when Apollo has no domain for the company. Apollo silently ignores a bogus
// domain filter and returns unrelated people, so these must never reach a search.
const PLACEHOLDER_HOSTS = new Set(['null', 'undefined']);

function domainFromWebsite(website) {
  if (!website) return null;
  try {
    const host = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
    if (PLACEHOLDER_HOSTS.has(host)) return null;
    if (!host.includes('.')) return null; // not a real public domain
    return host;
  } catch {
    return null;
  }
}

const buildSearchBody = (domain) => ({
  per_page: 25,
  q_organization_domains_list: [domain],
  person_titles: BROAD_SEARCH_TITLES,
  include_similar_titles: true,
});

async function searchCandidates(domain, deps = {}) {
  const post = deps.post || axios.post;
  const res = await post(SEARCH_URL, buildSearchBody(domain), { headers: headers(), timeout: 15000 });
  return res.data.people || [];
}

// items: [{ person: { id }, domain }]. Batches of 10. Returns Map<id, enriched>.
async function bulkMatch(items, deps = {}) {
  const post = deps.post || axios.post;
  const byId = new Map();
  for (let i = 0; i < items.length; i += 10) {
    const details = items.slice(i, i + 10).map((it) => ({ id: it.person.id, domain: it.domain }));
    const res = await post(BULK_MATCH_URL, { details, reveal_personal_emails: true }, { headers: headers(), timeout: 15000 });
    for (const m of res.data.matches || []) if (m?.id) byId.set(m.id, m);
  }
  return byId;
}

module.exports = { domainFromWebsite, buildSearchBody, searchCandidates, bulkMatch, SEARCH_URL, BULK_MATCH_URL };
