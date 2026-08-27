const { getMaintenanceMode } = require('../services/settingsService');

// Real enforcement, not just a UI hint — currentUser.js runs first, so
// req.user is already set. Admin always bypasses (same as the frontend),
// so whoever turned maintenance on can still reach the toggle to turn it
// back off. A broken check fails OPEN (logs and lets the request through)
// rather than blocking real work over an unrelated DB hiccup — same
// philosophy as the frontend's own status check.
module.exports = async function maintenanceGuard(req, res, next) {
  if (req.user?.role === 'admin') return next();
  try {
    if (await getMaintenanceMode()) {
      return res.status(503).json({ error: 'Down for maintenance — try again shortly.' });
    }
  } catch (err) {
    console.error(`[maintenance] status check failed, allowing request through: ${err.message}`);
  }
  next();
};
