// Tests authenticate exactly the way the browser does — a real signed session
// cookie — so there is no test-only path around the guard.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const { SESSION_COOKIE, signSession } = require('../../src/services/authService');

// Signs for whatever address is given, including ones absent from the user list,
// so tests can prove an unknown-but-validly-signed session is still rejected.
const sessionCookie = (email) => `${SESSION_COOKIE}=${signSession({ email })}`;

module.exports = { sessionCookie };
