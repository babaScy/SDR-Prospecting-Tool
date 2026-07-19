const mongoose = require('mongoose');

const pipelineStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PipelineState', pipelineStateSchema);
