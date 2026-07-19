import { useEffect, useState } from 'react';
import { fetchLists } from '../api';

export default function ListsScreen({ onOpen }) {
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
  if (!lists.length) return <p className="muted">No lists yet — run a pull first.</p>;

  return (
    <div className="panel">
      <h2>Lists</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
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
            return (
              <tr key={list._id} onClick={() => onOpen(list._id)}>
                <td>{list.name}</td>
                <td>{list.pulledCount}</td>
                <td>{c.qualified}</td>
                <td>{c.nei}</td>
                <td>{c.disqualified}</td>
                <td>
                  {c.total - c.pendingSdr}/{c.total}
                </td>
                <td>
                  <span className={`badge ${list.status}`}>{list.status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
