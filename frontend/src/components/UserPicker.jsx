import { useState } from 'react';
import USERS from '../users';

export default function UserPicker({ onPick }) {
  const [selected, setSelected] = useState(USERS[0].email);

  return (
    <div className="app">
      <div className="panel" style={{ maxWidth: 420, margin: '80px auto' }}>
        <h2>Who are you?</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '16px 0' }}>
          {USERS.map((u) => (
            <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="user"
                value={u.email}
                checked={selected === u.email}
                onChange={() => setSelected(u.email)}
              />
              {u.email}
              {u.role === 'admin' && <span className="badge pending">admin</span>}
            </label>
          ))}
        </div>
        <button className="btn" onClick={() => onPick(selected)}>Continue</button>
      </div>
    </div>
  );
}
