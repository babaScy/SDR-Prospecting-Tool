const PipelineState = require('../models/PipelineState');

const KEY = 'qualificationMode';
const DEFAULT_MODE = 'batch';
const MODES = ['batch', 'single'];

async function getQualificationMode() {
  const doc = await PipelineState.findOne({ key: KEY });
  return MODES.includes(doc?.value) ? doc.value : DEFAULT_MODE;
}

async function setQualificationMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  await PipelineState.findOneAndUpdate({ key: KEY }, { $set: { value: mode } }, { upsert: true });
}

// Planned-maintenance toggle: app and database stay up, this just tells the
// frontend to show every non-admin a maintenance screen instead of the app.
// Same PipelineState-backed pattern as qualification mode — instant, no
// restart needed, and every user's next status check picks it up.
const MAINTENANCE_KEY = 'maintenanceMode';

async function getMaintenanceMode() {
  const doc = await PipelineState.findOne({ key: MAINTENANCE_KEY });
  return doc?.value === true;
}

async function setMaintenanceMode(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  await PipelineState.findOneAndUpdate({ key: MAINTENANCE_KEY }, { $set: { value: enabled } }, { upsert: true });
}

// Funnel stats shown on ListsScreen (demos booked, SQLs, closed-won deals,
// closed-won revenue). Admin-entered — Prospector has no downstream HubSpot
// deal-pipeline data of its own to compute these from. Same PipelineState-
// backed pattern as the settings above.
const FUNNEL_STATS_KEY = 'funnelStats';
const FUNNEL_STATS_FIELDS = ['demosBooked', 'sqls', 'closedWon', 'closedWonRevenue'];
const DEFAULT_FUNNEL_STATS = { demosBooked: 0, sqls: 0, closedWon: 0, closedWonRevenue: 0 };

async function getFunnelStats() {
  const doc = await PipelineState.findOne({ key: FUNNEL_STATS_KEY });
  return doc?.value ? { ...DEFAULT_FUNNEL_STATS, ...doc.value } : { ...DEFAULT_FUNNEL_STATS };
}

async function setFunnelStats(stats) {
  const next = {};
  for (const field of FUNNEL_STATS_FIELDS) {
    const value = stats?.[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number`);
    }
    next[field] = value;
  }
  await PipelineState.findOneAndUpdate({ key: FUNNEL_STATS_KEY }, { $set: { value: next } }, { upsert: true });
}

module.exports = {
  getQualificationMode,
  setQualificationMode,
  MODES,
  getMaintenanceMode,
  setMaintenanceMode,
  getFunnelStats,
  setFunnelStats,
};
