const mongoose = require('mongoose');

// One document per decision-maker sourced for an accepted company.
// Up to 4 per company, ranked 1..4 by the AI picker (1 = best).
const contactSchema = new mongoose.Schema(
  {
    companyId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    listId:         { type: mongoose.Schema.Types.ObjectId, ref: 'List', required: true, index: true },
    apolloPersonId: { type: String, required: true },
    domain:         { type: String },
    firstName:      { type: String },
    lastName:       { type: String },
    title:          { type: String },
    email:          { type: String }, // may be null — contact still shown
    linkedinUrl:    { type: String },
    phone:          { type: String },
    rank:           { type: Number }, // 1..4 (1 = best)
    isPrimary:      { type: Boolean, default: false },
    reasoning:      { type: String },
  },
  { timestamps: true }
);

contactSchema.index({ companyId: 1, apolloPersonId: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);
