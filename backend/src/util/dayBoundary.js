// Start-of-today (local midnight) in an IANA tz, returned as a UTC Date.
// Uses Intl to read the tz wall-clock; no external date library.
function startOfTodayInTz(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  const hour = parts.hour === '24' ? 0 : Number(parts.hour); // Intl may emit '24'
  // The same wall-clock reading interpreted as if it were UTC:
  const wallAsUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  // Offset between that and the real instant == the tz offset at `now`.
  const offset = wallAsUTC - Math.floor(now.getTime() / 1000) * 1000;
  // Midnight wall-clock (as UTC) minus the offset == real UTC instant of local midnight.
  const midnightWallAsUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0
  );
  return new Date(midnightWallAsUTC - offset);
}

module.exports = { startOfTodayInTz };
