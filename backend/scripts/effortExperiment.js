#!/usr/bin/env node
/**
 * One-off controlled experiment: pull 50 real US companies once, then
 * qualify that SAME set of 50 four separate times —
 *   - claude-sonnet-4-6, no output_config at all (the exact shape
 *     production used before the 4.6->5 switch)
 *   - claude-sonnet-5 at effort high / medium / low
 * — to measure whether effort tuning actually recovers Sonnet 4.6's
 * token/cost profile, and whether the qualification verdict (icp Yes/No/NEI)
 * holds steady across effort levels.
 *
 * Everything here is local-only: companies are pulled straight from Apollo
 * (apolloService) and cached to a JSON file — nothing is written to the
 * Company/List collections the live app uses, so this can't affect SDR
 * quotas, pulls, or the review UI. Re-running against an existing --out dir
 * reuses the cached company set and skips any config whose results file
 * already exists, so a crash/restart doesn't re-spend on completed configs.
 *
 * Uses the Batches API for all four configs — matching how production
 * qualified companies before the switch (chunks this size never went
 * through the sync path), and the fairest apples-to-apples comparison since
 * Batches is priced at 50% of the standard per-token rate.
 *
 * WRITES: nothing to Mongo. Local JSON files only, under --out <dir>.
 * Calls the real Anthropic API for all 4 configs — this spends real money.
 *
 * Usage: node scripts/effortExperiment.js --out <dir> [--profile icp1]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const apolloService = require('../src/services/apolloService');
const { buildUserMessage, tools, systemBlocks, getClient } = require('../src/services/qualifierService');

const REGION = 'us';
const COMPANY_COUNT = 50;

const CONFIGS = [
  { key: 'sonnet4.6-original', model: 'claude-sonnet-4-6', effort: null },
  { key: 'sonnet5-high', model: 'claude-sonnet-5', effort: 'high' },
  { key: 'sonnet5-medium', model: 'claude-sonnet-5', effort: 'medium' },
  { key: 'sonnet5-low', model: 'claude-sonnet-5', effort: 'low' },
];

async function loadOrPullCompanies(outDir, profile) {
  const cachePath = path.join(outDir, 'companies.json');
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log(`Using cached company set (${cached.length}) from ${cachePath}`);
    return cached;
  }

  const companies = [];
  const seen = new Set();
  let page = 1;
  while (companies.length < COMPANY_COUNT) {
    const { organizations, pagination } = await apolloService.searchCompaniesPage(profile, REGION, page, 25);
    if (!organizations.length) break;
    for (const org of organizations) {
      if (companies.length >= COMPANY_COUNT) break;
      if (seen.has(org.id)) continue;
      seen.add(org.id);
      let enriched;
      try {
        enriched = await apolloService.enrichOrganization(org.id);
      } catch (err) {
        console.error(`enrich failed for ${org.id}: ${err.message}`);
        continue;
      }
      if (!enriched) continue;
      companies.push(apolloService.mapOrganization(enriched));
    }
    if (pagination.totalPages && page >= pagination.totalPages) break;
    page += 1;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(companies, null, 2));
  console.log(`Pulled and cached ${companies.length} US companies to ${cachePath}`);
  return companies;
}

function buildRequests(config, companies) {
  return companies.map((company, i) => ({
    custom_id: String(i),
    params: {
      model: config.model,
      max_tokens: 2048,
      ...(config.effort ? { output_config: { effort: config.effort } } : {}),
      system: systemBlocks,
      tools,
      messages: [{ role: 'user', content: buildUserMessage(company) }],
    },
  }));
}

async function submitBatch(client, config, companies) {
  const requests = buildRequests(config, companies);
  console.log(`[${config.key}] submitting batch of ${requests.length}...`);
  const batch = await client.messages.batches.create({ requests });
  console.log(`[${config.key}] batch id: ${batch.id}`);
  return batch.id;
}

async function waitAndCollect(client, config, batchId, companies) {
  const TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const start = Date.now();
  let current = await client.messages.batches.retrieve(batchId);
  while (current.processing_status !== 'ended') {
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`[${config.key}] batch ${batchId} timed out`);
    await new Promise((r) => setTimeout(r, 30000));
    current = await client.messages.batches.retrieve(batchId);
    const mins = Math.floor((Date.now() - start) / 60000);
    console.log(`[${config.key}] waiting... (${mins}m, status=${current.processing_status})`);
  }

  const rows = new Array(companies.length).fill(null);
  for await (const item of await client.messages.batches.results(batchId)) {
    const i = Number(item.custom_id);
    const company = companies[i];
    if (item.result.type !== 'succeeded') {
      rows[i] = { company: company.companyName, ok: false, error: item.result.type };
      continue;
    }
    const usage = item.result.message.usage;
    const submitCall = item.result.message.content.find((b) => b.type === 'tool_use' && b.name === 'submit_result');
    rows[i] = {
      company: company.companyName,
      ok: true,
      icp: submitCall?.input?.icp ?? null,
      reasoning: submitCall?.input?.reasoning ?? null,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    };
  }
  console.log(`[${config.key}] done — ${rows.filter((r) => r?.ok).length}/${rows.length} succeeded`);
  return rows;
}

const PRICING = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};
// Approximation: cache writes get lumped at the 5m (1.25x base input) rate.
// The real bill also has some 1h writes (2x base input) — the API's usage
// object doesn't split cache_creation_input_tokens by TTL, so this slightly
// underestimates true cost. Token counts (the primary comparison this
// experiment cares about) are exact regardless.
function estimateCost(config, rows) {
  const base = PRICING[config.model];
  const totals = rows.reduce((acc, r) => {
    if (!r?.ok) return acc;
    acc.input += r.input_tokens;
    acc.output += r.output_tokens;
    acc.cacheWrite += r.cache_creation_input_tokens;
    acc.cacheRead += r.cache_read_input_tokens;
    return acc;
  }, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

  const perMTok = (n, rate) => (n / 1e6) * rate * 0.5; // 0.5 = Batches API discount
  const costUsd =
    perMTok(totals.input, base.input) +
    perMTok(totals.output, base.output) +
    perMTok(totals.cacheWrite, base.input * 1.25) +
    perMTok(totals.cacheRead, base.input * 0.1);
  return { totals, costUsd };
}

async function main() {
  const outFlagIndex = process.argv.indexOf('--out');
  const outDir = outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : null;
  const profileFlagIndex = process.argv.indexOf('--profile');
  const profile = profileFlagIndex !== -1 ? process.argv[profileFlagIndex + 1] : 'icp1';
  if (!outDir) {
    console.error('Usage: node scripts/effortExperiment.js --out <dir> [--profile icp1]');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const companies = await loadOrPullCompanies(outDir, profile);
  const client = getClient();

  // Submit every config that doesn't already have a results file up front —
  // Batches run server-side independently, so submitting all four before
  // polling any of them means the four wait times overlap instead of stacking.
  const pending = [];
  const allResults = {};
  for (const config of CONFIGS) {
    const resultPath = path.join(outDir, `${config.key}.json`);
    if (fs.existsSync(resultPath)) {
      console.log(`[${config.key}] already have results at ${resultPath}, skipping`);
      allResults[config.key] = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      continue;
    }
    const batchId = await submitBatch(client, config, companies);
    pending.push({ config, batchId });
  }

  await Promise.all(
    pending.map(async ({ config, batchId }) => {
      const rows = await waitAndCollect(client, config, batchId, companies);
      fs.writeFileSync(path.join(outDir, `${config.key}.json`), JSON.stringify(rows, null, 2));
      allResults[config.key] = rows;
    })
  );

  console.log('\n=== SUMMARY ===');
  const summaryRows = [];
  for (const config of CONFIGS) {
    const rows = allResults[config.key];
    const ok = rows.filter((r) => r?.ok);
    const avg = (key) => ok.reduce((s, r) => s + r[key], 0) / (ok.length || 1);
    const { costUsd } = estimateCost(config, rows);
    summaryRows.push({
      config: config.key,
      succeeded: `${ok.length}/${rows.length}`,
      avgInput: Math.round(avg('input_tokens')),
      avgOutput: Math.round(avg('output_tokens')),
      avgCacheWrite: Math.round(avg('cache_creation_input_tokens')),
      avgCacheRead: Math.round(avg('cache_read_input_tokens')),
      totalCostUsd: costUsd.toFixed(4),
      costPerCompany: (costUsd / (ok.length || 1)).toFixed(4),
    });
  }
  console.log(JSON.stringify(summaryRows, null, 2));

  // Verdict agreement vs the sonnet4.6-original baseline — "how we were
  // originally doing" is the ground truth this experiment measures drift
  // against, not necessarily the "correct" answer for any given company.
  const baseline = allResults['sonnet4.6-original'];
  console.log('\n=== VERDICT AGREEMENT vs sonnet4.6-original ===');
  const agreementReport = {};
  for (const config of CONFIGS) {
    if (config.key === 'sonnet4.6-original') continue;
    const rows = allResults[config.key];
    let agree = 0;
    const diffs = [];
    for (let i = 0; i < companies.length; i++) {
      const b = baseline[i];
      const r = rows[i];
      if (!b?.ok || !r?.ok) continue;
      if (b.icp === r.icp) agree++;
      else diffs.push({ company: companies[i].companyName, baseline: b.icp, [config.key]: r.icp });
    }
    console.log(`${config.key}: ${agree}/${companies.length} match`);
    agreementReport[config.key] = { agree, total: companies.length, diffs };
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summaryRows, null, 2));
  fs.writeFileSync(path.join(outDir, 'agreement.json'), JSON.stringify(agreementReport, null, 2));
  console.log(`\nFull results in ${outDir}/`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
