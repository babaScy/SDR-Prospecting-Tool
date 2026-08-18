const mongoose = require('mongoose');

// Feedback on an objection-handler rebuttal script. `objection` links by name,
// not ObjectId — the content it refers to lives in frontend/src/data/objections.js,
// not the database. See docs/superpowers/specs/2026-08-18-objection-handler-design.md.
const objectionFeedbackSchema = new mongoose.Schema(
  {
    objection: { type: String, required: true },
    text: { type: String, required: true },
    authorEmail: { type: String, required: true }, // always req.user.email, never client-supplied
  },
  { timestamps: true }
);

objectionFeedbackSchema.index({ objection: 1 });

module.exports = mongoose.model('ObjectionFeedback', objectionFeedbackSchema);
