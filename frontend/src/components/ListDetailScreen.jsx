import { useEffect, useState } from 'react';
import { fetchList } from '../api';
import { IconArrowLeft, IconTable, IconCards } from '../icons';
import ListTable from './ListTable';
import ReviewScreen from './ReviewScreen';
import ContactsScreen from './ContactsScreen';

export default function ListDetailScreen({ listId, onBack }) {
  const [list, setList] = useState(null);
  const [mode, setMode] = useState('table');

  const load = () => fetchList(listId).then((l) => { setList(l); return l; }).catch(() => null);
  useEffect(() => {
    load().then((l) => { if (l && ['sourcing', 'sourced'].includes(l.status)) setMode('contacts'); });
  }, [listId]);

  const sourced = list && ['sourcing', 'sourced'].includes(list.status);

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
          {!sourced && (
            <button className={mode === 'card' ? 'active' : ''} onClick={() => setMode('card')}>
              <IconCards /> Card review
            </button>
          )}
          {sourced && (
            <button className={mode === 'contacts' ? 'active' : ''} onClick={() => setMode('contacts')}>
              Contacts
            </button>
          )}
        </div>
      </div>
      {mode === 'table' && <ListTable listId={listId} />}
      {mode === 'card' && (
        <ReviewScreen
          listId={listId}
          onBack={onBack}
          onReviewConfirmed={() => load().then(() => setMode('contacts'))}
        />
      )}
      {mode === 'contacts' && <ContactsScreen listId={listId} />}
    </div>
  );
}
