import { useEffect, useState } from 'react';
import { fetchLists, fetchFunnelStats, setFunnelStats as saveFunnelStats } from '../api';
import { IconTable } from '../icons';

const currency = (n) => `$${Number(n).toLocaleString()}`;

const FUNNEL_FIELDS = [
  { key: 'demosBooked', label: 'demos booked', tone: 'tone-neutral' },
  { key: 'sqls', label: 'SQLs', tone: 'tone-primary' },
  { key: 'closedWon', label: 'closed won', tone: 'tone-green' },
  { key: 'closedWonRevenue', label: 'closed won revenue', tone: 'tone-green', format: currency },
];

function FunnelStats({ isAdmin }) {
  const [stats, setStats] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchFunnelStats().then(setStats).catch((err) => setError(err.message));
  }, []);

  if (!stats) return null;

  const startEdit = () => {
    setError('');
    setDraft(Object.fromEntries(FUNNEL_FIELDS.map((f) => [f.key, String(stats[f.key])])));
    setEditing(true);
  };

  const cancelEdit = () => {
    setError('');
    setEditing(false);
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const parsed = Object.fromEntries(FUNNEL_FIELDS.map((f) => [f.key, Number(draft[f.key])]));
    try {
      const updated = await saveFunnelStats(parsed);
      setStats(updated);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="panel">
      {editing ? (
        <form className="form-row" onSubmit={save}>
          {FUNNEL_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                min="0"
                step="any"
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <button className="btn small" type="submit">Save</button>
          <button className="btn ghost small" type="button" onClick={cancelEdit}>Cancel</button>
        </form>
      ) : (
        <div className="stat-row">
          {FUNNEL_FIELDS.map((f) => (
            <div className={`stat-card ${f.tone}`} key={f.key}>
              <div className="dot" />
              <div>
                <div className="num">{f.format ? f.format(stats[f.key]) : stats[f.key]}</div>
                <div className="label">{f.label}</div>
              </div>
            </div>
          ))}
          {isAdmin && (
            <button className="btn ghost small" type="button" onClick={startEdit}>Edit</button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default function ListsScreen({ onOpen, isAdmin }) {
  const [lists, setLists] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      fetchLists()
        .then((data) => {
          setLists(data);
          setError('');
        })
        .catch((err) => setError(err.message));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <><FunnelStats isAdmin={isAdmin} /><p className="error">{error}</p></>;
  if (!lists) return <><FunnelStats isAdmin={isAdmin} /><p className="muted">Loading…</p></>;
  if (!lists.length) {
    return (
      <div>
        <FunnelStats isAdmin={isAdmin} />
        <div className="panel empty-state">
          <div className="icon-circle"><IconTable /></div>
          <p className="muted">No lists yet — run a pull first.</p>
        </div>
      </div>
    );
  }

  const totals = lists.reduce(
    (acc, l) => ({
      pulled: acc.pulled + l.pulledCount,
      qualified: acc.qualified + l.counts.qualified,
      accepted: acc.accepted + l.counts.accepted,
    }),
    { pulled: 0, qualified: 0, accepted: 0 }
  );

  return (
    <div>
      <FunnelStats isAdmin={isAdmin} />
      <div className="panel">
        <div className="stat-row">
          <div className="stat-card tone-neutral"><div className="dot" /><div><div className="num">{totals.pulled}</div><div className="label">pulled</div></div></div>
          <div className="stat-card tone-green"><div className="dot" /><div><div className="num">{totals.qualified}</div><div className="label">qualified</div></div></div>
          <div className="stat-card tone-primary"><div className="dot" /><div><div className="num">{totals.accepted}</div><div className="label">accepted</div></div></div>
        </div>
      </div>
      <div className="panel">
        <h2>Lists</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {isAdmin && <th>Assigned to</th>}
              <th>Pulled</th>
              <th>Qualified</th>
              <th>Not enough info</th>
              <th>Disqualified</th>
              <th>Reviewed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((list) => {
              const c = list.counts;
              const isRunning = list.status === 'pulling' || list.status === 'qualifying';
              return (
                <tr
                  key={list._id}
                  onClick={isRunning ? undefined : () => onOpen(list._id)}
                  style={isRunning ? { cursor: 'default' } : undefined}
                >
                  <td>{list.name}</td>
                  {isAdmin && <td>{list.assignedTo || '—'}</td>}
                  <td>{list.pulledCount}</td>
                  <td>{c.qualified}</td>
                  <td>{c.nei}</td>
                  <td>{c.disqualified}</td>
                  <td>
                    {c.total - c.pendingSdr}/{c.total}
                  </td>
                  <td>
                    <span className={`badge ${list.status}`}>{list.status}</span>
                    {isRunning && <span className="muted"> — still running</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
