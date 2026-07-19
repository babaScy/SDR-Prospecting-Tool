const express = require('express');
const List = require('../models/List');
const { REGIONS } = require('../config/filters');
const pullService = require('../services/pullService');

const router = express.Router();

const makeName = (profile, region) =>
  `${region.toUpperCase()} · ${profile.toUpperCase()} · ${new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })}`;

router.post('/', async (req, res, next) => {
  try {
    const { profile, region, count } = req.body || {};
    if (!['icp1', 'icp2'].includes(profile)) {
      return res.status(400).json({ error: "profile must be 'icp1' or 'icp2'" });
    }
    if (!REGIONS[region]) {
      return res.status(400).json({ error: `region must be one of: ${Object.keys(REGIONS).join(', ')}` });
    }
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      return res.status(400).json({ error: 'count must be an integer between 1 and 200' });
    }

    const running = await List.exists({ status: { $in: ['pulling', 'qualifying'] } });
    if (running) return res.status(409).json({ error: 'A pull is already running — wait for it to finish' });

    const list = await List.create({
      name: makeName(profile, region),
      profile,
      region,
      requestedCount: count,
      status: 'pulling',
      lastMessage: 'Starting pull...',
    });

    // Fire-and-forget: progress is polled via GET /api/lists/:id.
    pullService.runPull(list._id).catch((err) => console.error(`[pull] unhandled: ${err.message}`));

    res.status(201).json(list);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
