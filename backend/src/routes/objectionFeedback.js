const express = require('express');
const ObjectionFeedback = require('../models/ObjectionFeedback');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const entries = await ObjectionFeedback.find({}).sort({ createdAt: -1 });
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { objection } = req.body || {};
    if (!objection || typeof objection !== 'string') {
      return res.status(400).json({ error: 'objection is required' });
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    const entry = await ObjectionFeedback.create({ objection, text, authorEmail: req.user.email });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
