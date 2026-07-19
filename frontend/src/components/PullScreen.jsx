import { useEffect, useState } from 'react';
import { startPull, fetchLists, fetchList } from '../api';
import USERS from '../users';

const REGIONS = ['uk', 'us', 'benelux', 'nordics', 'dach', 'aus'];
const RUNNING = ['pulling', 'qualifying'];
const SDRS = USERS.filter((u) => u.role === 'sdr');

export default function PullScreen() {
  const [profile, setProfile] = useState('icp1');
  const [region, setRegion] = useState('uk');
  const [count, setCount] = useState(20);
  const [assignedTo, setAssignedTo] = useState(SDRS[0].email);
  const [activeList, setActiveList] = useState(null);
  const [error, setError] = useState('');

  // On mount, pick up a pull that's already running (e.g. after a page refresh).
  useEffect(() => {
    fetchLists()
      .then((lists) => {
        const running = lists.find((l) => RUNNING.includes(l.status));
        if (running) setActiveList(running);
      })
      .catch(() => {});
  }, []);

  const isRunning = activeList && RUNNING.includes(activeList.status);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => {
      fetchList(activeList._id).then(setActiveList).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [isRunning, activeList?._id]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      setActiveList(await startPull(profile, region, Number(count), assignedTo));
    } catch (err) {
      setError(err.message);
    }
  };

  const counts = activeList?.counts;

  return (
    <div>
      <div className="panel">
        <h2>Pull leads</h2>
        <form className="form-row" onSubmit={submit}>
          <label>
            How many
            <input type="number" min="1" max="200" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <label>
            Region
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => (
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
          <label>
            Assign to
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              {SDRS.map((u) => (
                <option key={u.email} value={u.email}>{u.email}</option>
              ))}
            </select>
          </label>
          <button className="btn" type="submit" disabled={isRunning}>
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
            <div className={`progress-bar${activeList.status === 'qualifying' ? ' indeterminate' : ''}`}>
              <div
                style={{
                  width: activeList.status === 'qualifying'
                    ? undefined
                    : `${activeList.requestedCount ? Math.min(100, (activeList.pulledCount / activeList.requestedCount) * 100) : 0}%`,
                }}
              />
            </div>
          )}
          <div className="stat-row">
            <div className="stat"><span className="num">{activeList.pulledCount}</span><span className="label">pulled / {activeList.requestedCount} requested</span></div>
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
