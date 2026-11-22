import { useEffect, useRef, useState } from 'react';

export interface MenuAction {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** A "⋯" button that opens a small dropdown of actions. Closes on outside click, Escape and selection. */
export function ActionMenu({ actions, label = 'More actions' }: { actions: MenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); // close the menu only, not the drawer behind it
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="action-menu" ref={root}>
      <button type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={action.danger ? 'danger-text' : ''}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
