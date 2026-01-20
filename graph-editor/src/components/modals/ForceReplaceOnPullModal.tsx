import React, { useEffect } from 'react';

export interface ForceReplaceOnPullRequest {
  fileId: string;
  fileName: string;
  path: string;
}

export interface ForceReplaceOnPullModalProps {
  isOpen: boolean;
  countdownSeconds: number;
  requests: ForceReplaceOnPullRequest[];
  onOk: () => void;
  onCancel: () => void;
}

const COUNTDOWN_STYLE_ID = 'force-replace-countdown-keyframes';
function ensureCountdownStyles(): void {
  if (document.getElementById(COUNTDOWN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = COUNTDOWN_STYLE_ID;
  style.textContent = `
    @keyframes force-replace-countdown-pulse {
      0% { transform: scale(1); opacity: 0.95; }
      50% { transform: scale(1.03); opacity: 1; }
      100% { transform: scale(1); opacity: 0.95; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * UI-only modal. No business logic.
 */
export function ForceReplaceOnPullModal({
  isOpen,
  countdownSeconds,
  requests,
  onOk,
  onCancel,
}: ForceReplaceOnPullModalProps): React.ReactElement | null {
  useEffect(() => {
    if (!isOpen) return;
    ensureCountdownStyles();
  }, [isOpen]);

  if (!isOpen) return null;

  const fileCount = requests.length;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10002, // Above ConfirmDialog (10001) and CommitModal (10000)
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 10,
          boxShadow: '0 10px 35px rgba(0,0,0,0.25)',
          maxWidth: 720,
          width: '92%',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>
            Force replace requested
          </div>
        </div>

        <div style={{ padding: 22, fontSize: 13, color: '#374151', lineHeight: 1.55 }}>
          <div
            style={{
              marginBottom: 14,
              padding: '12px 14px',
              background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)',
              borderRadius: 10,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                border: '3px solid rgba(255,255,255,0.3)',
                borderTopColor: '#60a5fa',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                animation: 'force-replace-countdown-pulse 1s ease-in-out infinite',
              }}
            >
              {countdownSeconds}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 650 }}>
                Overwriting {fileCount} file{fileCount === 1 ? '' : 's'} in {countdownSeconds}s
              </div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                These files were cleared elsewhere. OK will overwrite your uncommitted local changes for those files.
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            {fileCount} file{fileCount === 1 ? '' : 's'} request a one-shot force replace:
          </div>

          <div
            style={{
              maxHeight: 220,
              overflow: 'auto',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: 10,
              background: '#f9fafb',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 12,
              color: '#111827',
            }}
          >
            {requests.map((r) => (
              <div key={r.fileId} style={{ padding: '3px 0' }}>
                {r.fileId} — {r.path || r.fileName}
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              background: '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Cancel (merge normally)
          </button>
          <button
            onClick={onOk}
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #1d4ed8',
              background: '#2563eb',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            OK (overwrite)
          </button>
        </div>
      </div>
    </div>
  );
}

