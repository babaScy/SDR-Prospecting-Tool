const express = require('express');
const { getQualificationMode, setQualificationMode, MODES } = require('../services/settingsService');

const router = express.Router();

router.get('/qualification-mode', async (req, res, next) => {
  try {
    res.json({ mode: await getQualificationMode() });
  } catch (err) {
    next(err);
  }
});

router.put('/qualification-mode', async (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { mode } = req.body || {};
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${MODES.join(', ')}` });
  try {
    await setQualificationMode(mode);
    res.json({ mode });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
