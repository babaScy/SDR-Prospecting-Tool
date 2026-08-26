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

module.exports = { getQualificationMode, setQualificationMode, MODES, getMaintenanceMode, setMaintenanceMode };
