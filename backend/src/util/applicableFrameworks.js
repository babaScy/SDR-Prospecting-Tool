// Suggests compliance frameworks likely applicable to a prospect, for display
// on the lead card. Purely a deterministic heuristic over data already on the
// lead (Apollo firmographics + the AI qualifier's free-text fields) — no AI
// call, nothing stored, recomputed on every read. See docs/frameworks-reference.md
// for the framework catalog this is built from (pulled from Scytale's SDR Hub
// Notion). Only "Full Frameworks" are ever suggested — "Half Frameworks" are
// add-ons sold alongside a primary framework, never on their own.
//
// Rules are ordered most-specific-first and capped at MAX_SUGGESTIONS: the
// first N distinct matches win, so an industry/geography hit always crowds
// out the generic SOC 2 / ISO 27001 baseline before that baseline is reached.

const MAX_SUGGESTIONS = 4;

const EU_COUNTRIES = new Set([
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech republic', 'czechia',
  'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland',
  'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'poland',
  'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
]);

const QUEBEC_CITY_HINT = /\b(quebec|qu[eé]bec|montr[eé]al|laval|gatineau)\b/i;

// Each rule: { name, test(ctx) }. ctx = { text (lowercased haystack of free
// text fields), country (lowercased), city (lowercased) }.
const RULES = [
  // --- Industry / vertical (most specific) ---
  { name: 'ISO 13485', test: (c) => /\bmedical device/.test(c.text) },
  { name: 'HIPAA', test: (c) => /health ?care|hospital|clinic\b|patient|\bphi\b|\behr\b|\bemr\b|telehealth|life sciences?/.test(c.text) },
  { name: 'PCI DSS', test: (c) => /payment|checkout|point of sale|\bpos\b|e-?commerce|merchant|card processing|cardholder/.test(c.text) },
  { name: 'TISAX', test: (c) => /automotive|auto(mobile)? (oem|supplier)|vehicle manufactur/.test(c.text) },
  { name: 'CMMC', test: (c) => /defense contractor|department of defense|\bdod\b|defense industrial base/.test(c.text) },
  { name: 'ISO 42001', test: (c) => /artificial intelligence|machine learning|generative ai/.test(c.text) },
  { name: 'SOX ITGC', test: (c) => /publicly traded|public company|nasdaq|nyse\b|sec filing/.test(c.text) },

  // --- Regulatory / geography, from free text ---
  { name: 'CCPA', test: (c) => /california|\bccpa\b/.test(c.text) },
  { name: 'GDPR', test: (c) => EU_COUNTRIES.has(c.country) || /\bgdpr\b|european union|\beu resident/.test(c.text) },

  // --- Regulatory / geography, from the lead's own country ---
  { name: 'Cyber Essentials', test: (c) => c.country === 'united kingdom' },
  { name: 'Essential 8', test: (c) => c.country === 'australia' },
  { name: 'C5', test: (c) => c.country === 'germany' },
  { name: 'POPI Act', test: (c) => c.country === 'south africa' },
  { name: 'PPL (Protection of Privacy Law)', test: (c) => c.country === 'israel' },
  { name: 'Bill 64 / Law 25', test: (c) => c.country === 'canada' && QUEBEC_CITY_HINT.test(c.city) },

  // --- Generic B2B SaaS baseline (always last — only fills remaining slots) ---
  { name: 'SOC 2', test: () => true },
  { name: 'ISO 27001', test: () => true },
];

function buildHaystack(lead) {
  const q = lead.qualification || {};
  return [
    lead.industry,
    lead.shortDescription,
    ...(Array.isArray(lead.keywords) ? lead.keywords : []),
    ...(Array.isArray(lead.technologies) ? lead.technologies : []),
    q.productDescription,
    q.complianceLanguage,
    q.customers,
    q.integrations,
    q.targetPersona,
    q.headquarterLocation,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function applicableFrameworks(lead) {
  const ctx = {
    text: buildHaystack(lead || {}),
    country: String(lead?.country || '').trim().toLowerCase(),
    city: String(lead?.city || '').trim().toLowerCase(),
  };

  const matches = [];
  for (const rule of RULES) {
    if (matches.length >= MAX_SUGGESTIONS) break;
    if (matches.includes(rule.name)) continue;
    if (rule.test(ctx)) matches.push(rule.name);
  }
  return matches;
}

module.exports = { applicableFrameworks };
