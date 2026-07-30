const express = require('express');
const {
  SESSION_COOKIE,
  findUser,
  signSession,
  userFromSession,
  cookieOptions,
} = require('../services/authService');
const { hashPassword, verifyPassword, generatePassword, MIN_LENGTH } = require('../services/passwordService');
const throttle = require('../util/loginThrottle');
const Credential = require('../models/Credential');

const router = express.Router();

// A hash to compare against when the account does not exist, so a bad email and
// a bad password take the same amount of time and cannot be told apart.
let decoyHash;
const decoy = async () => {
  decoyHash = decoyHash || (await hashPassword('decoy-comparison-target'));
  return decoyHash;
};

const sessionUser = (req) => userFromSession(req.cookies?.[SESSION_COOKIE]);

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    if (throttle.isLocked(email)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const user = findUser(email);
    const credential = user ? await Credential.findOne({ email: user.email }) : null;
    const ok = await verifyPassword(password, credential?.passwordHash || (await decoy()));

    // One message for every failure, so this cannot be used to discover which
    // addresses are real or which have been set up yet.
    if (!user || !credential || !ok) {
      throttle.record(email);
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    throttle.clear(email);
    credential.lastLoginAt = new Date();
    await credential.save();

    res.cookie(SESSION_COOKIE, signSession(user, credential.mustChangePassword), cookieOptions());
    return res.json({
      email: user.email,
      role: user.role,
      regions: user.regions,
      mustChangePassword: credential.mustChangePassword,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    const credential = await Credential.findOne({ email: user.email });
    // No credential row means the account was revoked while signed in.
    if (!credential) return res.status(401).json({ error: 'Not signed in' });
    return res.json({
      email: user.email,
      role: user.role,
      regions: user.regions,
      mustChangePassword: credential.mustChangePassword,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/change-password', async (req, res, next) => {
  try {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < MIN_LENGTH) {
      return res.status(400).json({ error: `New password must be at least ${MIN_LENGTH} characters` });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different' });
    }

    const credential = await Credential.findOne({ email: user.email });
    if (!credential || !(await verifyPassword(currentPassword, credential.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    credential.passwordHash = await hashPassword(newPassword);
    credential.mustChangePassword = false;
    await credential.save();

    // Re-issue so the cookie lifetime restarts from the change.
    res.cookie(SESSION_COOKIE, signSession(user), cookieOptions());
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// Admin-only: mints a new random password and returns it exactly once, for the
// admin to hand over out of band. Never stored or logged in the clear.
router.post('/admin/reset-password', async (req, res, next) => {
  try {
    const actor = sessionUser(req);
    if (!actor) return res.status(401).json({ error: 'Not signed in' });
    if (actor.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const target = findUser(req.body?.email);
    if (!target) return res.status(404).json({ error: 'Unknown user' });

    const password = generatePassword();
    await Credential.findOneAndUpdate(
      { email: target.email },
      { $set: { passwordHash: await hashPassword(password), mustChangePassword: true } },
      { upsert: true },
    );
    // A reset is also how a locked-out person gets unstuck.
    throttle.clear(target.email);
    return res.json({ email: target.email, password });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  return res.status(204).end();
});

module.exports = router;
