const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const currentUser = require('./middleware/currentUser');
const maintenanceGuard = require('./middleware/maintenanceGuard');
const { getMaintenanceMode } = require('./services/settingsService');

const app = express();
// credentials must be allowed for the session cookie to travel cross-origin.
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174', credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Planned-maintenance status has to be reachable with no session at all — the
// whole point is showing it instead of the login form. Toggling it is
// admin-only and lives behind the guard, at PUT /api/settings/maintenance-mode.
app.get('/api/maintenance-status', async (req, res, next) => {
  try {
    res.json({ enabled: await getMaintenanceMode() });
  } catch (err) {
    next(err);
  }
});

// Signing in has to be reachable without a session, so this mounts ahead of the guard.
app.use('/api/auth', require('./routes/auth'));

app.use('/api', currentUser);
// Real enforcement, not just the frontend's UI hint — blocks every non-admin
// API call while maintenance is on, so an already-open tab (or a direct API
// call) can't bypass it. Mounted globally, ahead of every route below,
// including settings — admin bypasses it, so the toggle itself stays reachable.
app.use('/api', maintenanceGuard);

// Routes are mounted as they are built (Tasks 5-6):
app.use('/api/pull', require('./routes/pull'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/objection-feedback', require('./routes/objectionFeedback'));
app.use('/api/objection-responses', require('./routes/objectionResponses'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: err.message });
});

module.exports = app;
