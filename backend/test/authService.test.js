const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cookieOptions } = require('../src/services/authService');

// Frontend (Vercel) and backend (Render) live on different domains in
// production, so the session cookie must be sendable cross-site there —
// locally frontend/backend share `localhost`, where Lax is correct and
// Secure would block http:// dev traffic entirely.
function withNodeEnv(value, fn) {
  const prev = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

test('cookieOptions is SameSite=Lax, non-Secure outside production (same-site local dev)', () => {
  withNodeEnv(undefined, () => {
    const opts = cookieOptions();
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.secure, false);
  });
});

test('cookieOptions is SameSite=None + Secure in production (cross-site frontend/backend)', () => {
  withNodeEnv('production', () => {
    const opts = cookieOptions();
    assert.equal(opts.sameSite, 'none');
    assert.equal(opts.secure, true);
  });
});
