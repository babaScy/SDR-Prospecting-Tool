/**
 * One-off lookup: Khady's benelux/icp2 list(s), for inspection.
 * Usage: node scripts/khadyListLookup.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const List = require('../src/models/List');

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'PROSPECTOR' });

  const lists = await List.find({
    region: 'benelux',
    profile: 'icp2',
    assignedTo: 'khadym@scytale.ai',
  }).sort({ createdAt: 1 }).lean();

  console.log(`Found ${lists.length} benelux/icp2 list(s) assigned to khadym@scytale.ai:\n`);
  for (const l of lists) {
    console.log(JSON.stringify({
      id: l._id.toString(),
      name: l.name,
      status: l.status,
      requestedCount: l.requestedCount,
      pulledCount: l.pulledCount,
      pullMode: l.pullMode,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      reviewConfirmedAt: l.reviewConfirmedAt,
      error: l.error,
      lastMessage: l.lastMessage,
    }, null, 2));
    console.log('---');
  }

  await mongoose.disconnect();
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
