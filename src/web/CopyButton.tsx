import { useEffect, useRef, useState } from 'react';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.75" y="1.75" width="8.5" height="8.5" rx="2" />
      <path d="M3.75 5.75A2 2 0 0 0 1.75 7.75v4.5a2 2 0 0 0 2 2h4.5a2 2 0 0 0 2-2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Copies `value` to the clipboard and briefly confirms. Safe to place inside a card or row:
 * pointer, click and key events do not reach the drag handle or open the issue.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    setState((await writeClipboard(value)) ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1500);
  };

  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : <CopyIcon />}
    </button>
  );
}
