import { useState } from 'react';
import { login } from '../api';

// No account picker: you need your own password, so one SDR cannot sign in as
// another just by choosing their name.
export default function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="panel login-panel">
        <div className="wordmark" style={{ marginBottom: 18 }}>
          <img className="wordmark-logo" src="/sales-logo-light.svg" alt="Scytale Sales" />
          <span className="wordmark-rule" />
          <span className="wordmark-text">Prospector</span>
        </div>

        <h2>Sign in</h2>
        <p className="muted">Use the password you were given, then set your own.</p>

        <form onSubmit={submit} className="login-form">
          <label>
            Work email
            <input
              type="email"
              required
              autoFocus
              autoComplete="username"
              placeholder="you@scytale.ai"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        <p className="login-foot muted">Lost your password? Ask an admin to reset it.</p>
      </div>
    </div>
  );
}
