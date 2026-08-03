import { useEffect, useState } from 'react';
import { startSdrPull, fetchQuota, fetchLists, fetchList } from '../api';

const RUNNING = ['pulling', 'qualifying'];

// Regions come from the authenticated session rather than being looked up
// client-side; the backend enforces them again on every pull.
export default function SdrPullScreen({ regions = [] }) {
  const [region, setRegion] = useState(regions[0] || '');
  const [profile, setProfile] = useState('icp1');
  const [activeList, setActiveList] = useState(null);
  const [quota, setQuota] = useState(null); // { qualifiedToday, quota }
  const [error, setError] = useState('');

  const refreshQuota = () => fetchQuota().then(setQuota).catch(() => {});

  useEffect(() => {
    refreshQuota();
    fetchLists()
      .then((lists) => {
        const running = lists.find((l) => RUNNING.includes(l.status));
        if (running) setActiveList(running);
      })
      .catch(() => {});
  }, []);

  const isRunning = activeList && RUNNING.includes(activeList.status);

  useEffect(() => {
    if (!isRunning) { refreshQuota(); return undefined; }
    const timer = setInterval(() => {
      fetchList(activeList._id).then(setActiveList).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [isRunning, activeList?._id]);

  const atQuota = quota && quota.qualifiedToday >= quota.quota;
  const alreadyPulledToday = Boolean(quota?.pulledToday);
  const blocked = atQuota || alreadyPulledToday;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      setActiveList(await startSdrPull(region, profile));
    } catch (err) {
      setError(err.message);
    }
  };

  const counts = activeList?.counts;

  return (
    <div>
      <div className="panel">
        <h2>Pull leads</h2>
        {quota && (
          <p className="muted">
            <strong>{quota.qualifiedToday} / {quota.quota}</strong> qualified today
            {atQuota
              ? ' — daily limit reached, resets at midnight'
              : alreadyPulledToday
                ? ' — you\'ve already run today\'s pull, resets at midnight'
                : ''}
          </p>
        )}
        <form className="form-row" onSubmit={submit}>
          <label>
            Region
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {regions.map((r) => (
                <option key={r} value={r}>{r.toUpperCase()}</option>
              ))}
            </select>
          </label>
          <label>
            ICP profile
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="icp1">ICP1 (1-50 employees)</option>
              <option value="icp2">ICP2 (51-250 employees)</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={isRunning || blocked}>
            {isRunning ? 'Pull running…' : 'Pull leads'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>

      {activeList && (
        <div className="panel">
          <h3>
            {activeList.name} <span className={`badge ${activeList.status}`}>{activeList.status}</span>
          </h3>
          <p className="muted">{activeList.lastMessage}</p>
          {activeList.status === 'failed' && <p className="error">{activeList.error}</p>}
          {isRunning && (
            <div className="progress-bar indeterminate"><div /></div>
          )}
          <div className="stat-row">
            <div className="stat"><span className="num">{activeList.pulledCount}</span><span className="label">pulled</span></div>
            {counts && (
              <>
                <div className="stat"><span className="num">{counts.qualified}</span><span className="label">qualified</span></div>
                <div className="stat"><span className="num">{counts.nei}</span><span className="label">not enough info</span></div>
                <div className="stat"><span className="num">{counts.disqualified}</span><span className="label">disqualified</span></div>
              </>
            )}
          </div>
          {activeList.progressLog?.length > 0 && (
            <div className="progress-log">{activeList.progressLog.join('\n')}</div>
          )}
        </div>
      )}
    </div>
  );
}
