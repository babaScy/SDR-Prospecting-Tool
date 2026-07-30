import { useState } from 'react';
import { changePassword } from '../api';

const MIN_LENGTH = 12;

// Shown before the app when the current password was issued by an admin, so an
// admin-known password never stays in use.
export default function ChangePasswordScreen({ email, onDone, onCancel }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const ready = currentPassword && newPassword.length >= MIN_LENGTH && newPassword === confirm;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await changePassword(currentPassword, newPassword);
      onDone();
    } catch (err) {
      setError(err.message);
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

        <h2>{onCancel ? 'Change your password' : 'Choose your password'}</h2>
        <p className="muted">
          {onCancel
            ? `Signed in as ${email}.`
            : 'The password you were given was created by an admin. Pick your own to finish signing in.'}
        </p>

        <form onSubmit={submit} className="login-form">
          <label>
            Current password
            <input
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {tooShort && <p className="muted login-hint">At least {MIN_LENGTH} characters.</p>}
          {mismatch && <p className="error">Those two passwords do not match.</p>}
          <button className="btn" type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          {onCancel && (
            <button className="btn ghost" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </form>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
