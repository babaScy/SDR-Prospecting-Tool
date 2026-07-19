import { useEffect, useState } from 'react';
import { fetchList } from '../api';
import { IconArrowLeft, IconTable, IconCards } from '../icons';
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
          <button className="btn ghost small" onClick={onBack}><IconArrowLeft /> Lists</button>
          <strong>{list?.name || '…'}</strong>
        </div>
        <div className="segmented">
          <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>
            <IconTable /> Table
          </button>
          <button className={mode === 'card' ? 'active' : ''} onClick={() => setMode('card')}>
            <IconCards /> Card review
          </button>
        </div>
      </div>
      {mode === 'table' ? <ListTable listId={listId} /> : <ReviewScreen listId={listId} onBack={onBack} />}
    </div>
  );
}
