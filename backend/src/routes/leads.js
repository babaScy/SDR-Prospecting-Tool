const express = require('express');
const mongoose = require('mongoose');
const List = require('../models/List');
const Company = require('../models/Company');

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

module.exports = router;
