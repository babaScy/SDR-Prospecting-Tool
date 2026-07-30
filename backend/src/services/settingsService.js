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

module.exports = { getQualificationMode, setQualificationMode, MODES };
