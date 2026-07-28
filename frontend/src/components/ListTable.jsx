import { useEffect, useMemo, useState } from 'react';
import { fetchLeads, sendDecision } from '../api';
import { IconCheck, IconX, IconUndo, IconChevronUp, IconChevronDown } from '../icons';

const VERDICT_LABELS = { qualified: 'Qualified', nei: 'Not enough information', disqualified: 'Disqualified', pending: 'Pending' };
const SDR_LABELS = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected' };

const COLUMNS = [
  { key: 'companyName', label: 'Name' },
  { key: 'employees', label: 'Employees' },
  { key: 'country', label: 'Country' },
  { key: 'status', label: 'AI Verdict' },
  { key: 'sdrStatus', label: 'SDR Status' },
];

function compare(a, b, key) {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv));
}

export default function ListTable({ listId }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('all');
  const [sdrFilter, setSdrFilter] = useState('all');
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    fetchLeads(listId)
      .then((data) => {
        setLeads(data);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [listId]);

  const rows = useMemo(() => {
    if (!leads) return [];
    let out = leads;
    if (verdictFilter !== 'all') out = out.filter((l) => l.status === verdictFilter);
    if (sdrFilter !== 'all') out = out.filter((l) => l.sdrStatus === sdrFilter);
    if (sort.key) out = [...out].sort((a, b) => sort.dir * compare(a, b, sort.key));
    return out;
  }, [leads, verdictFilter, sdrFilter, sort]);

  const toggleSort = (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: -prev.dir } : { key, dir: 1 }));
  };

  const decide = async (lead, decision) => {
    setBusyId(lead._id);
    setError('');
    try {
      const updated = await sendDecision(lead._id, decision);
      setLeads((prev) => prev.map((l) => (l._id === lead._id ? { ...l, sdrStatus: updated.sdrStatus } : l)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (error && !leads) return <p className="error">{error}</p>;
  if (!leads) return <p className="muted">Loading…</p>;

  return (
    <div className="panel">
      <div className="form-row" style={{ marginBottom: 12 }}>
        <label>
          AI Verdict
          <select value={verdictFilter} onChange={(e) => setVerdictFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="qualified">Qualified</option>
            <option value="nei">Not enough information</option>
            <option value="disqualified">Disqualified</option>
            <option value="pending">Pending (AI)</option>
          </select>
        </label>
        <label>
          SDR Status
          <select value={sdrFilter} onChange={(e) => setSdrFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!rows.length ? (
        <p className="muted">No companies match these filters.</p>
      ) : (
        <table className="table-plain">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} className="sortable" onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sort.key === col.key && (
                    <span className="sort-icon">{sort.dir === 1 ? <IconChevronUp /> : <IconChevronDown />}</span>
                  )}
                </th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => (
              <tr key={lead._id}>
                <td>{lead.companyName}</td>
                <td>{lead.employees ?? '—'}</td>
                <td>{lead.country || '—'}</td>
                <td><span className={`badge ${lead.status}`}>{VERDICT_LABELS[lead.status] || lead.status}</span></td>
                <td><span className={`badge ${lead.sdrStatus}`}>{SDR_LABELS[lead.sdrStatus] || lead.sdrStatus}</span></td>
                <td>
                  {lead.sdrStatus === 'pending' ? (
                    <div className="decision-row" style={{ margin: 0 }}>
                      <button className="btn accept small" onClick={() => decide(lead, 'accepted')} disabled={busyId === lead._id}>
                        <IconCheck /> Accept
                      </button>
                      <button className="btn reject small" onClick={() => decide(lead, 'rejected')} disabled={busyId === lead._id}>
                        <IconX /> Reject
                      </button>
                    </div>
                  ) : (
                    <button className="btn ghost small" onClick={() => decide(lead, 'pending')} disabled={busyId === lead._id}>
                      <IconUndo /> Undo
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
