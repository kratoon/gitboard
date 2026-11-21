import { useEffect, useRef, useState } from 'react';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `value` to the clipboard and briefly confirms. Safe to place inside a card or row:
 * pointer, click and key events do not reach the drag handle or open the issue.
 */
export function CopyButton({ value, label, children }: { value: string; label: string; children?: string }) {
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
      className={`copy-btn${children ? ' with-text' : ''}`}
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : (children ?? '⧉')}
    </button>
  );
}
