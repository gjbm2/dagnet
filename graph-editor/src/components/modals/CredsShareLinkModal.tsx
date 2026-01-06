import React, { useMemo, useState } from 'react';
import type { CredentialsData } from '../../types/credentials';
import { useCopyCredsShareLink } from '../../hooks/useCopyCredsShareLink';

export interface CredsShareLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  credentials: CredentialsData | null | undefined;
}

export function CredsShareLinkModal({ isOpen, onClose, credentials }: CredsShareLinkModalProps) {
  const [selectedRepoName, setSelectedRepoName] = useState<string>('');
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({ kind: 'idle' });

  const { copyForRepo } = useCopyCredsShareLink(credentials);

  const repoNames = useMemo(() => {
    const git = Array.isArray(credentials?.git) ? credentials!.git : [];
    return git.map((g) => g?.name).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  }, [credentials]);

  // Default selection on open
  React.useEffect(() => {
    if (!isOpen) return;
    if (repoNames.length > 0) {
      setSelectedRepoName((prev) => prev || repoNames[0]);
    } else {
      setSelectedRepoName('');
    }
    setStatus({ kind: 'idle' });
  }, [isOpen, repoNames]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (!selectedRepoName) return;
    const res = await copyForRepo(selectedRepoName);
    if (res.ok) {
      setStatus({ kind: 'ok', message: 'Copied link to clipboard' });
      setTimeout(() => setStatus({ kind: 'idle' }), 2500);
    } else {
      setStatus({ kind: 'error', message: res.error });
    }
  };

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
        zIndex: 10000,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          width: 'min(720px, 92vw)',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            position: 'sticky',
            top: 0,
            background: '#fff',
            borderBottom: '1px solid #e5e7eb',
            padding: '16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            zIndex: 1,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Share credentials link (unsafe)</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              This will embed a Git token in the URL query string.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              padding: '0 8px',
              color: '#6b7280',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ padding: 16 }}>
          <div
            style={{
              border: '1px solid #fca5a5',
              background: '#fef2f2',
              color: '#991b1b',
              borderRadius: 8,
              padding: 12,
              fontSize: 13,
              lineHeight: 1.4,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Warning: token-in-URL</div>
            <div>
              The generated link contains your Git token in <code>?creds=</code>. Anyone who gets the URL can use that token
              until it expires. Links may leak via browser history, screenshots, logs, or referrers. Use only time-limited
              read-only tokens and share at your own risk.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#374151', fontWeight: 700 }}>Repo credential</div>
              <select
                value={selectedRepoName}
                onChange={(e) => {
                  setSelectedRepoName(e.target.value);
                  setStatus({ kind: 'idle' });
                }}
                style={{
                  minWidth: 320,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  fontSize: 13,
                  background: '#fff',
                }}
                disabled={repoNames.length === 0}
              >
                {repoNames.length === 0 ? (
                  <option value="">No git credentials available</option>
                ) : (
                  repoNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))
                )}
              </select>
            </label>

            <button
              onClick={handleCopy}
              disabled={!selectedRepoName}
              style={{
                background: selectedRepoName ? '#dc2626' : '#fca5a5',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '9px 14px',
                fontSize: 13,
                fontWeight: 700,
                cursor: selectedRepoName ? 'pointer' : 'not-allowed',
              }}
            >
              Copy share link
            </button>

            {status.kind !== 'idle' && (
              <div
                style={{
                  fontSize: 13,
                  color: status.kind === 'ok' ? '#065f46' : '#991b1b',
                  background: status.kind === 'ok' ? '#ecfdf5' : '#fef2f2',
                  border: `1px solid ${status.kind === 'ok' ? '#6ee7b7' : '#fca5a5'}`,
                  borderRadius: 6,
                  padding: '8px 10px',
                }}
              >
                {status.message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


