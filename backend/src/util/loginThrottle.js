// Sliding-window lockout to slow password guessing. Deliberately its own module
// so the state can be inspected and cleared, rather than hiding in a route file
// where nothing can reach it.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map();

const recent = (email, now) => (attempts.get(email) || []).filter((t) => now - t < WINDOW_MS);

function isLocked(email) {
  const now = Date.now();
  const hits = recent(email, now);
  if (hits.length) attempts.set(email, hits);
  else attempts.delete(email);
  return hits.length >= MAX_ATTEMPTS;
}

function record(email) {
  const hits = recent(email, Date.now());
  hits.push(Date.now());
  attempts.set(email, hits);
}

// Called on a successful sign-in and on an admin reset, so a locked-out person
// can be helped rather than having to wait out the window.
const clear = (email) => attempts.delete(email);

const reset = () => attempts.clear();

module.exports = { isLocked, record, clear, reset, WINDOW_MS, MAX_ATTEMPTS };
