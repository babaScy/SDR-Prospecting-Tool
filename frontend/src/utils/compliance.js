// Shared Yes/Not-confirmed -> badge label/class logic for the compliance
// signal, so LeadCard (card view) and ListTable (table view) render it
// identically.
export function complianceBadge(qualification) {
  const q = qualification || {};
  if (q.isCompliant === 'Yes') {
    return { compliant: true, label: `Compliant · ${q.frameworks || '—'}`, frameworks: q.frameworks || null };
  }
  return { compliant: false, label: 'Not confirmed', frameworks: null };
}
