const mongoose = require('mongoose');

// One document per pull run. The pull job writes its progress here;
// the frontend polls this document to stay up to date (no SSE).
const listSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    profile: { type: String, enum: ['icp1', 'icp2'], required: true },
    region: {
      type: String,
      enum: ['uk', 'us', 'benelux', 'nordics', 'dach', 'aus'],
      required: true,
    },
    requestedCount: { type: Number, required: true },
    assignedTo: { type: String, required: true },
    pulledCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pulling', 'qualifying', 'ready', 'reviewed', 'failed'],
      default: 'pulling',
    },
    lastMessage: { type: String, default: '' },
    progressLog: { type: [String], default: [] }, // capped at last 50 via $slice on push
    error: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('List', listSchema);
