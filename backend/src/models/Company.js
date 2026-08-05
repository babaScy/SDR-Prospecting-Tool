const mongoose = require('mongoose');

// ── Qualification (ICP verdict, from the Claude qualifier) ───────────────────
const qualificationSchema = new mongoose.Schema(
  {
    icp:         { type: String, enum: ['Yes', 'No', 'Not enough information'] },
    isB2B:       { type: String, enum: ['Yes', 'No', 'Not enough information'] },
    isSaaS:      { type: String, enum: ['Yes', 'No', 'Not enough information'] },
    isCompliant: { type: String, enum: ['Yes', 'Not confirmed'] },
    frameworks:          { type: String },
    headquarterLocation: { type: String },
    customers:           { type: String },
    reasoning:           { type: String },
    productDescription:  { type: String },
    targetPersona:       { type: String },
    complianceLanguage:  { type: String },
    integrations:        { type: String },
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    apolloAccountId: { type: String, unique: true, required: true },

    // ── Firmographics (from Apollo) ──────────────────────────────────────────
    companyName: { type: String, required: true },
    website: { type: String },
    industry: { type: String },
    employees: { type: Number },
    annualRevenue: { type: String },
    country: { type: String },
    city: { type: String },
    foundedYear: { type: Number },
    shortDescription: { type: String },
    keywords: { type: [String], default: [] },
    technologies: { type: [String], default: [] },
    totalFunding: { type: String },
    latestFundingStage: { type: String },
    latestFundingDate: { type: Date },
    companyLinkedinUrl: { type: String },

    icpProfile: { type: String, enum: ['icp1', 'icp2', 'icp3'] },

    // ── AI verdict ───────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'qualified', 'nei', 'disqualified'], // nei = Not Enough Information
      default: 'pending',
    },
    disqualifyReason: { type: String },
    qualification: { type: qualificationSchema },

    // ── SDR review (final — overrides the AI verdict) ────────────────────────
    listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List', required: true },
    sdrStatus: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
    },
    sdrReviewedAt: { type: Date },

    // ── Contact sourcing (runs after the SDR confirms their review) ──────────
    contactStatus: {
      type: String,
      enum: ['pending', 'sourcing', 'found', 'none'],
      default: 'pending',
    },

    // ── HubSpot company resolution (one company per record, resolved once) ───
    // HubSpot's company-search API is eventually consistent, so it's never safe
    // to rely on for "does a company already exist for this domain" under
    // concurrent pushes — two contacts at this company pushed close together
    // could both see "not found" and both create one. Instead, whichever
    // contact push resolves this company's HubSpot ID first writes it here,
    // atomically (see hubspotService.resolveOrCreateCompany), and every later
    // push for the same company just reads it — no HubSpot search involved.
    // 'PENDING' is a transient claim marker while a resolve is in flight.
    hubspotCompanyId: { type: String },
    hubspotCompanyClaimedAt: { type: Date }, // when the PENDING claim was taken; lets a crashed holder's claim be reclaimed
  },
  { timestamps: true }
);

companySchema.index({ listId: 1, status: 1 });
companySchema.index({ listId: 1, sdrStatus: 1 });

module.exports = mongoose.model('Company', companySchema);
