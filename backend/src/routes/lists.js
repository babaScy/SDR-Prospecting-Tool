const express = require('express');
const mongoose = require('mongoose');
const List = require('../models/List');
const Company = require('../models/Company');
const Contact = require('../models/Contact');
const contactService = require('../services/contactService');

const router = express.Router();

const BUCKETS = ['qualified', 'nei', 'disqualified'];

const EMPTY_COUNTS = {
  total: 0, pendingAi: 0, qualified: 0, nei: 0, disqualified: 0,
  accepted: 0, rejected: 0, pendingSdr: 0,
};

const countIf = (field, value) => ({ $sum: { $cond: [{ $eq: [field, value] }, 1, 0] } });

async function countsByList(listIds) {
  const rows = await Company.aggregate([
    { $match: { listId: { $in: listIds } } },
    {
      $group: {
        _id: '$listId',
        total: { $sum: 1 },
        pendingAi: countIf('$status', 'pending'),
        qualified: countIf('$status', 'qualified'),
        nei: countIf('$status', 'nei'),
        disqualified: countIf('$status', 'disqualified'),
        accepted: countIf('$sdrStatus', 'accepted'),
        rejected: countIf('$sdrStatus', 'rejected'),
        pendingSdr: countIf('$sdrStatus', 'pending'),
      },
    },
  ]);
  return new Map(rows.map(({ _id, ...counts }) => [String(_id), counts]));
}

router.get('/', async (req, res, next) => {
  try {
    const filter = req.user.role === 'sdr' ? { assignedTo: req.user.email } : {};
    const lists = await List.find(filter).sort({ createdAt: -1 }).lean();
    const counts = await countsByList(lists.map((l) => l._id));
    res.json(lists.map((l) => ({ ...l, counts: counts.get(String(l._id)) || EMPTY_COUNTS })));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    const counts = await countsByList([list._id]);
    res.json({ ...list, counts: counts.get(String(list._id)) || EMPTY_COUNTS });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/leads', async (req, res, next) => {
  try {
    const { bucket } = req.query;
    if (bucket !== undefined && !BUCKETS.includes(bucket)) {
      return res.status(400).json({ error: `bucket must be one of: ${BUCKETS.join(', ')}` });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }

    const query = { listId: list._id, ...(bucket !== undefined ? { status: bucket } : {}) };
    const leads = await Company.find(query)
      .sort({ companyName: 1 })
      .lean();
    res.json(leads);
  } catch (err) {
    next(err);
  }
});

// Locks the SDR's accept/reject decisions and kicks off contact sourcing.
router.post('/:id/confirm-review', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    if (list.status !== 'reviewed') {
      return res.status(409).json({ error: 'List is not fully reviewed' });
    }

    const acceptedCount = await Company.countDocuments({ listId: list._id, sdrStatus: 'accepted' });
    const update = { reviewConfirmedAt: new Date(), status: acceptedCount > 0 ? 'sourcing' : 'sourced' };
    const updated = await List.findByIdAndUpdate(list._id, { $set: update }, { new: true });

    if (acceptedCount > 0) {
      await Company.updateMany(
        { listId: list._id, sdrStatus: 'accepted' },
        { $set: { contactStatus: 'sourcing' } }
      );
      contactService.sourceList(list._id).catch((err) => console.error(`[contacts] unhandled: ${err.message}`));
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/contacts', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role === 'sdr' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }
    const companies = await Company.find({ listId: list._id, sdrStatus: 'accepted' })
      .select('companyName website contactStatus')
      .sort({ companyName: 1 }).lean();
    const contacts = await Contact.find({ listId: list._id }).sort({ rank: 1 }).lean();
    const byCompany = new Map();
    for (const c of contacts) {
      const k = String(c.companyId);
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k).push(c);
    }
    res.json(companies.map((company) => ({ company, contacts: byCompany.get(String(company._id)) || [] })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
