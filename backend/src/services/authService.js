const jwt = require('jsonwebtoken');
const USERS = require('../config/users');

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_COOKIE = 'prospector_session';

// Read lazily so requiring this module never depends on env load order.
function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

// The user list is the allowlist: an address that is not in it can never sign
// in, whatever credentials or cookies exist elsewhere.
function findUser(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return USERS.find((u) => u.email.toLowerCase() === normalized) || null;
}

// `mc` marks a session opened with an admin-issued password. Carrying it in the
// token means the API can refuse those sessions without a database read on
// every request.
const signSession = (user, mustChangePassword = false) =>
  jwt.sign(
    { sub: user.email, ...(mustChangePassword ? { mc: 1 } : {}) },
    sessionSecret(),
    { expiresIn: SESSION_TTL_SECONDS },
  );

// Identity comes from the signature, then is re-checked against the user list so
// removing someone from config immediately invalidates their session.
function userFromSession(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, sessionSecret());
    const user = findUser(payload.sub);
    if (!user) return null;
    // Added only when set, so the ordinary shape of req.user is unchanged.
    return payload.mc ? { ...user, mustChangePassword: true } : user;
  } catch {
    return null;
  }
}

// Frontend and backend share a domain locally (both on `localhost`), where
// Lax is correct and Secure would block plain-http dev traffic. In
// production they're on different domains (Vercel/Render), so the cookie
// must be sendable cross-site — that requires SameSite=None, which browsers
// only honor when Secure is also set.
const cookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
};

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  findUser,
  signSession,
  userFromSession,
  cookieOptions,
};
