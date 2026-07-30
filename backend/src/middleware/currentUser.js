const { SESSION_COOKIE, userFromSession } = require('../services/authService');

// Identity comes only from a signed session cookie. Client-supplied headers such
// as X-User-Email are deliberately ignored — trusting one let any caller act as
// any user just by setting it.
module.exports = function currentUser(req, res, next) {
  const user = userFromSession(req.cookies?.[SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  // An admin-issued password gets you as far as changing it and no further, so
  // skipping the change screen in the UI does not buy API access.
  if (user.mustChangePassword) {
    return res.status(403).json({ error: 'Password change required' });
  }
  req.user = user;
  next();
};
