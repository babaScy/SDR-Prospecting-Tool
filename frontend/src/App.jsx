import { useEffect, useState } from 'react';
import PullScreen from './components/PullScreen';
import SdrPullScreen from './components/SdrPullScreen';
import ListsScreen from './components/ListsScreen';
import ListDetailScreen from './components/ListDetailScreen';
import LoginScreen from './components/LoginScreen';
import ChangePasswordScreen from './components/ChangePasswordScreen';
import WolfSplash from './components/WolfSplash';
import { IconUndo } from './icons';
import { fetchMe, logout } from './api';

function defaultView(user) {
  return { name: user?.role === 'admin' ? 'pull' : 'lists' };
}

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState({ name: 'lists' });
  const [splash, setSplash] = useState(false);
  // Until the session check returns we don't know whether to show login or the app.
  const [checking, setChecking] = useState(true);
  // Set when the user asks to change a password they already chose.
  const [changing, setChanging] = useState(false);

  const signedIn = (me) => {
    setUser(me);
    setView(defaultView(me));
    // The splash is the landing moment, so hold it until any forced change is done.
    setSplash(!me.mustChangePassword);
  };

  // The session lives in an httpOnly cookie, so only the server can tell us who
  // we are.
  useEffect(() => {
    let cancelled = false;
    fetchMe().then((me) => {
      if (cancelled) return;
      if (me) signedIn(me);
      setChecking(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => { setUser(null); setSplash(false); };
    window.addEventListener('prospector:unauthorized', onUnauthorized);
    return () => window.removeEventListener('prospector:unauthorized', onUnauthorized);
  }, []);

  const signOut = async () => {
    await logout();
    setUser(null);
    setSplash(false);
    setChanging(false);
  };

  if (checking) return <div className="login-wrap" />;
  if (!user) return <LoginScreen onSignedIn={signedIn} />;

  // An admin-issued password cannot be used to reach the app.
  if (user.mustChangePassword) {
    return (
      <ChangePasswordScreen
        email={user.email}
        onDone={() => { setUser({ ...user, mustChangePassword: false }); setSplash(true); }}
      />
    );
  }
  if (changing) {
    return (
      <ChangePasswordScreen
        email={user.email}
        onDone={() => setChanging(false)}
        onCancel={() => setChanging(false)}
      />
    );
  }
  if (splash) return <WolfSplash user={user} onDone={() => setSplash(false)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <img className="wordmark-logo" src="/sales-logo-light.svg" alt="Scytale Sales" />
          <span className="wordmark-rule" />
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
            <button className="btn ghost small" onClick={() => setChanging(true)}>
              Password
            </button>
            <button className="btn ghost small" onClick={signOut}>
              <IconUndo /> Sign out
            </button>
          </div>
        </div>
      </header>
      <main>
        {view.name === 'pull' && (user.role === 'admin' ? <PullScreen /> : <SdrPullScreen regions={user.regions} />)}
        {view.name === 'lists' && (
          <ListsScreen isAdmin={user.role === 'admin'} onOpen={(listId) => setView({ name: 'list', listId })} />
        )}
        {view.name === 'list' && <ListDetailScreen listId={view.listId} onBack={() => setView({ name: 'lists' })} />}
      </main>
    </div>
  );
}
