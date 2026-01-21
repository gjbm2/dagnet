import React from 'react';

export function CountdownBanner(props: {
  label: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionTitle?: string;
  /** Optional top offset (px) when multiple banners may stack. */
  topPx?: number;
  /** Optional z-index override (defaults to 2000). */
  zIndex?: number;
}): React.ReactElement {
  const {
    label,
    detail,
    actionLabel,
    onAction,
    actionDisabled,
    actionTitle,
    topPx = 0,
    zIndex = 2000,
  } = props;

  return (
    <div
      style={{
        position: 'fixed',
        top: topPx,
        left: 0,
        right: 0,
        zIndex,
        background: '#111827',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.12)',
      }}
      role="status"
      aria-live="polite"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>{label}</div>
        {detail ? (
          <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {detail}
          </div>
        ) : null}
      </div>

      {actionLabel && onAction ? (
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled}
            style={{
              border: '1px solid rgba(255,255,255,0.25)',
              background: actionDisabled ? 'rgba(255,255,255,0.12)' : '#ef4444',
              color: '#fff',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 12,
              fontWeight: 700,
              cursor: actionDisabled ? 'not-allowed' : 'pointer',
            }}
            title={actionTitle}
          >
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

