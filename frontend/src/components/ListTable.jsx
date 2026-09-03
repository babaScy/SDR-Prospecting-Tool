import { useEffect, useMemo, useState } from 'react';
import { fetchLeads, sendDecision, bulkReject } from '../api';
import { IconCheck, IconX, IconUndo, IconChevronUp, IconChevronDown } from '../icons';
import { getCompanyHref, hasUsableDomain } from '../utils/companyLink';
import { complianceBadge } from '../utils/compliance';
import { disagreesWithVerdict } from '../utils/verdict';

const VERDICT_LABELS = { qualified: 'Qualified', nei: 'Not enough information', disqualified: 'Disqualified', pending: 'Pending' };
const SDR_LABELS = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected' };

// 'Compliance' is rendered between 'country' and 'status' below but left
// out of COLUMNS (which drives the sortable headers) since a badge + a
// free-text framework list has no natural sort order — same treatment as
// the unsorted 'Actions' column.
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

export default function ListTable({ listId, onDecision }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('all');
  const [sdrFilter, setSdrFilter] = useState('all');
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [override, setOverride] = useState(null); // { lead, decision } | null
  const [overrideComment, setOverrideComment] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

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

  // Selection only ever covers pending rows (the only ones a Reject action
  // applies to) — clear it whenever the filters change so it can't silently
  // hold ids the SDR can no longer see.
  useEffect(() => setSelected(new Set()), [verdictFilter, sdrFilter]);

  const pendingRows = useMemo(() => rows.filter((l) => l.sdrStatus === 'pending'), [rows]);
  const allSelected = pendingRows.length > 0 && pendingRows.every((l) => selected.has(l._id));

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(pendingRows.map((l) => l._id)));
  };

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitBulkReject = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkBusy(true);
    setError('');
    try {
      await bulkReject(listId, ids);
      // Refetch rather than optimistically patch: a selected row could have
      // been individually decided (via its own row action) in between being
      // checked and the bulk submit — the backend correctly leaves it alone,
      // and only a refetch is guaranteed to match that exactly.
      setLeads(await fetchLeads(listId));
      setSelected(new Set());
      onDecision?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const submitDecision = async (lead, decision, comment) => {
    setBusyIds((prev) => new Set(prev).add(lead._id));
    setError('');
    try {
      const updated = await sendDecision(lead._id, decision, comment);
      setLeads((prev) => prev.map((l) => (l._id === lead._id ? { ...l, sdrStatus: updated.sdrStatus } : l)));
      // A row decided individually is no longer a valid bulk-selection target.
      setSelected((prev) => {
        if (!prev.has(lead._id)) return prev;
        const next = new Set(prev);
        next.delete(lead._id);
        return next;
      });
      // The backend flips the list ready <-> reviewed off the last pending lead,
      // so the parent has to re-read it for the confirm bar to appear here.
      onDecision?.();
      setOverride(null);
      setOverrideComment('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(lead._id);
        return next;
      });
    }
  };

  // Agreeing with the AI submits immediately, same as before. Disagreeing
  // pops a small dialog first so the SDR can optionally say why — a per-row
  // textarea in a dense table would be unreadable.
  const decide = (lead, decision) => {
    if (disagreesWithVerdict(decision, lead.status)) {
      setOverride({ lead, decision });
      setOverrideComment('');
      return;
    }
    submitDecision(lead, decision);
  };

  const cancelOverride = () => {
    setOverride(null);
    setOverrideComment('');
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
      {selected.size > 0 && (
        <div className="decision-row" style={{ marginTop: 0, marginBottom: 12, justifyContent: 'space-between' }}>
          <span className="muted">{selected.size} selected</span>
          <div className="decision-row" style={{ margin: 0 }}>
            <button className="btn reject small" onClick={submitBulkReject} disabled={bulkBusy}>
              <IconX /> Reject {selected.size} selected
            </button>
            <button className="btn ghost small" onClick={() => setSelected(new Set())} disabled={bulkBusy}>
              Clear selection
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {!rows.length ? (
        <p className="muted">No companies match these filters.</p>
      ) : (
        <table className="table-plain">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  className="checkbox-themed"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={!pendingRows.length}
                  title="Select all pending rows"
                />
              </th>
              {COLUMNS.slice(0, 3).map((col) => (
                <th key={col.key} className="sortable" onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sort.key === col.key && (
                    <span className="sort-icon">{sort.dir === 1 ? <IconChevronUp /> : <IconChevronDown />}</span>
                  )}
                </th>
              ))}
              <th>Compliance</th>
              {COLUMNS.slice(3).map((col) => (
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
            {rows.map((lead) => {
              const companyHref = getCompanyHref(lead.website);
              const compliance = complianceBadge(lead.qualification);
              const noDomain = !hasUsableDomain(lead.website);
              return (
              <tr key={lead._id}>
                <td>
                  {lead.sdrStatus === 'pending' && (
                    <input
                      type="checkbox"
                      className="checkbox-themed"
                      checked={selected.has(lead._id)}
                      onChange={() => toggleRow(lead._id)}
                    />
                  )}
                </td>
                <td>{companyHref ? <a className="company-link" href={companyHref} target="_blank" rel="noreferrer">{lead.companyName}</a> : lead.companyName}</td>
                <td>{lead.employees ?? '—'}</td>
                <td>{lead.country || '—'}</td>
                <td>
                  <span
                    className={`badge compliance-cell ${compliance.compliant ? 'compliant' : 'compliance-unconfirmed'}`}
                    title={compliance.frameworks || undefined}
                  >
                    {compliance.label}
                  </span>
                </td>
                <td><span className={`badge ${lead.status}`}>{VERDICT_LABELS[lead.status] || lead.status}</span></td>
                <td><span className={`badge ${lead.sdrStatus}`}>{SDR_LABELS[lead.sdrStatus] || lead.sdrStatus}</span></td>
                <td>
                  {lead.sdrStatus === 'pending' ? (
                    <div className="decision-row" style={{ margin: 0 }}>
                      <button
                        className="btn accept small"
                        onClick={() => decide(lead, 'accepted')}
                        disabled={busyIds.has(lead._id) || noDomain}
                        title={noDomain ? 'No domain on Apollo — contacts cannot be sourced' : undefined}
                      >
                        <IconCheck /> Accept
                      </button>
                      <button className="btn reject small" onClick={() => decide(lead, 'rejected')} disabled={busyIds.has(lead._id)}>
                        <IconX /> Reject
                      </button>
                      {noDomain && <span className="chip muted">no domain</span>}
                    </div>
                  ) : (
                    <button className="btn ghost small" onClick={() => decide(lead, 'pending')} disabled={busyIds.has(lead._id)}>
                      <IconUndo /> Undo
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {override && (
        <div className="overlay" onClick={cancelOverride}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <p>
              {override.decision === 'accepted' ? 'Accepting' : 'Rejecting'} <strong>{override.lead.companyName}</strong> goes
              against the AI's verdict ({VERDICT_LABELS[override.lead.status] || override.lead.status}) — want to note why? (optional)
            </p>
            <textarea
              rows={3}
              autoFocus
              value={overrideComment}
              onChange={(e) => setOverrideComment(e.target.value)}
              placeholder="e.g. AI missed that they're a consultancy, not SaaS"
            />
            {/* The overlay covers the whole page, including the .panel's own
                {error && ...} above — without this, a failed confirm (e.g. the
                backend's 409 when a company has no domain) set `error` correctly
                but the dialog just sat there with no visible feedback, since the
                text rendered behind it. */}
            {error && <p className="error">{error}</p>}
            <div className="decision-row">
              <button className="btn ghost" onClick={cancelOverride} disabled={busyIds.has(override.lead._id)}>
                Cancel
              </button>
              <button
                className={`btn ${override.decision === 'accepted' ? 'accept' : 'reject'}`}
                onClick={() => submitDecision(override.lead, override.decision, overrideComment)}
                disabled={busyIds.has(override.lead._id)}
              >
                {override.decision === 'accepted' ? <IconCheck /> : <IconX />} Confirm {override.decision === 'accepted' ? 'accept' : 'reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
