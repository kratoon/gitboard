import { useEffect, useRef, useState } from 'react';

export interface InlineOption {
  value: string;
  label: string;
}

/**
 * A field that reads as plain text and turns into a dropdown only when clicked. It highlights on hover so it
 * is clear that it can be clicked, and goes back to text after a choice, a blur or Escape.
 */
export function InlineSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: InlineOption[];
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!editing) return;
    select.current?.focus();
    try {
      select.current?.showPicker();
    } catch {
      /* not supported or no user activation: the focused select still opens with a click or the keyboard */
    }
  }, [editing]);

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {editing ? (
        <select
          ref={select}
          className="field-select"
          aria-label={label}
          value={value}
          onChange={(e) => {
            setEditing(false);
            if (e.target.value !== value) onChange(e.target.value);
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation(); // leave the field, not the drawer
              setEditing(false);
            }
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <button type="button" className="field-value" title={`Change ${label.toLowerCase()}`} onClick={() => setEditing(true)}>
          {current && current.value !== '' ? current.label : <span className="muted">{current?.label ?? '(none)'}</span>}
        </button>
      )}
    </div>
  );
}
