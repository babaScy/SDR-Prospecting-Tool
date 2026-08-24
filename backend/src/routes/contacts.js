const express = require('express');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Company = require('../models/Company');
const List = require('../models/List');
const hubspotService = require('../services/hubspotService');

const router = express.Router();

router.post('/:id/hubspot', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Contact not found' });
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const company = await Company.findById(contact.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const list = await List.findById(contact.listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (req.user.role !== 'admin' && list.assignedTo !== req.user.email) {
      return res.status(403).json({ error: 'Not your list' });
    }

    if (!contact.email && !contact.linkedinUrl) {
      return res.status(400).json({ error: 'No email or LinkedIn URL on this contact — cannot safely dedupe in HubSpot' });
    }

    let result;
    try {
      result = await hubspotService.pushContact(company, contact, list.assignedTo);
    } catch (err) {
      console.error(`[hubspot] push failed for contact ${contact._id}: ${err.message}`);
      contact.hubspotStatus = 'failed';
      contact.hubspotError = err.message;
      await contact.save();
      return res.status(502).json({ error: err.message });
    }

    contact.hubspotStatus = result.status;
    contact.hubspotContactId = result.hubspotContactId;
    if (result.hubspotCompanyId) contact.hubspotCompanyId = result.hubspotCompanyId;
    contact.hubspotSyncedAt = new Date();
    contact.hubspotSyncedBy = req.user.email;
    contact.hubspotError = undefined;
    await contact.save();
    return res.json(contact);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
