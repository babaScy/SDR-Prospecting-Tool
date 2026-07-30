const crypto = require('node:crypto');

// scrypt is in Node's standard library and memory-hard, so no bcrypt dependency
// and no native build step. Parameters are stored alongside each hash so they
// can be raised later without invalidating existing passwords.
const N = 32768; // CPU/memory cost
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_BYTES = 16;
// 128 * N * r is ~33MB here, above Node's 32MB default, so it must be raised.
const MAXMEM = 96 * 1024 * 1024;

// Omits look-alike characters so a password can be read aloud or retyped.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const derive = (password, salt, n, r, p) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      (err ? reject(err) : resolve(key)));
  });

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await derive(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
    // Lengths must match before timingSafeEqual, which throws otherwise.
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ~93 bits of entropy at 16 characters.
function generatePassword(length = 16) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    // Reject above the largest clean multiple to keep the distribution uniform.
    const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
    if (bytes[i] < limit) out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.length === length ? out : generatePassword(length);
}

const MIN_LENGTH = 12;

module.exports = { hashPassword, verifyPassword, generatePassword, MIN_LENGTH };
