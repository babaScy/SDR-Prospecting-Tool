import { useEffect, useState } from 'react';
import { fetchLeads, sendDecision } from '../api';
import LeadCard from './LeadCard';

const BUCKETS = ['qualified', 'nei', 'disqualified'];
const BUCKET_LABELS = { qualified: 'Qualified', nei: 'Not enough information', disqualified: 'Disqualified' };

export default function ReviewScreen({ listId, onBack }) {
  const [queue, setQueue] = useState(null); // pending leads, bucket order
  const [done, setDone] = useState([]); // [{ lead, decision }]
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all(BUCKETS.map((bucket) => fetchLeads(listId, bucket)))
      .then((buckets) => {
        const all = buckets.flat();
        setQueue(all.filter((l) => l.sdrStatus === 'pending'));
        setDone(all.filter((l) => l.sdrStatus !== 'pending').map((lead) => ({ lead, decision: lead.sdrStatus })));
      })
      .catch((err) => setError(err.message));
  }, [listId]);

  if (error && !queue) {
    return (
      <div className="panel">
        <p className="error">{error}</p>
        <button className="btn ghost" onClick={onBack}>← Lists</button>
      </div>
    );
  }
  if (!queue) return <p className="muted">Loading…</p>;

  const current = queue[0];

  const decide = async (decision) => {
    setBusy(true);
    setError('');
    try {
      await sendDecision(current._id, decision);
      setDone([...done, { lead: current, decision }]);
      setQueue(queue.slice(1));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    const last = done[done.length - 1];
    if (!last) return;
    setBusy(true);
    setError('');
    try {
      await sendDecision(last.lead._id, 'pending');
      setDone(done.slice(0, -1));
      setQueue([{ ...last.lead, sdrStatus: 'pending' }, ...queue]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!current) {
    const accepted = done.filter((d) => d.decision === 'accepted').length;
    const rejected = done.filter((d) => d.decision === 'rejected').length;
    return (
      <div className="panel">
        <h2>Review complete 🎉</h2>
        {error && <p className="error">{error}</p>}
        <div className="stat-row">
          <div className="stat"><span className="num">{accepted}</span><span className="label">accepted</span></div>
          <div className="stat"><span className="num">{rejected}</span><span className="label">rejected</span></div>
        </div>
        <div className="decision-row">
          <button className="btn ghost" onClick={undo} disabled={busy || !done.length}>Undo last</button>
          <button className="btn" onClick={onBack}>Back to lists</button>
        </div>
      </div>
    );
  }

  const total = queue.length + done.length;
  const bucketRemaining = queue.filter((l) => l.status === current.status).length;

  return (
    <div>
      <div className="panel">
        <div className="decision-row" style={{ marginTop: 0, justifyContent: 'space-between' }}>
          <button className="btn ghost" onClick={onBack}>← Lists</button>
          <span className="muted">
            Bucket: <strong>{BUCKET_LABELS[current.status]}</strong> ({bucketRemaining} left) · {done.length}/{total} reviewed
          </span>
        </div>
        <div className="progress-bar"><div style={{ width: `${total ? (done.length / total) * 100 : 0}%` }} /></div>
        <LeadCard lead={current} />
        <div className="decision-row">
          <button className="btn accept big" onClick={() => decide('accepted')} disabled={busy}>✓ Accept</button>
          <button className="btn reject big" onClick={() => decide('rejected')} disabled={busy}>✕ Reject</button>
          <button className="btn ghost" onClick={undo} disabled={busy || !done.length}>Undo last</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
