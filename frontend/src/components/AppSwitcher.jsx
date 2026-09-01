import { useEffect, useRef, useState } from 'react';

const SECTIONS = [
  { key: 'prospector', label: 'Prospector' },
  { key: 'objections', label: 'Objection Handler' },
  { key: 'intelligence', label: 'Intelligence' },
];

export default function AppSwitcher({ current, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentLabel = SECTIONS.find((s) => s.key === current)?.label || 'Prospector';

  return (
    <div className="app-switcher" ref={ref}>
      <button className="app-switcher-trigger" onClick={() => setOpen((o) => !o)} type="button">
        <span>{currentLabel}</span>
        <span className="app-switcher-chev">▾</span>
      </button>
      {open && (
        <div className="app-switcher-menu">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`app-switcher-item${s.key === current ? ' active' : ''}`}
              onClick={() => { onSelect(s.key); setOpen(false); }}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
