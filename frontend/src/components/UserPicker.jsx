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
            <div
              key={u.email}
              className={`picker-row${selected === u.email ? ' selected' : ''}`}
              onClick={() => setSelected(u.email)}
            >
              <div className={`avatar role-${u.role}`}>{u.email[0]}</div>
              <span className="picker-row-email">{u.email}</span>
              {u.role === 'admin' && <span className="badge pending">admin</span>}
            </div>
          ))}
        </div>
        <button className="btn" style={{ width: '100%' }} onClick={() => onPick(selected)}>Continue</button>
      </div>
    </div>
  );
}
