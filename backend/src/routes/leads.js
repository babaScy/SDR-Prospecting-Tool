const express = require('express');
const mongoose = require('mongoose');
const List = require('../models/List');
const Company = require('../models/Company');
const { domainFromWebsite } = require('../services/apolloPeopleService');
const hubspotService = require('../services/hubspotService');

const router = express.Router();

router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision } = req.body || {};
    if (!['accepted', 'rejected', 'pending'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'accepted', 'rejected' or 'pending'" });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Lead not found' });

    const existing = await Company.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const ownerList = await List.findById(existing.listId);
    if (req.user.role === 'sdr' && ownerList?.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    if (ownerList?.reviewConfirmedAt) {
      return res.status(409).json({ error: 'Review already confirmed — decisions are locked' });
    }
    // No domain means no contact sourcing is possible — accepting would just
    // produce an accepted company nobody can be reached at.
    if (decision === 'accepted' && !domainFromWebsite(existing.website)) {
      return res.status(409).json({
        error: 'This company has no website domain on Apollo, so no contacts can be found for it. It can only be rejected.',
      });
    }

    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { $set: { sdrStatus: decision, sdrReviewedAt: decision === 'pending' ? null : new Date() } },
      { new: true }
    );

    // Flip the parent list between ready <-> reviewed based on remaining work.
    if (ownerList && ['ready', 'reviewed'].includes(ownerList.status)) {
      const pendingLeft = await Company.countDocuments({ listId: company.listId, sdrStatus: 'pending' });
      const target = pendingLeft === 0 ? 'reviewed' : 'ready';
      if (ownerList.status !== target) {
        await List.findByIdAndUpdate(ownerList._id, { $set: { status: target } });
      }
    }

    res.json(company);
  } catch (err) {
    next(err);
  }
});

// Push a company to HubSpot on its own — for the case where contact sourcing
// ran and found nobody (contactStatus: 'none'), so there's no Contact to push
// and no other way for the company to reach HubSpot. Companies with contacts
// are pushed individually from the Contacts screen instead.
router.post('/:id/hubspot', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Lead not found' });
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Lead not found' });

    const list = await List.findById(company.listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }

    if (company.contactStatus !== 'none') {
      return res.status(400).json({ error: 'This company has contacts — push them individually from the Contacts screen.' });
    }

    const domain = hubspotService.resolveDomain(company, null);
    if (!domain) {
      return res.status(400).json({ error: 'No website domain on this company — cannot safely dedupe in HubSpot' });
    }

    let hubspotCompanyId;
    try {
      const ownerId = await hubspotService.getOwnerIdByEmail(list.assignedTo);
      if (!ownerId) {
        throw new Error(`No HubSpot user found for ${list.assignedTo} — ask an admin to check their HubSpot account email.`);
      }
      hubspotCompanyId = await hubspotService.resolveOrCreateCompany(company, domain, ownerId);
    } catch (err) {
      console.error(`[hubspot] company push failed for ${company._id}: ${err.message}`);
      company.hubspotPushStatus = 'failed';
      company.hubspotPushError = err.message;
      await company.save();
      return res.status(502).json({ error: err.message });
    }

    company.hubspotCompanyId = hubspotCompanyId;
    company.hubspotPushStatus = 'synced';
    company.hubspotPushedAt = new Date();
    company.hubspotPushedBy = req.user.email;
    company.hubspotPushError = undefined;
    await company.save();
    return res.json(company);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
