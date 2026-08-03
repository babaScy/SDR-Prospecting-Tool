import { useEffect, useState } from 'react';
import { fetchContacts, fetchList, pushContactToHubspot } from '../api';
import { IconMail, IconLinkedin, IconPhone, IconStar, IconCheck } from '../icons';
import { getCompanyHref } from '../utils/companyLink';

const RUNNING = ['sourcing'];
const initials = (c) => `${(c.firstName || '?')[0] || ''}${(c.lastName || '')[0] || ''}`.toUpperCase() || '?';

function ContactCard({ c, onPushed }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const push = async () => {
    setBusy(true);
    setErr('');
    try {
      onPushed(await pushContactToHubspot(c._id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const synced = c.hubspotStatus === 'synced';
  const alreadyExisted = c.hubspotStatus === 'already_existed';
  const label = synced ? 'In HubSpot' : alreadyExisted ? 'Already in HubSpot' : busy ? 'Adding…' : 'Add to HubSpot';

  return (
    <div className={`contact-card${c.isPrimary ? ' primary' : ''}`}>
      {c.isPrimary && <span className="primary-ribbon"><IconStar width={12} height={12} /> Primary</span>}
      <div className="contact-head">
        <div className="avatar">{initials(c)}</div>
        <div>
          <div className="contact-name">{c.firstName} {c.lastName}</div>
          <div className="contact-title">{c.title || 'no title'}</div>
        </div>
      </div>
      {c.reasoning && <div className="contact-reason">{c.reasoning}</div>}
      <div className="contact-actions">
        {c.email
          ? <a className="chip" href={`mailto:${c.email}`}><IconMail width={14} height={14} /> Email</a>
          : <span className="chip muted">no email</span>}
        {c.linkedinUrl && <a className="chip" href={c.linkedinUrl} target="_blank" rel="noreferrer"><IconLinkedin width={14} height={14} /> LinkedIn</a>}
        {c.phone && <a className="chip" href={`tel:${c.phone}`}><IconPhone width={14} height={14} /> {c.phone}</a>}
      </div>
      <div className="contact-actions">
        <button className="btn small ghost" onClick={push} disabled={busy || synced || alreadyExisted}>
          {synced && <IconCheck width={14} height={14} />} {label}
        </button>
      </div>
      {(err || c.hubspotError) && <div className="error">{err || c.hubspotError}</div>}
    </div>
  );
}

export default function ContactsScreen({ listId }) {
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');

  const loadContacts = () => fetchContacts(listId).then(setGroups).catch((e) => setError(e.message));
  useEffect(() => { fetchList(listId).then(setList).catch(() => {}); loadContacts(); }, [listId]);

  const sourcing = list && RUNNING.includes(list.status);
  useEffect(() => {
    if (!sourcing) { loadContacts(); return undefined; }
    const t = setInterval(() => { fetchList(listId).then(setList).catch(() => {}); loadContacts(); }, 3000);
    return () => clearInterval(t);
  }, [sourcing, listId]);

  if (error) return <div className="panel"><p className="error">{error}</p></div>;
  if (!groups) return <p className="muted">Loading…</p>;

  const companiesWith = groups.filter((g) => g.contacts.length).length;
  const totalContacts = groups.reduce((n, g) => n + g.contacts.length, 0);
  const emailable = groups.reduce((n, g) => n + g.contacts.filter((c) => c.email).length, 0);

  return (
    <div>
      <div className="panel">
        <div className="stat-row">
          <div className="stat-card tone-neutral"><div className="dot" /><div><div className="num">{groups.length}</div><div className="label">accepted companies</div></div></div>
          <div className="stat-card tone-primary"><div className="dot" /><div><div className="num">{companiesWith}</div><div className="label">with contacts</div></div></div>
          <div className="stat-card tone-primary"><div className="dot" /><div><div className="num">{totalContacts}</div><div className="label">contacts</div></div></div>
          <div className="stat-card tone-green"><div className="dot" /><div><div className="num">{emailable}</div><div className="label">emailable</div></div></div>
        </div>
        {sourcing && (
          <>
            <p className="muted">{list.lastMessage}</p>
            <div className="progress-bar indeterminate"><div /></div>
          </>
        )}
        {list?.status === 'failed' && (
          <p className="error">
            Sourcing stopped early — any contacts found before it stopped are shown below. {list.error}
          </p>
        )}
      </div>

      {groups.map(({ company, contacts }) => {
        const companyHref = getCompanyHref(company.website);
        return (
        <div className="panel" key={company._id}>
          <div className="contacts-company-head">
            <strong>{companyHref ? <a className="company-link" href={companyHref} target="_blank" rel="noreferrer">{company.companyName}</a> : company.companyName}</strong>
            {company.website && <a className="muted" href={company.website} target="_blank" rel="noreferrer">website</a>}
            <span className={`badge ${company.contactStatus}`}>{company.contactStatus}</span>
          </div>
          {contacts.length
            ? <div className="contacts-row">{contacts.map((c) => (
                <ContactCard
                  key={c._id}
                  c={c}
                  onPushed={(updated) => setGroups((prev) => prev.map((g) => ({
                    ...g,
                    contacts: g.contacts.map((existing) => (existing._id === updated._id ? updated : existing)),
                  })))}
                />
              ))}</div>
            : <p className="muted">No decision-maker found.</p>}
        </div>
        );
      })}
    </div>
  );
}
