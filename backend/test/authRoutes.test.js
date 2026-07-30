const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const Credential = require('../src/models/Credential');
const { hashPassword } = require('../src/services/passwordService');
const throttle = require('../src/util/loginThrottle');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
// The lockout is process-wide, so it has to be cleared between tests or the
// throttle test would leave later sign-ins locked out.
beforeEach(async () => {
  await db.clear();
  throttle.reset();
});

const SDR = 'davidv@scytale.ai';
const OTHER_SDR = 'khadym@scytale.ai';
const ADMIN = 'yonia@scytale.ai';
const PASSWORD = 'a-perfectly-fine-password';

async function seedCredential(email, password = PASSWORD, mustChangePassword = false) {
  return Credential.create({ email, passwordHash: await hashPassword(password), mustChangePassword });
}

const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

test('correct credentials return the user and set a session cookie', async () => {
  await seedCredential(SDR);
  const res = await login(SDR, PASSWORD);
  assert.equal(res.status, 200);
  assert.equal(res.body.email, SDR);
  assert.equal(res.body.role, 'sdr');
  const cookie = res.headers['set-cookie'].join(';');
  assert.match(cookie, /prospector_session=/);
  assert.match(cookie, /HttpOnly/i);
});

test('the session from a login identifies that user on real endpoints', async () => {
  await seedCredential(SDR);
  const res = await login(SDR, PASSWORD);
  const me = await request(app).get('/api/auth/me').set('Cookie', res.headers['set-cookie']);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, SDR);
});

test('a wrong password is refused and sets no cookie', async () => {
  await seedCredential(SDR);
  const res = await login(SDR, 'not-the-password');
  assert.equal(res.status, 401);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('an unknown address and a wrong password are indistinguishable', async () => {
  await seedCredential(SDR);
  const wrongPassword = await login(SDR, 'nope');
  const notAUser = await login('stranger@example.com', 'nope');
  const noCredentialYet = await login(OTHER_SDR, 'nope');
  assert.equal(wrongPassword.status, 401);
  assert.equal(notAUser.status, 401);
  assert.equal(noCredentialYet.status, 401);
  // Identical wording, so the endpoint reveals nothing about who exists.
  assert.equal(wrongPassword.body.error, notAUser.body.error);
  assert.equal(wrongPassword.body.error, noCredentialYet.body.error);
});

test('a user in config with no password row cannot sign in', async () => {
  const res = await login(OTHER_SDR, PASSWORD);
  assert.equal(res.status, 401);
});

test('an address absent from users.js cannot sign in even with a credential row', async () => {
  await seedCredential('ghost@scytale.ai');
  const res = await login('ghost@scytale.ai', PASSWORD);
  assert.equal(res.status, 401);
});

test('missing fields are a 400', async () => {
  assert.equal((await login(SDR, '')).status, 400);
  assert.equal((await login('', PASSWORD)).status, 400);
});

test('repeated failures are throttled', async () => {
  await seedCredential(SDR);
  for (let i = 0; i < 10; i += 1) await login(SDR, 'wrong');
  const blocked = await login(SDR, 'wrong');
  assert.equal(blocked.status, 429);
  // Still throttled even once the password is right, so guessing cannot continue.
  const correct = await login(SDR, PASSWORD);
  assert.equal(correct.status, 429);
});

test('a successful sign-in clears earlier failures', async () => {
  await seedCredential(SDR);
  for (let i = 0; i < 9; i += 1) await login(SDR, 'wrong');
  assert.equal((await login(SDR, PASSWORD)).status, 200);
  // The counter reset, so a fresh run of failures is needed to lock out again.
  for (let i = 0; i < 9; i += 1) await login(SDR, 'wrong');
  assert.equal((await login(SDR, PASSWORD)).status, 200);
});

test('an admin reset unlocks someone who is locked out', async () => {
  await seedCredential(ADMIN);
  await seedCredential(SDR);
  const session = (await login(ADMIN, PASSWORD)).headers['set-cookie'];
  for (let i = 0; i < 10; i += 1) await login(SDR, 'wrong');
  assert.equal((await login(SDR, PASSWORD)).status, 429);

  const reset = await request(app).post('/api/auth/admin/reset-password')
    .set('Cookie', session).send({ email: SDR });
  assert.equal(reset.status, 200);
  assert.equal((await login(SDR, reset.body.password)).status, 200);
});

test('mustChangePassword is reported so the UI can force a change', async () => {
  await seedCredential(SDR, PASSWORD, true);
  const res = await login(SDR, PASSWORD);
  assert.equal(res.body.mustChangePassword, true);
});

test('an admin-issued password cannot reach the API before it is changed', async () => {
  await seedCredential(SDR, PASSWORD, true);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];
  // The UI gate is not the only gate — the API refuses this session too.
  const blocked = await request(app).get('/api/lists').set('Cookie', session);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /Password change required/);

  await request(app).post('/api/auth/change-password').set('Cookie', session)
    .send({ currentPassword: PASSWORD, newPassword: 'now-my-own-password' });
  const after = (await login(SDR, 'now-my-own-password')).headers['set-cookie'];
  assert.equal((await request(app).get('/api/lists').set('Cookie', after)).status, 200);
});

test('changing a password clears the flag and swaps the credential', async () => {
  await seedCredential(SDR, PASSWORD, true);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];

  const changed = await request(app)
    .post('/api/auth/change-password')
    .set('Cookie', session)
    .send({ currentPassword: PASSWORD, newPassword: 'my-own-chosen-password' });
  assert.equal(changed.status, 204);

  assert.equal((await login(SDR, PASSWORD)).status, 401, 'the old password should stop working');
  const fresh = await login(SDR, 'my-own-chosen-password');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.mustChangePassword, false);
});

test('changing a password requires the current one', async () => {
  await seedCredential(SDR);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];
  const res = await request(app)
    .post('/api/auth/change-password')
    .set('Cookie', session)
    .send({ currentPassword: 'guessing', newPassword: 'a-brand-new-password' });
  assert.equal(res.status, 401);
  assert.equal((await login(SDR, PASSWORD)).status, 200, 'the real password should be unchanged');
});

test('short or unchanged new passwords are refused', async () => {
  await seedCredential(SDR);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];
  const short = await request(app).post('/api/auth/change-password').set('Cookie', session)
    .send({ currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(short.status, 400);
  const same = await request(app).post('/api/auth/change-password').set('Cookie', session)
    .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
  assert.equal(same.status, 400);
});

test('changing a password needs a session', async () => {
  const res = await request(app).post('/api/auth/change-password')
    .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
  assert.equal(res.status, 401);
});

test('an admin can reset someone and gets the new password once', async () => {
  await seedCredential(ADMIN);
  await seedCredential(SDR);
  const session = (await login(ADMIN, PASSWORD)).headers['set-cookie'];

  const res = await request(app).post('/api/auth/admin/reset-password')
    .set('Cookie', session).send({ email: SDR });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, SDR);
  assert.equal(res.body.password.length, 16);

  assert.equal((await login(SDR, PASSWORD)).status, 401, 'the old password should be revoked');
  const fresh = await login(SDR, res.body.password);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.mustChangePassword, true);
});

test('an sdr cannot reset anyone', async () => {
  await seedCredential(SDR);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];
  const res = await request(app).post('/api/auth/admin/reset-password')
    .set('Cookie', session).send({ email: OTHER_SDR });
  assert.equal(res.status, 403);
});

test('resetting an unknown address is a 404', async () => {
  await seedCredential(ADMIN);
  const session = (await login(ADMIN, PASSWORD)).headers['set-cookie'];
  const res = await request(app).post('/api/auth/admin/reset-password')
    .set('Cookie', session).send({ email: 'stranger@example.com' });
  assert.equal(res.status, 404);
});

test('/me is a 401 without a session', async () => {
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
});

test('a signed session whose credential row is gone is rejected', async () => {
  // Covers revoking access by deleting the credential while someone is signed in.
  const res = await request(app).get('/api/auth/me').set('Cookie', sessionCookie(SDR));
  assert.equal(res.status, 401);
});

test('logout clears the session', async () => {
  await seedCredential(SDR);
  const session = (await login(SDR, PASSWORD)).headers['set-cookie'];
  const out = await request(app).post('/api/auth/logout').set('Cookie', session);
  assert.equal(out.status, 204);
  assert.match(out.headers['set-cookie'].join(';'), /prospector_session=;/);
});
