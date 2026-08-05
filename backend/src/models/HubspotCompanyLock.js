const mongoose = require('mongoose');

// A short-lived mutex for "does a HubSpot company for this domain exist yet?".
//
// Two SDRs (or the same SDR clicking two contact cards for one company within
// the same second) can each run pushContact's search-then-create sequence at
// the same moment. HubSpot's company search index doesn't reflect a just-created
// company instantly, so both requests can see "no match" and both create a
// company — one real company becomes two or three duplicates in HubSpot.
//
// The unique index on `domain` makes acquiring the lock atomic even across
// multiple backend instances (Render can run more than one): whichever request's
// insert lands first wins; every other concurrent insert for the same domain
// fails with a duplicate-key error and knows to wait instead of creating its own
// company. The TTL only exists as a crash safety net — the normal path always
// deletes its own lock in a `finally` (see hubspotService.createCompanyOnce).
const hubspotCompanyLockSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 60 },
});

module.exports = mongoose.model('HubspotCompanyLock', hubspotCompanyLockSchema);
