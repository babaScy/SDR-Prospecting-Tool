const express = require('express');
const ObjectionInteraction = require('../models/ObjectionInteraction');

const router = express.Router();

async function netScoreFor(objection, boxTitle) {
  const [row] = await ObjectionInteraction.aggregate([
    { $match: { objection, boxTitle } },
    { $group: { _id: null, netScore: { $sum: '$vote' } } },
  ]);
  return row?.netScore ?? 0;
}

function validObjectionKey(objection, boxTitle) {
  return (
    typeof objection === 'string' &&
    typeof boxTitle === 'string' &&
    !!objection.trim() &&
    !!boxTitle.trim()
  );
}

router.get('/', async (req, res, next) => {
  try {
    const scores = await ObjectionInteraction.aggregate([
      { $group: { _id: { objection: '$objection', boxTitle: '$boxTitle' }, netScore: { $sum: '$vote' } } },
    ]);
    const mine = await ObjectionInteraction.find({ userEmail: req.user.email });
    const mineByKey = new Map(mine.map((m) => [`${m.objection}||${m.boxTitle}`, m]));

    const rows = scores.map(({ _id, netScore }) => {
      const mineRow = mineByKey.get(`${_id.objection}||${_id.boxTitle}`);
      return {
        objection: _id.objection,
        boxTitle: _id.boxTitle,
        netScore,
        myVote: mineRow?.vote ?? 0,
        myStarred: mineRow?.starred ?? false,
      };
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/star', async (req, res, next) => {
  try {
    const { objection, boxTitle } = req.body || {};
    if (!validObjectionKey(objection, boxTitle)) {
      return res.status(400).json({ error: 'objection and boxTitle are required' });
    }

    const existing = await ObjectionInteraction.findOne({ objection, boxTitle, userEmail: req.user.email });
    const doc = await ObjectionInteraction.findOneAndUpdate(
      { objection, boxTitle, userEmail: req.user.email },
      { $set: { starred: !existing?.starred } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const netScore = await netScoreFor(objection, boxTitle);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});

router.post('/vote', async (req, res, next) => {
  try {
    const { objection, boxTitle, value } = req.body || {};
    if (!validObjectionKey(objection, boxTitle)) {
      return res.status(400).json({ error: 'objection and boxTitle are required' });
    }
    if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });

    const existing = await ObjectionInteraction.findOne({ objection, boxTitle, userEmail: req.user.email });
    const newVote = existing?.vote === value ? 0 : value;
    const doc = await ObjectionInteraction.findOneAndUpdate(
      { objection, boxTitle, userEmail: req.user.email },
      { $set: { vote: newVote } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const netScore = await netScoreFor(objection, boxTitle);
    res.json({ objection, boxTitle, netScore, myVote: doc.vote, myStarred: doc.starred });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
