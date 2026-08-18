// A decision "disagrees" with the AI verdict when it goes the opposite way:
// rejecting a company the AI qualified, or accepting one it didn't.
export const disagreesWithVerdict = (decision, status) =>
  (decision === 'accepted' && status !== 'qualified') || (decision === 'rejected' && status === 'qualified');
