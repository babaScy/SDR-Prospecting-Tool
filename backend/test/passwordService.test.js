const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, generatePassword } = require('../src/services/passwordService');

test('a hash verifies against its own password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('a wrong password does not verify', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently each time (unique salt)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  // Both still verify, so the salt is stored with the hash.
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('the stored format records its parameters and no plaintext', async () => {
  const hash = await hashPassword('my-secret-password');
  const [scheme, n, r, p] = hash.split('$');
  assert.equal(scheme, 'scrypt');
  assert.equal(Number(n), 32768);
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
  assert.ok(!hash.includes('my-secret-password'));
});

test('malformed or empty stored values are refused, never treated as a match', async () => {
  for (const bad of ['', null, undefined, 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$x$y$z$q$w']) {
    assert.equal(await verifyPassword('anything', bad), false);
  }
});

test('generated passwords are long, unique, and free of look-alike characters', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const password = generatePassword();
    assert.equal(password.length, 16);
    assert.doesNotMatch(password, /[0O1lI]/, 'should omit ambiguous characters');
    assert.match(password, /^[a-zA-Z0-9]+$/);
    seen.add(password);
  }
  assert.equal(seen.size, 200, 'every generated password should be distinct');
});
