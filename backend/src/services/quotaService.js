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

module.exports = { qualifiedToday, quotaReached };
