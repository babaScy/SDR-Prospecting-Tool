const express = require('express');
const List = require('../models/List');
const { REGIONS } = require('../config/filters');
const pullService = require('../services/pullService');
const quotaService = require('../services/quotaService');
const USERS = require('../config/users');
const { DAILY_QUALIFIED_QUOTA } = require('../config/pullConfig');

const SDR_EMAILS = USERS.filter((u) => u.role === 'sdr').map((u) => u.email);

const router = express.Router();

// Admin pulls: one at a time system-wide (unchanged). SDR pulls: one per SDR.
let adminPullStarting = false;
const sdrPullsInFlight = new Set();

const makeName = (profile, region) =>
  `${region.toUpperCase()} · ${profile.toUpperCase()} · ${new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
  })}`;

const RUNNING = { status: { $in: ['pulling', 'qualifying'] } };

// SDR quota indicator.
router.get('/quota', async (req, res, next) => {
  try {
    if (req.user.role !== 'sdr') return res.status(403).json({ error: 'SDR only' });
    const qualifiedToday = await quotaService.qualifiedToday(req.user.email);
    const pulledToday = await quotaService.pulledToday(req.user.email);
    res.json({ qualifiedToday, quota: DAILY_QUALIFIED_QUOTA, pulledToday });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  if (req.user.role === 'sdr') return sdrPull(req, res, next);
  return adminPull(req, res, next);
});

async function sdrPull(req, res, next) {
  const { region, profile } = req.body || {};
  if (!req.user.regions?.includes(region)) {
    return res.status(403).json({ error: 'Not one of your regions' });
  }
  if (!['icp1', 'icp2', 'icp3'].includes(profile)) {
    return res.status(400).json({ error: "profile must be 'icp1', 'icp2', or 'icp3'" });
  }
  if (await quotaService.pulledToday(req.user.email)) {
    return res.status(429).json({ error: 'You can only start one pull per day — resets at midnight' });
  }
  if (await quotaService.quotaReached(req.user.email)) {
    return res.status(429).json({ error: 'Daily limit reached — resets at midnight' });
  }
  if (sdrPullsInFlight.has(req.user.email)) {
    return res.status(409).json({ error: 'You already have a pull running' });
  }
  sdrPullsInFlight.add(req.user.email);
  try {
    if (await List.exists({ assignedTo: req.user.email, ...RUNNING })) {
      return res.status(409).json({ error: 'You already have a pull running' });
    }
    const list = await List.create({
      name: makeName(profile, region),
      profile, region,
      requestedCount: DAILY_QUALIFIED_QUOTA,
      assignedTo: req.user.email,
      pullMode: 'quota',
      status: 'pulling',
      lastMessage: 'Starting pull...',
    });
    pullService.runPull(list._id).catch((err) => console.error(`[pull] unhandled: ${err.message}`));
    res.status(201).json(list);
  } catch (err) {
    next(err);
  } finally {
    sdrPullsInFlight.delete(req.user.email);
  }
}

async function adminPull(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can run a pull' });

  const { profile, region, count, assignedTo } = req.body || {};
  if (!['icp1', 'icp2', 'icp3'].includes(profile)) {
    return res.status(400).json({ error: "profile must be 'icp1', 'icp2', or 'icp3'" });
  }
  if (!REGIONS[region]) {
    return res.status(400).json({ error: `region must be one of: ${Object.keys(REGIONS).join(', ')}` });
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: 'count must be an integer between 1 and 200' });
  }
  if (!SDR_EMAILS.includes(assignedTo)) {
    return res.status(400).json({ error: `assignedTo must be one of: ${SDR_EMAILS.join(', ')}` });
  }

  if (adminPullStarting) return res.status(409).json({ error: 'A pull is already running — wait for it to finish' });
  adminPullStarting = true;
  try {
    if (await List.exists(RUNNING)) {
      return res.status(409).json({ error: 'A pull is already running — wait for it to finish' });
    }
    const list = await List.create({
      name: makeName(profile, region),
      profile, region, requestedCount: count, assignedTo,
      pullMode: 'fixed', status: 'pulling', lastMessage: 'Starting pull...',
    });
    pullService.runPull(list._id).catch((err) => console.error(`[pull] unhandled: ${err.message}`));
    res.status(201).json(list);
  } catch (err) {
    next(err);
  } finally {
    adminPullStarting = false;
  }
}

module.exports = router;
