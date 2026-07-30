const mongoose = require('mongoose');

// One row per person who can sign in. Deliberately separate from
// config/users.js: that file stays the allowlist and source of roles/regions,
// this holds only the secret. An email with no row here simply cannot sign in.
const credentialSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // Set when an admin issues or resets the password, cleared once the user
    // picks their own, so an admin-known password cannot stay in use.
    mustChangePassword: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Credential', credentialSchema);
