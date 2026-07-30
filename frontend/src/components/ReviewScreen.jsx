import { useEffect, useState } from 'react';
import { fetchLeads, sendDecision, confirmReview } from '../api';
import { IconCheck, IconX, IconUndo, IconArrowLeft } from '../icons';
import LeadCard from './LeadCard';
import { hasUsableDomain } from '../utils/companyLink';

const BUCKETS = ['qualified', 'nei', 'disqualified'];

const BUCKET_LABELS = { qualified: 'Qualified', nei: 'Not enough information', disqualified: 'Disqualified' };

export default function ReviewScreen({ listId, onBack, onReviewConfirmed }) {
  const [queue, setQueue] = useState(null); // pending leads, bucket order
  const [done, setDone] = useState([]); // [{ lead, decision }]
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState('');

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
        <button className="btn ghost" onClick={onBack}><IconArrowLeft /> Lists</button>
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
    const doConfirm = async () => {
      setConfirmError('');
      try {
        await confirmReview(listId);
        setConfirmed(true);
        onReviewConfirmed?.(); // parent switches to Contacts view
      } catch (err) {
        setConfirmError(err.message);
      }
    };
    return (
      <div className="panel">
        <h2>Review complete 🎉</h2>
        {error && <p className="error">{error}</p>}
        <div className="stat-row">
          <div className="stat-card tone-green"><div className="dot" /><div><div className="num">{accepted}</div><div className="label">accepted</div></div></div>
          <div className="stat-card tone-neutral"><div className="dot" /><div><div className="num">{rejected}</div><div className="label">rejected</div></div></div>
        </div>
        <div className="modal-note">
          {accepted > 0
            ? `Confirm to lock these decisions and find contacts for the ${accepted} accepted ${accepted === 1 ? 'company' : 'companies'}.`
            : 'No accepted leads to source. Confirming just finalizes this list.'}
        </div>
        {confirmError && <p className="error">{confirmError}</p>}
        <div className="decision-row">
          <button className="btn ghost" onClick={undo} disabled={busy || !done.length || confirmed}><IconUndo /> Undo last</button>
          <button className="btn accept" onClick={doConfirm} disabled={confirmed}><IconCheck /> Confirm list review</button>
        </div>
      </div>
    );
  }

  const total = queue.length + done.length;
  const bucketRemaining = queue.filter((l) => l.status === current.status).length;
  // Mirrors the backend rule: no usable domain means contacts can't be sourced,
  // so accepting is refused (409). Keep the two in sync.
  const noDomain = !hasUsableDomain(current.website);

  return (
    <div>
      <div className="panel">
        <div className="decision-row" style={{ marginTop: 0, justifyContent: 'space-between' }}>
          <button className="btn ghost small" onClick={onBack}><IconArrowLeft /> Lists</button>
          <span className="muted">
            Bucket: <strong>{BUCKET_LABELS[current.status]}</strong> ({bucketRemaining} left) · {done.length}/{total} reviewed
          </span>
        </div>
        <div className="progress-bar"><div style={{ width: `${total ? (done.length / total) * 100 : 0}%` }} /></div>
        <LeadCard lead={current} />
        {noDomain && (
          <p className="muted">
            Apollo has no website domain for this company, so no contacts can be found for it — it can only be rejected.
          </p>
        )}
        <div className="decision-row">
          <button
            className="btn accept big"
            onClick={() => decide('accepted')}
            disabled={busy || noDomain}
            title={noDomain ? 'No domain on Apollo — contacts cannot be sourced' : undefined}
          >
            <IconCheck /> Accept
          </button>
          <button className="btn reject big" onClick={() => decide('rejected')} disabled={busy}><IconX /> Reject</button>
          <button className="btn ghost" onClick={undo} disabled={busy || !done.length}><IconUndo /> Undo last</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
