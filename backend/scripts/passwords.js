#!/usr/bin/env node
// Provisions and resets sign-in passwords. Generated passwords are printed once
// and never stored in the clear — if you lose one, reset it.
//
//   node scripts/passwords.js init            # create for anyone missing one
//   node scripts/passwords.js reset <email>   # new password for one person
//   node scripts/passwords.js reset-all       # new password for everyone
//   node scripts/passwords.js list            # who is set up (no secrets)

require('dotenv').config();
const mongoose = require('mongoose');
const USERS = require('../src/config/users');
const Credential = require('../src/models/Credential');
const { hashPassword, generatePassword } = require('../src/services/passwordService');

const [command, arg] = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/passwords.js <init|reset <email>|reset-all|list>');
  process.exit(1);
}

async function issue(email) {
  const password = generatePassword();
  await Credential.findOneAndUpdate(
    { email },
    { $set: { passwordHash: await hashPassword(password), mustChangePassword: true } },
    { upsert: true, new: true },
  );
  return password;
}

function printTable(rows) {
  if (!rows.length) return;
  const width = Math.max(...rows.map((r) => r.email.length));
  console.log('');
  console.log(`${'EMAIL'.padEnd(width)}  PASSWORD`);
  console.log(`${'-'.repeat(width)}  ${'-'.repeat(18)}`);
  rows.forEach((r) => console.log(`${r.email.padEnd(width)}  ${r.password}`));
  console.log('');
  console.log('Hand these over via 1Password or a Slack DM. Each person is forced to');
  console.log('choose their own password on first sign-in, which retires the one above.');
  console.log('This output is the only copy — it is not recoverable.');
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  if (command === 'init') {
    const existing = new Set((await Credential.find({}, 'email')).map((c) => c.email));
    const missing = USERS.filter((u) => !existing.has(u.email));
    if (!missing.length) {
      console.log('Every user already has a password. Use "reset <email>" to issue a new one.');
      return;
    }
    const rows = [];
    for (const user of missing) {
      rows.push({ email: user.email, password: await issue(user.email) });
    }
    console.log(`Created ${rows.length} password(s); left ${existing.size} existing one(s) untouched.`);
    printTable(rows);
    return;
  }

  if (command === 'reset-all') {
    const rows = [];
    for (const user of USERS) {
      rows.push({ email: user.email, password: await issue(user.email) });
    }
    console.log(`Reset ${rows.length} password(s). Everyone must sign in again with the new one.`);
    printTable(rows);
    return;
  }

  if (command === 'reset') {
    if (!arg) usage();
    const user = USERS.find((u) => u.email.toLowerCase() === arg.trim().toLowerCase());
    if (!user) {
      console.error(`${arg} is not in src/config/users.js, so it cannot sign in.`);
      process.exit(1);
    }
    printTable([{ email: user.email, password: await issue(user.email) }]);
    return;
  }

  if (command === 'list') {
    const credentials = await Credential.find({});
    const byEmail = new Map(credentials.map((c) => [c.email, c]));
    const width = Math.max(...USERS.map((u) => u.email.length));
    console.log(`${'EMAIL'.padEnd(width)}  ROLE   STATUS`);
    USERS.forEach((u) => {
      const c = byEmail.get(u.email);
      const status = !c
        ? 'no password yet'
        : c.mustChangePassword
          ? 'must change on next sign-in'
          : `own password${c.lastLoginAt ? ` · last in ${c.lastLoginAt.toISOString().slice(0, 10)}` : ''}`;
      console.log(`${u.email.padEnd(width)}  ${u.role.padEnd(5)}  ${status}`);
    });
    // A row here with no user in config is dead weight and cannot sign in.
    const orphans = credentials.filter((c) => !USERS.some((u) => u.email === c.email));
    if (orphans.length) {
      console.log(`\n${orphans.length} credential(s) for people no longer in users.js (cannot sign in):`);
      orphans.forEach((c) => console.log(`  ${c.email}`));
    }
    return;
  }

  usage();
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
