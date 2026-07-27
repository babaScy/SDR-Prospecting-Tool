const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const Company = require('../models/Company');
const { SYNC_THRESHOLD } = require('../config/pullConfig');

let client;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY from env

const systemPromptText = fs.readFileSync(path.join(__dirname, '../config/prompt.md'), 'utf-8');

// ─── Tools (identical to WOLF+) ───────────────────────────────────────────────

const tools = [
  {
    type: 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: 4,
  },
  {
    name: 'submit_result',
    description:
      'Submit the final ICP qualification result once you have gathered enough information. Always call this tool — never respond with plain text.',
    input_schema: {
      type: 'object',
      properties: {
        icp: { type: 'string', enum: ['Yes', 'No', 'Not enough information'], description: 'Whether the company fits Scytale ICP' },
        tier: { type: 'string', enum: ['A', 'B', 'C'], description: 'ICP fit strength. A = strong fit, B = moderate fit, C = weak/borderline fit. Only set if icp is Yes.' },
        isB2B: { type: 'string', enum: ['Yes', 'No', 'Not enough information'] },
        isSaaS: { type: 'string', enum: ['Yes', 'No', 'Not enough information'] },
        isCompliant: { type: 'string', enum: ['Yes', 'Not confirmed'], description: 'Whether the company explicitly mentions ISO 27001 or SOC 2 compliance' },
        frameworks: { type: 'string', description: 'Any compliance frameworks mentioned (ISO 27001, SOC 2, GDPR, HIPAA, PCI DSS, etc.)' },
        headquarterLocation: { type: 'string', description: 'Country where the company is headquartered' },
        customers: { type: 'string', description: 'Any notable customers or clients mentioned on the website' },
        reasoning: { type: 'string', description: 'Short explanation: is it B2B, does it sell software, is software central to delivery, were negative indicators present, and why the final ICP decision was made.' },
        productDescription: { type: 'string', description: "One sentence describing what the product does and who it is for, using the company's own language where possible. Only populate if icp is Yes." },
        targetPersona: { type: 'string', description: 'Who the company sells to — their buyer or end user. Be specific, e.g. "DevOps teams at mid-market SaaS companies". Only populate if icp is Yes.' },
        complianceLanguage: { type: 'string', description: 'Exact phrases or sections found on /security, /trust, /compliance, or /about pages relating to compliance, certifications, or data security. Capture verbatim where possible. Leave empty if nothing found.' },
        integrations: { type: 'string', description: 'Comma-separated list of third-party tools or platforms the company integrates with, as mentioned on the website. Focus on: AWS, GCP, Azure, Jira, GitHub, GitLab, Slack, HubSpot, Salesforce, Google Workspace, Microsoft 365, Okta, etc. Leave empty if none found.' },
      },
      required: ['icp', 'isB2B', 'isSaaS', 'isCompliant', 'reasoning'],
    },
    cache_control: { type: 'ephemeral', ttl: '1h' },
  },
];

const systemBlocks = [
  { type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral', ttl: '1h' } },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUserMessage(lead) {
  return `
Please research and qualify the following company against our ICP criteria.

APOLLO DATA:
Company: ${lead.companyName}
Website: ${lead.website}
Industry: ${lead.industry || 'Unknown'}
Employees: ${lead.employees || 'Unknown'}
Country: ${lead.country || 'Unknown'}
Annual Revenue: ${lead.annualRevenue || 'Unknown'}
Founded: ${lead.foundedYear || 'Unknown'}
Keywords: ${lead.keywords?.join(', ') || 'None'}
Technologies: ${lead.technologies?.join(', ') || 'None'}
Description: ${lead.shortDescription || 'None'}
Total Funding: ${lead.totalFunding || 'Unknown'}
Latest Funding Stage: ${lead.latestFundingStage || 'Unknown'}

Use web_fetch to research the company website. Start with the homepage, then fetch these pages in order of priority:
1. /security, /compliance, or /trust — these are the most important pages: look for ISO 27001, SOC 2, or other compliance framework mentions
2. /about or /company — for B2B/SaaS confirmation and company profile
3. /product, /platform, or /pricing — if software-centrality is still unclear

Before calling submit_result, always scan the homepage footer for certification badges or links to third-party verification registries. A Certipedia link (certipedia.com) confirms ISO 27001. An AICPA SOC badge confirms SOC 2. Note what you find in the frameworks and isCompliant fields accordingly.

Once you have enough information, call submit_result with your findings.
`.trim();
}

async function persistResult(company, result) {
  // tier is a top-level Company attribute; the rest is the qualification sub-doc.
  const { tier, ...qualification } = result;

  let newStatus;
  if (result.icp === 'Yes') newStatus = 'qualified';
  else if (result.icp === 'Not enough information') newStatus = 'nei';
  else newStatus = 'disqualified';

  return Company.findByIdAndUpdate(
    company._id,
    { $set: { status: newStatus, qualification, ...(tier ? { tier } : {}) } },
    { new: true }
  );
}

// ─── Batch qualification (polls every 60s, 2h timeout) ───────────────────────

const qualifyCompaniesBatch = async (companies, onLog = () => {}) => {
  const companyById = new Map(companies.map((c) => [c._id.toString(), c]));

  const requests = companies.map((company) => ({
    custom_id: company._id.toString(),
    params: {
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemBlocks,
      tools,
      messages: [{ role: 'user', content: buildUserMessage(company) }],
    },
  }));

  if (!requests.length) {
    await onLog('No companies to qualify — skipping.');
    return new Map();
  }

  const anthropic = getClient();
  await onLog(`Submitting ${requests.length} companies to Claude...`);
  const batch = await anthropic.messages.batches.create({ requests });

  const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const batchStart = Date.now();
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (Date.now() - batchStart > BATCH_TIMEOUT_MS) {
      throw new Error(`Qualification batch timed out after 2 hours (batch ID: ${batch.id})`);
    }
    await new Promise((r) => setTimeout(r, 60000));
    current = await anthropic.messages.batches.retrieve(batch.id);
    const mins = Math.floor((Date.now() - batchStart) / 60000);
    await onLog(`Waiting for Claude... (${mins}m elapsed)`);
  }

  const { succeeded, errored, canceled, expired } = current.request_counts;
  await onLog(`Batch ended — succeeded: ${succeeded} · errored: ${errored} · canceled: ${canceled} · expired: ${expired}`);

  const resultsById = new Map();
  for await (const item of await anthropic.messages.batches.results(batch.id)) {
    const company = companyById.get(item.custom_id);
    if (!company) continue;

    if (item.result.type === 'succeeded') {
      const submitCall = item.result.message.content.find(
        (b) => b.type === 'tool_use' && b.name === 'submit_result'
      );
      if (submitCall) {
        try {
          await persistResult(company, submitCall.input);
          resultsById.set(item.custom_id, { ok: true, data: { icp: submitCall.input.icp, tier: submitCall.input.tier } });
        } catch (err) {
          resultsById.set(item.custom_id, { ok: false, error: err.message });
        }
      } else {
        resultsById.set(item.custom_id, { ok: false, error: 'no submit_result call' });
      }
    } else {
      resultsById.set(item.custom_id, { ok: false, error: item.result.type });
    }
  }

  return resultsById;
};

// ─── Sync qualification (Messages API) — for tiny top-up chunks (< 3) ────────
async function qualifyOneSync(company) {
  const anthropic = getClient();
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemBlocks,
    tools,
    messages: [{ role: 'user', content: buildUserMessage(company) }],
  });
  const submitCall = msg.content.find((b) => b.type === 'tool_use' && b.name === 'submit_result');
  if (!submitCall) return { ok: false, error: 'no submit_result call' };
  await persistResult(company, submitCall.input);
  return { ok: true, data: { icp: submitCall.input.icp, tier: submitCall.input.tier } };
}

const qualifyCompaniesSync = async (companies, onLog = () => {}) => {
  const resultsById = new Map();
  for (const company of companies) {
    await onLog(`Qualifying ${company.companyName} (sync)...`);
    try {
      resultsById.set(company._id.toString(), await qualifyOneSync(company));
    } catch (err) {
      resultsById.set(company._id.toString(), { ok: false, error: err.message });
    }
  }
  return resultsById;
};

// Dispatcher: chunk < SYNC_THRESHOLD → sync; otherwise batch.
const qualifyCompanies = async (companies, onLog = () => {}, deps = {}) => {
  if (companies.length === 0) return new Map();
  const sync = deps.sync || qualifyCompaniesSync;
  const batch = deps.batch || qualifyCompaniesBatch;
  return companies.length < SYNC_THRESHOLD ? sync(companies, onLog) : batch(companies, onLog);
};

module.exports = { qualifyCompaniesBatch, qualifyCompaniesSync, qualifyCompanies, persistResult };
