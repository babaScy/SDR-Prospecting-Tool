const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const db = require('./helpers/db');
const { sessionCookie } = require('./helpers/auth');
const List = require('../src/models/List');
const Company = require('../src/models/Company');
const Contact = require('../src/models/Contact');
const hubspotService = require('../src/services/hubspotService');
const app = require('../src/app');

before(async () => db.connect());
after(async () => db.disconnect());
beforeEach(async () => { await db.clear(); });

const asDavid = (req) => req.set('Cookie', sessionCookie('davidv@scytale.ai'));
const asKhadym = (req) => req.set('Cookie', sessionCookie('khadym@scytale.ai'));
const asAdmin = (req) => req.set('Cookie', sessionCookie('yonia@scytale.ai'));

const makeSetup = async () => {
  const list = await List.create({
    name: 'l', profile: 'icp1', region: 'uk', requestedCount: 1,
    assignedTo: 'davidv@scytale.ai', status: 'sourced',
  });
  const company = await Company.create({
    apolloAccountId: 'a1', companyName: 'Acme', website: 'https://acme.com',
    listId: list._id, status: 'qualified', sdrStatus: 'accepted', contactStatus: 'found',
  });
  const contact = await Contact.create({
    companyId: company._id, listId: list._id, apolloPersonId: 'p1',
    firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com', title: 'CTO', rank: 1,
  });
  return { list, company, contact };
};

test('404 for an unknown contact', async () => {
  const res = await asDavid(request(app).post(`/api/contacts/${new mongoose.Types.ObjectId()}/hubspot`));
  assert.equal(res.status, 404);
});

test('403 for a non-owning SDR', async () => {
  const { contact } = await makeSetup();
  const res = await asKhadym(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 403);
});

test('admin is not blocked by the SDR ownership check', async () => {
  const { contact } = await makeSetup(); // list is assigned to davidv@scytale.ai, not the admin
  hubspotService.pushContact = async () => ({ status: 'synced', hubspotContactId: 'hc-admin', hubspotCompanyId: 'co-admin' });
  const res = await asAdmin(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 200);
  assert.equal(res.body.hubspotStatus, 'synced');
  assert.equal(res.body.hubspotContactId, 'hc-admin');
});

test('400 when the contact has neither email nor LinkedIn — no push attempted', async () => {
  const { contact } = await makeSetup();
  contact.email = undefined;
  contact.linkedinUrl = undefined;
  await contact.save();
  let pushCalled = false;
  hubspotService.pushContact = async () => { pushCalled = true; return { status: 'synced', hubspotContactId: 'x', hubspotCompanyId: 'y' }; };
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No email or LinkedIn URL/);
  assert.equal(pushCalled, false);
  const saved = await Contact.findById(contact._id);
  assert.equal(saved.hubspotStatus, 'none');
});

test('successful push persists synced status and IDs', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => ({ status: 'synced', hubspotContactId: 'hc1', hubspotCompanyId: 'co1' });
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 200);
  assert.equal(res.body.hubspotStatus, 'synced');
  assert.equal(res.body.hubspotContactId, 'hc1');
  assert.equal(res.body.hubspotCompanyId, 'co1');
  assert.equal(res.body.hubspotSyncedBy, 'davidv@scytale.ai');
  assert.ok(res.body.hubspotSyncedAt);
});

test('already-existed push persists that status with no company id', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => ({ status: 'already_existed', hubspotContactId: 'hc-existing', hubspotCompanyId: null });
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 200);
  assert.equal(res.body.hubspotStatus, 'already_existed');
  assert.equal(res.body.hubspotContactId, 'hc-existing');
});

test('failed push persists the error and returns 502, leaving prior IDs untouched', async () => {
  const { contact } = await makeSetup();
  hubspotService.pushContact = async () => { throw new Error('No HubSpot user found for davidv@scytale.ai'); };
  const res = await asDavid(request(app).post(`/api/contacts/${contact._id}/hubspot`));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /No HubSpot user found/);
  const saved = await Contact.findById(contact._id);
  assert.equal(saved.hubspotStatus, 'failed');
  assert.equal(saved.hubspotError, 'No HubSpot user found for davidv@scytale.ai');
});
