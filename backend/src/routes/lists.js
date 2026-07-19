const express = require('express');
const mongoose = require('mongoose');
const List = require('../models/List');
const Company = require('../models/Company');

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
    const lists = await List.find().sort({ createdAt: -1 }).lean();
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
    const counts = await countsByList([list._id]);
    res.json({ ...list, counts: counts.get(String(list._id)) || EMPTY_COUNTS });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/leads', async (req, res, next) => {
  try {
    const { bucket } = req.query;
    if (!BUCKETS.includes(bucket)) {
      return res.status(400).json({ error: `bucket must be one of: ${BUCKETS.join(', ')}` });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'List not found' });
    const list = await List.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });

    const leads = await Company.find({ listId: list._id, status: bucket })
      .sort({ tier: 1, companyName: 1 })
      .lean();
    res.json(leads);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
