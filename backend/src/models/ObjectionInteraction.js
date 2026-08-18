const mongoose = require('mongoose');

// One SDR's relationship to one rebuttal response: whether they've starred
// it (personal, visible only to them) and how they voted (shared, summed
// into a team-wide net score). `objection`/`boxTitle` link by name/title
// strings, not ObjectId — same reasoning as ObjectionFeedback: the content
// lives in frontend/src/data/objections.js, not the database. `boxTitle`
// alone is a stable identity within an objection (verified: no objection
// has two boxes sharing a title). See
// docs/superpowers/specs/2026-08-18-objection-voting-and-stars-design.md.
const objectionInteractionSchema = new mongoose.Schema(
  {
    objection: { type: String, required: true },
    boxTitle: { type: String, required: true },
    userEmail: { type: String, required: true }, // always req.user.email, never client-supplied
    starred: { type: Boolean, default: false },
    vote: { type: Number, enum: [-1, 0, 1], default: 0 },
  },
  { timestamps: true }
);

objectionInteractionSchema.index({ objection: 1, boxTitle: 1, userEmail: 1 }, { unique: true });

module.exports = mongoose.model('ObjectionInteraction', objectionInteractionSchema);
