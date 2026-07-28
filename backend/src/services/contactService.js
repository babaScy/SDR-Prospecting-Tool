const Anthropic = require('@anthropic-ai/sdk');
const { EXCLUDED_TITLES, PROFILE_CONTEXT, PICKER_SYSTEM_PROMPT } = require('../config/contactFilters');

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

module.exports = { pickContacts };
