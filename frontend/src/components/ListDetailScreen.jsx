import { useEffect, useState } from 'react';
import { fetchList } from '../api';
import ListTable from './ListTable';
import ReviewScreen from './ReviewScreen';

export default function ListDetailScreen({ listId, onBack }) {
  const [list, setList] = useState(null);
  const [mode, setMode] = useState('table');

  useEffect(() => {
    fetchList(listId).then(setList).catch(() => {});
  }, [listId]);

  return (
    <div>
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn ghost" onClick={onBack}>← Lists</button>
          <strong>{list?.name || '…'}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={mode === 'table' ? 'btn' : 'btn ghost'} onClick={() => setMode('table')}>Table</button>
          <button className={mode === 'card' ? 'btn' : 'btn ghost'} onClick={() => setMode('card')}>Card review</button>
        </div>
      </div>
      {mode === 'table' ? <ListTable listId={listId} /> : <ReviewScreen listId={listId} onBack={onBack} />}
    </div>
  );
}
