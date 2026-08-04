// Copied verbatim from WOLF+ (The-Wolf/icp-qualifier/src/services/contactService.js).
const EXCLUDED_TITLES = [
  /finance|financial|accounting|accountant/i,
  /legal|counsel|attorney|lawyer/i,
  /marketing|campaign|content|author|editor|writer|copywriter|brand/i,
  /\bsales\b|business development|account executive|account manager|account director|commercial director|sales director/i,
  /human resources|people ops|\bhr\b|talent|recruiter|recruitment/i,
  /delegate|ambassador|advisor|consultant/i,
  /operations manager|office manager|admin/i,
  /customer success|customer support|support engineer/i,
  /partner|practice lead|business director/i,
];

const BROAD_SEARCH_TITLES = [
  'ceo', 'cto', 'ciso', 'coo', 'cio',
  'co-founder', 'founder', 'managing director', 'general manager',
  'chief executive officer', 'chief technology officer', 'chief information security officer',
  'chief operating officer', 'chief information officer',
  'vp engineering', 'vp technology', 'vp security', 'vp infrastructure', 'vp of cyber',
  'head of engineering', 'head of technology', 'head of security',
  'head of information security', 'head of infosec', 'head of cyber',
  'head of it', 'head of infrastructure',
  'director of engineering', 'director of technology', 'director of security',
  'director of information security', 'director of it',
  'technical director', 'engineering director', 'security director',
  'it director', 'information security manager', 'information security director',
  'compliance manager', 'compliance officer', 'compliance director',
  'security manager', 'it manager', 'infrastructure manager',
  'technical co-founder', 'director',
];

const PROFILE_CONTEXT = {
  icp1: 'Startup (1–50 employees). No dedicated security function exists yet — compliance is owned by a founder or senior technical leader. Priority order: CEO → CTO / Chief Technology Officer → Co-Founder. CISO is rare at this size but a strong signal if present.',
  icp2: 'Growth-stage company (51–250 employees). Priority order: CTO / Chief Technology Officer → CISO / Head of Security / Head of Infosec / Director of Security → Co-Founder → CEO → VP Engineering / Director of Engineering. At this size the CTO is the dominant decision-maker for compliance tooling, with CISO as the warmest lead if present.',
  icp3: 'Enterprise (250+ employees). Priority order: CISO / Head of Security / Head of Infosec → Director of Security / Director of Information Security → CTO / Chief Technology Officer → VP Security / VP Engineering. At this size compliance is owned by a dedicated security function, with the CISO the primary decision-maker for compliance tooling.',
};

// Adapted from WOLF+: pick UP TO 4 ranked contacts instead of one.
const PICKER_SYSTEM_PROMPT = `You are a B2B sales assistant for Scytale, a compliance automation platform that helps companies achieve ISO 27001 and SOC 2 certification faster.

Your job is to pick up to 4 contacts — the people most likely to own or influence a compliance or security purchase — ranked best-first.

## Title Normalization
Before evaluating anyone, normalize their title mentally:
- "Co-CEO", "Managing Director", "Managing Partner" → treat as CEO
- "VP Engineering", "Head of Engineering", "Engineering Director" → treat as senior engineering leader
- "Head of Security", "Head of Infosec", "Director of Information Security", "VP Security" → treat as CISO-equivalent
- "Chief of Staff", "Technical Lead", "Staff Engineer" → not decision-makers, ignore
- Strip qualifiers like "Acting", "Interim", "Associate", "Assistant" and evaluate the base title

## Who to Pick
Follow the ICP priority order, best-first. Prefer candidates with an email address. Return up to 4 genuine decision-makers — fewer if fewer qualify. Do not pad the list with weak candidates.

"Director" titles require judgment:
- Director of Security / Director of Engineering / Director of Infosec → valid
- Account Director / Director of Sales / Director of Customer Success / Director of Partnerships → disqualified
- When unsure, ask: does this person own technical or security decisions? If no, skip.

## Hard Disqualify
Never pick anyone whose role is primarily: sales, marketing, HR, finance, legal, customer success, partnerships, recruiting, or account management — regardless of seniority.

## No Viable Contact
If no candidate passes the above criteria, call select_contacts with an empty array. Do not force a pick.

Always call select_contacts — never respond with plain text.`;

module.exports = { BROAD_SEARCH_TITLES, EXCLUDED_TITLES, PROFILE_CONTEXT, PICKER_SYSTEM_PROMPT };
