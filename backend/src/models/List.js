const mongoose = require('mongoose');

// One document per pull run. The pull job writes its progress here;
// the frontend polls this document to stay up to date (no SSE).
const listSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    profile: { type: String, enum: ['icp1', 'icp2', 'icp3'], required: true },
    region: {
      type: String,
      enum: ['uk', 'us', 'benelux', 'nordics', 'dach', 'aus', 'poland', 'taiwan', 'southafrica'],
      required: true,
    },
    requestedCount: { type: Number, required: true },
    assignedTo: { type: String, required: true },
    pullMode: { type: String, enum: ['fixed', 'quota'], default: 'fixed' },
    pulledCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pulling', 'qualifying', 'ready', 'reviewed', 'sourcing', 'sourced', 'failed'],
      default: 'pulling',
    },
    reviewConfirmedAt: { type: Date }, // SDR locked their accept/reject decisions
    // Opaque id of the in-process worker currently running this list's
    // pull/qualify job, plus a heartbeat timestamp — guards against a second
    // worker (e.g. a dev-server restart that resumes a still-running list
    // before the old process has fully exited) processing the same list at
    // once. See pullService.claimList.
    lockedBy: { type: String },
    lockedAt: { type: Date },
    lastMessage: { type: String, default: '' },
    progressLog: { type: [String], default: [] }, // capped at last 50 via $slice on push
    error: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('List', listSchema);
