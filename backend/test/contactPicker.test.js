const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickContacts } = require('../src/services/contactService');

const company = { companyName: 'Acme', employees: 20, icpProfile: 'icp1' };

test('pickContacts filters excluded titles then returns ranked picks (max 4)', async () => {
  const candidates = [
    { id: 'ceo', first_name: 'A', last_name: 'A', title: 'CEO', email: 'a@x.com' },
    { id: 'cto', first_name: 'B', last_name: 'B', title: 'CTO', email: 'b@x.com' },
    { id: 'sales', first_name: 'C', last_name: 'C', title: 'VP of Sales', email: 'c@x.com' }, // excluded
  ];
  // Fake AI: returns ceo then cto, ranked.
  const createMessage = async (params) => {
    // excluded 'sales' must not be offered to the model
    assert.ok(!params.messages[0].content.includes('VP of Sales'));
    return { content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [
      { apolloPersonId: 'ceo', reasoning: 'founder owns compliance' },
      { apolloPersonId: 'cto', reasoning: 'senior technical leader' },
    ] } }] };
  };
  const picks = await pickContacts(candidates, company, { createMessage });
  assert.equal(picks.length, 2);
  assert.equal(picks[0].person.id, 'ceo');
  assert.equal(picks[0].rank, 1);
  assert.equal(picks[0].isPrimary, true);
  assert.equal(picks[1].rank, 2);
  assert.equal(picks[1].isPrimary, false);
});

test('pickContacts returns [] when AI selects none', async () => {
  const createMessage = async () => ({ content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [] } }] });
  const picks = await pickContacts([{ id: 'x', title: 'CTO' }], company, { createMessage });
  assert.deepEqual(picks, []);
});

test('pickContacts caps at 4 even if AI returns more', async () => {
  const cands = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: 'CTO' }));
  const createMessage = async () => ({ content: [{ type: 'tool_use', name: 'select_contacts', input: {
    contacts: cands.map((c) => ({ apolloPersonId: c.id, reasoning: 'r' })),
  } }] });
  const picks = await pickContacts(cands, company, { createMessage });
  assert.equal(picks.length, 4);
});

test('pickContacts dedupes when the model names the same person twice', async () => {
  const cands = [{ id: 'dup', title: 'CTO' }, { id: 'other', title: 'CEO' }];
  const createMessage = async () => ({ content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [
    { apolloPersonId: 'dup', reasoning: 'first' },
    { apolloPersonId: 'dup', reasoning: 'again' },
    { apolloPersonId: 'other', reasoning: 'third' },
  ] } }] });
  const picks = await pickContacts(cands, company, { createMessage });
  assert.deepEqual(picks.map((p) => p.person.id), ['dup', 'other']);
  assert.deepEqual(picks.map((p) => p.rank), [1, 2]); // ranks stay contiguous
});

test('pickContacts dedupes duplicate candidates from Apollo', async () => {
  const cands = [{ id: 'x', title: 'CTO' }, { id: 'x', title: 'CTO' }];
  const seen = [];
  const createMessage = async (params) => {
    seen.push(params.messages[0].content);
    return { content: [{ type: 'tool_use', name: 'select_contacts', input: { contacts: [{ apolloPersonId: 'x', reasoning: 'r' }] } }] };
  };
  const picks = await pickContacts(cands, company, { createMessage });
  assert.equal(picks.length, 1);
  assert.equal((seen[0].match(/ID:x/g) || []).length, 1); // offered once, not twice
});
