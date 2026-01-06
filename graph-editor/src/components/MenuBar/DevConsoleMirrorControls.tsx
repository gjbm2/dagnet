import React, { useMemo, useState } from 'react';
import { useConsoleMirrorControls } from '../../hooks/useConsoleMirrorControls';
import './MenuBar.css';

/**
 * Dev-only UI: console mirror toggle + mark input.
 *
 * Positioned in MenuBar immediately left of the Dagnet brand.
 * Behaviour lives in hook/service; this component is a thin access point.
 */
export function DevConsoleMirrorControls() {
  const { enabled, setEnabled, sendMark } = useConsoleMirrorControls();
  const [text, setText] = useState('');
  const [lastBase, setLastBase] = useState<string>('');
  const [counter, setCounter] = useState<number>(0);

  const canSend = useMemo(() => enabled && text.trim().length > 0, [enabled, text]);

  if (!import.meta.env.DEV) return null;

  const parseBaseAndInitial = (raw: string): { base: string; initial: number | null } => {
    const trimmed = raw.trim();
    const m = trimmed.match(/^(.*?)(?:\s+(\d+))?$/);
    if (!m) return { base: trimmed, initial: null };
    const base = (m[1] ?? '').trim();
    const n = m[2] ? Number(m[2]) : null;
    return { base: base || trimmed, initial: Number.isFinite(n as any) ? (n as number) : null };
  };

  const onSend = () => {
    const { base, initial } = parseBaseAndInitial(text);
    if (!base) return;

    // If user changed the base label, reset counter (or seed from explicit trailing number).
    let nextCounter = counter;
    if (base !== lastBase) {
      setLastBase(base);
      nextCounter = initial ?? 0;
    }

    const next = nextCounter + 1;
    setCounter(next);
    sendMark(`${base} ${next}`);
  };

  return (
    <div className="dagnet-dev-console-controls" title="Dev: Mirror browser console logs to file for Cursor debugging">
      <label className="dagnet-dev-console-toggle" title="Enable console mirroring">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Console</span>
      </label>

      <input
        className="dagnet-dev-console-mark-input"
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Mark…"
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSend();
        }}
        disabled={!enabled}
      />

      <button
        className="dagnet-dev-console-mark-btn"
        onClick={onSend}
        disabled={!canSend}
        type="button"
        title="Send mark"
      >
        Mark
      </button>
    </div>
  );
}


