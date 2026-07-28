const Anthropic = require('@anthropic-ai/sdk');
const { EXCLUDED_TITLES, PROFILE_CONTEXT, PICKER_SYSTEM_PROMPT } = require('../config/contactFilters');
const List = require('../models/List');
const Company = require('../models/Company');
const Contact = require('../models/Contact');
const apolloPeople = require('./apolloPeopleService');
const { logProgress } = require('./pullService');

let client;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const PICKER_TOOL = {
  name: 'select_contacts',
  description: 'Select up to 4 best contacts, ranked best-first. Empty array if none qualify.',
  input_schema: {
    type: 'object',
    properties: {
      contacts: {
        type: 'array',
        description: 'Up to 4 contacts, ranked best-first.',
        items: {
          type: 'object',
          properties: {
            apolloPersonId: { type: 'string' },
            reasoning: { type: 'string', description: 'One sentence on why this person.' },
          },
          required: ['apolloPersonId', 'reasoning'],
        },
      },
    },
    required: ['contacts'],
  },
  cache_control: { type: 'ephemeral' },
};

const MAX_CONTACTS = 4;

async function pickContacts(enrichedCandidates, company, deps = {}) {
  const createMessage = deps.createMessage || ((params) => getClient().messages.create(params));

  const candidates = (enrichedCandidates || []).filter(
    (p) => p && !EXCLUDED_TITLES.some((re) => re.test(p.title || ''))
  );
  if (!candidates.length) return [];

  const list = candidates
    .map((p, i) => `${i + 1}. ID:${p.id} | ${p.first_name || ''} ${p.last_name || ''} | ${p.title || 'no title'} | email: ${p.email ? 'yes' : 'no'}`)
    .join('\n');

  const userMessage = `Company: ${company.companyName}
Employees: ${company.employees || 'Unknown'}
Profile: ${PROFILE_CONTEXT[company.icpProfile] || PROFILE_CONTEXT.icp1}

Candidates:
${list}

Pick up to 4 best contacts for Scytale to reach out to, ranked best-first.`.trim();

  const res = await createMessage({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [{ type: 'text', text: PICKER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [PICKER_TOOL],
    messages: [{ role: 'user', content: userMessage }],
  });

  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'select_contacts');
  if (!call) return [];

  const picks = [];
  for (const chosen of (call.input.contacts || []).slice(0, MAX_CONTACTS)) {
    const person = candidates.find((p) => p.id === chosen.apolloPersonId);
    if (!person) continue;
    picks.push({ person, rank: picks.length + 1, isPrimary: picks.length === 0, reasoning: chosen.reasoning });
  }
  return picks;
}

// Source one company: Apollo people search -> bulk match -> AI pick -> save.
// Returns the number of contacts saved.
async function sourceCompany(company, list, deps) {
  const search = deps.search || apolloPeople.searchCandidates;
  const bulkMatch = deps.bulkMatch || apolloPeople.bulkMatch;
  const pick = deps.pick || pickContacts;

  const domain = apolloPeople.domainFromWebsite(company.website);
  if (!domain) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  const people = await search(domain);
  if (!people.length) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  const enrichedById = await bulkMatch(people.map((person) => ({ person, domain })));
  const enriched = people.map((p) => enrichedById.get(p.id)).filter(Boolean);
  const picks = await pick(enriched, company);

  // delete-then-insert so a re-source is clean
  await Contact.deleteMany({ companyId: company._id });
  if (!picks.length) {
    await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'none' } });
    return 0;
  }

  await Contact.insertMany(picks.map(({ person, rank, isPrimary, reasoning }) => ({
    companyId: company._id,
    listId: list._id,
    apolloPersonId: person.id,
    domain,
    firstName: person.first_name,
    lastName: person.last_name,
    title: person.title,
    email: person.email || null,
    linkedinUrl: person.linkedin_url || null,
    phone: person.organization?.phone || null,
    rank, isPrimary, reasoning,
  })));
  await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'found' } });
  return picks.length;
}

async function sourceList(listId, deps = {}) {
  try {
    const list = await List.findById(listId);
    if (!list) throw new Error(`List ${listId} not found`);

    const accepted = await Company.find({ listId, sdrStatus: 'accepted' });
    await logProgress(listId, `Sourcing contacts for ${accepted.length} accepted companies...`);

    for (let i = 0; i < accepted.length; i++) {
      const company = accepted[i];
      await Company.findByIdAndUpdate(company._id, { $set: { contactStatus: 'sourcing' } });
      const n = await sourceCompany(company, list, deps);
      await logProgress(listId, `Sourced ${i + 1}/${accepted.length}: ${company.companyName} — ${n} contact(s)`);
    }

    await List.findByIdAndUpdate(listId, { $set: { status: 'sourced' } });
    await logProgress(listId, 'Contacts ready.');
  } catch (err) {
    console.error(`[contacts] list ${listId} failed: ${err.message}`);
    await List.findByIdAndUpdate(listId, { $set: { status: 'failed', error: err.message } });
    await logProgress(listId, `Contact sourcing failed: ${err.message}`);
  }
}

module.exports = { pickContacts, sourceList };
