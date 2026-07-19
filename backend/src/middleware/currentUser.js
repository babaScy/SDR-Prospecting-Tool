const USERS = require('../config/users');

module.exports = function currentUser(req, res, next) {
  const email = req.header('X-User-Email');
  const user = email && USERS.find((u) => u.email === email);
  if (!user) return res.status(401).json({ error: 'Unknown or missing user' });
  req.user = user;
  next();
};
