import { useEffect, useState } from 'react';
import PullScreen from './components/PullScreen';
import SdrPullScreen from './components/SdrPullScreen';
import ListsScreen from './components/ListsScreen';
import ListDetailScreen from './components/ListDetailScreen';
import UserPicker from './components/UserPicker';
import { IconUndo } from './icons';
import { USER_STORAGE_KEY } from './api';
import USERS from './users';

function loadUser() {
  const email = localStorage.getItem(USER_STORAGE_KEY);
  return (email && USERS.find((u) => u.email === email)) || null;
}

function defaultView(user) {
  return { name: user?.role === 'admin' ? 'pull' : 'lists' };
}

export default function App() {
  const [user, setUser] = useState(loadUser);
  const [view, setView] = useState(() => defaultView(loadUser()));

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('prospector:unauthorized', onUnauthorized);
    return () => window.removeEventListener('prospector:unauthorized', onUnauthorized);
  }, []);

  const pickUser = (email) => {
    localStorage.setItem(USER_STORAGE_KEY, email);
    const picked = USERS.find((u) => u.email === email);
    setUser(picked);
    setView(defaultView(picked));
  };

  const switchUser = () => {
    localStorage.removeItem(USER_STORAGE_KEY);
    setUser(null);
  };

  if (!user) return <UserPicker onPick={pickUser} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <div className="wordmark-mark" />
          <span className="wordmark-text">Prospector</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <nav>
            <button className={view.name === 'pull' ? 'active' : ''} onClick={() => setView({ name: 'pull' })}>
              Pull
            </button>
            <button
              className={view.name === 'lists' || view.name === 'list' ? 'active' : ''}
              onClick={() => setView({ name: 'lists' })}
            >
              Lists
            </button>
          </nav>
          <div className="user-chip">
            <div className={`avatar role-${user.role}`}>{user.email[0]}</div>
            <div className="user-chip-text">
              <span className="user-chip-email">{user.email}</span>
              <span className="user-chip-role">{user.role}</span>
            </div>
            <button className="btn ghost small" onClick={switchUser}>
              <IconUndo /> Switch
            </button>
          </div>
        </div>
      </header>
      <main>
        {view.name === 'pull' && (user.role === 'admin' ? <PullScreen /> : <SdrPullScreen />)}
        {view.name === 'lists' && (
          <ListsScreen isAdmin={user.role === 'admin'} onOpen={(listId) => setView({ name: 'list', listId })} />
        )}
        {view.name === 'list' && <ListDetailScreen listId={view.listId} onBack={() => setView({ name: 'lists' })} />}
      </main>
    </div>
  );
}
