const mongoose = require('mongoose');

// One row per classified, kept item from framework-intel's pipeline — a
// separate, external repo (regulator/standards-body change monitoring) that
// still runs by hand on someone's laptop. This collection is a mirror of its
// append-only events.json log, kept in sync via POST /api/intel/sync
// (upserted on eventId), not a second source of truth of our own.
const intelEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    sourceId: { type: String, required: true },
    tier: { type: String, enum: ['primary', 'watch'], required: true },
    sourceUrl: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    changeType: { type: String, required: true },
    frameworks: { type: [String], default: [] },
    regions: { type: [String], default: [] },
    whatsHappening: { type: String, required: true },
    talkingPoint: { type: String, default: '' },
    outreachWorthy: { type: Boolean, default: false },
    whoToTarget: { type: String, default: '' },
    confidence: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('IntelEvent', intelEventSchema);
