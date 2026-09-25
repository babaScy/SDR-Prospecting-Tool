// Minimal CSV parser shared by scripts that round-trip writeCsv() output
// from hubspotGapReport.js (comma-separated, "-quoted when a field has a
// comma/quote/newline, "" for an escaped quote). Split out on its own so
// tagWolfProspects.js and checkCompanyContactCoverage.js can both use it
// without requiring each other.
const fs = require('fs');

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const parseLine = (line) => {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  };
  const [headerLine, ...lines] = text.split('\n');
  const headers = parseLine(headerLine);
  return lines.map((line) => Object.fromEntries(headers.map((h, i) => [h, parseLine(line)[i]])));
}

module.exports = { parseCsv };
