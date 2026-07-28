import { useEffect, useState } from 'react';
import { fetchList, confirmReview } from '../api';
import { IconArrowLeft, IconTable, IconCards, IconCheck } from '../icons';
import ListTable from './ListTable';
import ReviewScreen from './ReviewScreen';
import ContactsScreen from './ContactsScreen';

export default function ListDetailScreen({ listId, onBack }) {
  const [list, setList] = useState(null);
  const [mode, setMode] = useState('table');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  const load = () => fetchList(listId).then((l) => { setList(l); return l; }).catch(() => null);
  useEffect(() => {
    load().then((l) => {
      if (l && (l.reviewConfirmedAt || ['sourcing', 'sourced'].includes(l.status))) setMode('contacts');
    });
  }, [listId]);

  // Once review is confirmed the contacts view is the destination — including
  // when sourcing failed part-way, since the contacts found so far are saved.
  const sourced = Boolean(list?.reviewConfirmedAt) || ['sourcing', 'sourced'].includes(list?.status);
  // Card review has its own confirm gate — only offer it here on the table.
  const canConfirmHere = list?.status === 'reviewed' && mode === 'table';
  const accepted = list?.counts?.accepted ?? 0;

  const doConfirm = async () => {
    setConfirming(true);
    setConfirmError('');
    try {
      await confirmReview(listId);
      await load();
      setMode('contacts');
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setConfirming(false);
    }
  };

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
      {canConfirmHere && (
        <div className="panel confirm-bar">
          <div>
            <strong>All leads reviewed.</strong>{' '}
            <span className="muted">
              {accepted > 0
                ? `Confirm to lock these decisions and find contacts for the ${accepted} accepted ${accepted === 1 ? 'company' : 'companies'}.`
                : 'No accepted leads to source. Confirming just finalizes this list.'}
            </span>
            {confirmError && <p className="error">{confirmError}</p>}
          </div>
          <button className="btn accept" onClick={doConfirm} disabled={confirming}>
            <IconCheck /> {confirming ? 'Confirming…' : 'Confirm list review'}
          </button>
        </div>
      )}
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
