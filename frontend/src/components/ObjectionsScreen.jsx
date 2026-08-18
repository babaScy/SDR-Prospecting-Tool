import { useEffect, useState } from 'react';
import { OBJECTIONS } from '../data/objections';
import { fetchObjectionFeedback } from '../api';
import ObjectionModal from './ObjectionModal';

export default function ObjectionsScreen() {
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // one OBJECTIONS entry, or null

  useEffect(() => {
    fetchObjectionFeedback().then(setFeedback).catch((e) => setError(e.message));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? OBJECTIONS.filter((o) => o.name.toLowerCase().includes(q) || o.search.toLowerCase().includes(q))
    : OBJECTIONS;

  const countFor = (name) => feedback.filter((f) => f.objection === name).length;
  const onFeedbackPosted = (entry) => setFeedback((prev) => [entry, ...prev]);

  return (
    <div>
      <div className="panel">
        <div className="form-row">
          <label>
            Search
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search objections (e.g. budget, competitors, not interested)…"
            />
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {filtered.length === 0 ? (
        <div className="empty-state"><p>No objections match that search.</p></div>
      ) : (
        <div className="objection-grid">
          {filtered.map((o) => {
            const fbCount = countFor(o.name);
            return (
              <button className="objection-card" key={o.name} onClick={() => setSelected(o)} type="button">
                <div className="objection-card-title">{o.name}</div>
                <div className="objection-card-foot">
                  <span className="chip">{o.boxes.length} option{o.boxes.length === 1 ? '' : 's'}</span>
                  {fbCount > 0 && <span className="chip muted">💬 {fbCount}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <ObjectionModal
          objection={selected}
          feedback={feedback}
          onClose={() => setSelected(null)}
          onFeedbackPosted={onFeedbackPosted}
        />
      )}
    </div>
  );
}
