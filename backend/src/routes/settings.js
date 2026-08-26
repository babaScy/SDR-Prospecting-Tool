const express = require('express');
const { getQualificationMode, setQualificationMode, MODES, setMaintenanceMode } = require('../services/settingsService');

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

// Reading current state is via the public GET /api/maintenance-status (app.js,
// mounted ahead of the auth guard) — a signed-out user needs to see this too.
router.put('/maintenance-mode', async (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  try {
    await setMaintenanceMode(enabled);
    res.json({ enabled });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
