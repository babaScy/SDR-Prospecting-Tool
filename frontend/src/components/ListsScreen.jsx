import { useEffect, useState } from 'react';
import { fetchLists } from '../api';
import { IconTable } from '../icons';

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

  if (error) return <p className="error">{error}</p>;
  if (!lists) return <p className="muted">Loading…</p>;
  if (!lists.length) {
    return (
      <div className="panel empty-state">
        <div className="icon-circle"><IconTable /></div>
        <p className="muted">No lists yet — run a pull first.</p>
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
