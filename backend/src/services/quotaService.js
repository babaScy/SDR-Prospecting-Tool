const List = require('../models/List');
const Company = require('../models/Company');
const { startOfTodayInTz } = require('../util/dayBoundary');
const { RESET_TZ, DAILY_QUALIFIED_QUOTA } = require('../config/pullConfig');

async function qualifiedToday(sdrEmail, now = new Date()) {
  const listIds = await List.find({ assignedTo: sdrEmail }).distinct('_id');
  if (listIds.length === 0) return 0;
  return Company.countDocuments({
    listId: { $in: listIds },
    status: 'qualified',
    createdAt: { $gte: startOfTodayInTz(RESET_TZ, now) },
  });
}

async function quotaReached(sdrEmail, now = new Date()) {
  return (await qualifiedToday(sdrEmail, now)) >= DAILY_QUALIFIED_QUOTA;
}

// A hard, unconditional backstop: one self-serve pull per SDR per day, no
// matter how it turned out (short of quota, failed, still running). This is
// independent of qualifiedToday — quotaReached alone isn't a safe gate, since
// a pull can legitimately end below quota (pool exhaustion) or on a bug we
// haven't found yet, and either way the SDR should still wait for tomorrow
// rather than being able to launch another full pull.
async function pulledToday(sdrEmail, now = new Date()) {
  return Boolean(
    await List.exists({
      assignedTo: sdrEmail,
      pullMode: 'quota',
      createdAt: { $gte: startOfTodayInTz(RESET_TZ, now) },
    })
  );
}

module.exports = { qualifiedToday, quotaReached, pulledToday };
