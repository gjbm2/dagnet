import React, { useState, useEffect } from 'react';
import { useNavigatorContext, useIsReadOnly } from '../contexts/NavigatorContext';
import { credentialsManager } from '../lib/credentials';
import toast from 'react-hot-toast';
import { startOAuthFlow, isOAuthEnabled } from '../services/githubOAuthService';

/**
 * Standalone menu bar chip for GitHub OAuth status.
 * Renders outside the Repository menu so clicks don't conflict with menu opening.
 *
 * States:
 * - OAuth disabled: renders nothing
 * - Not connected, no token: "read-only 🔗" (clickable)
 * - Not connected, shared PAT: "connect 🔗" (clickable)
 * - Connected (ghu_ token): "@username"
 */
export function GitHubOAuthChip() {
  const { state } = useNavigatorContext();
  const isReadOnly = useIsReadOnly();
  const [connectedUser, setConnectedUser] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(isOAuthEnabled());
  }, []);

  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    const handleCredentialsChanged = () => setRefreshCounter(c => c + 1);
    window.addEventListener('dagnet:oauthTokenApplied', handleCredentialsChanged);
    return () => window.removeEventListener('dagnet:oauthTokenApplied', handleCredentialsChanged);
  }, []);

  useEffect(() => {
    const check = async () => {
      if (!state.selectedRepo) { setConnectedUser(null); return; }
      const result = await credentialsManager.loadCredentials();
      const gitCreds = result.credentials?.git?.find((c: any) => c.name === state.selectedRepo);
      const token = gitCreds?.token || '';
      setConnectedUser(token.startsWith('ghu_') ? (gitCreds?.userName || 'connected') : null);
    };
    check();
  }, [state.selectedRepo, isReadOnly, refreshCounter]);

  if (!enabled) return null;

  if (connectedUser) {
    return (
      <span
        style={{
          fontSize: '11px',
          padding: '2px 6px',
          borderRadius: '3px',
          background: '#d1fae5',
          color: '#065f46',
          fontWeight: 500,
          cursor: 'default',
        }}
        title={`Connected as @${connectedUser}`}
      >
        @{connectedUser}
      </span>
    );
  }

  return (
    <span
      style={{
        fontSize: '11px',
        padding: '2px 6px',
        borderRadius: '3px',
        background: '#fef3c7',
        color: '#92400e',
        fontWeight: 500,
        cursor: 'pointer',
      }}
      title="Click to connect your GitHub account for write access"
      onClick={() => {
        if (state.selectedRepo) {
          const started = startOAuthFlow(state.selectedRepo);
          if (!started) {
            toast.error('OAuth not configured — check VITE_GITHUB_OAUTH_CLIENT_ID in your environment.');
          }
        }
      }}
    >
      {isReadOnly ? 'read-only' : 'connect'} 🔗
    </span>
  );
}
