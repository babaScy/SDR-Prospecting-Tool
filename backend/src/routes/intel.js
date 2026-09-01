const express = require('express');
const IntelEvent = require('../models/IntelEvent');

const router = express.Router();

// The frontend's own field names (matches framework-intel's events.json)
// rather than Mongoose's _id/eventId — the sync payload and the read shape
// are the same wire format, so re-syncing and re-fetching round-trip cleanly.
function serialize(doc) {
  return {
    id: doc.eventId,
    sourceId: doc.sourceId,
    tier: doc.tier,
    sourceUrl: doc.sourceUrl,
    fetchedAt: doc.fetchedAt,
    changeType: doc.changeType,
    frameworks: doc.frameworks,
    regions: doc.regions,
    whatsHappening: doc.whatsHappening,
    talkingPoint: doc.talkingPoint,
    outreachWorthy: doc.outreachWorthy,
    whoToTarget: doc.whoToTarget,
    confidence: doc.confidence,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const docs = await IntelEvent.find().sort({ fetchedAt: -1 });
    res.json(docs.map(serialize));
  } catch (err) {
    next(err);
  }
});

const REQUIRED_FIELDS = ['id', 'sourceId', 'tier', 'sourceUrl', 'fetchedAt', 'changeType', 'whatsHappening'];

function validEvent(e) {
  return (
    !!e &&
    typeof e === 'object' &&
    REQUIRED_FIELDS.every((f) => e[f] !== undefined && e[f] !== null && e[f] !== '') &&
    ['primary', 'watch'].includes(e.tier) &&
    (e.frameworks === undefined || Array.isArray(e.frameworks)) &&
    (e.regions === undefined || Array.isArray(e.regions))
  );
}

// Called by framework-intel's sync script after a pipeline run — pushes its
// whole events.json log. Upserted by id, so re-syncing is idempotent and this
// collection stays a mirror, not a second store to keep in sync by hand.
router.post('/sync', async (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events must be a non-empty array' });
  }
  const bad = events.find((e) => !validEvent(e));
  if (bad) {
    return res.status(400).json({ error: `event ${bad?.id || '(no id)'} is missing required fields` });
  }

  try {
    for (const e of events) {
      await IntelEvent.findOneAndUpdate(
        { eventId: e.id },
        {
          $set: {
            sourceId: e.sourceId,
            tier: e.tier,
            sourceUrl: e.sourceUrl,
            fetchedAt: new Date(e.fetchedAt),
            changeType: e.changeType,
            frameworks: e.frameworks || [],
            regions: e.regions || [],
            whatsHappening: e.whatsHappening,
            talkingPoint: e.talkingPoint || '',
            outreachWorthy: !!e.outreachWorthy,
            whoToTarget: e.whoToTarget || '',
            confidence: e.confidence || '',
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
    res.json({ upserted: events.length, total: await IntelEvent.countDocuments() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
