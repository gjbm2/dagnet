import React from 'react';
import { useAutomationRunState } from '../hooks/useAutomationRunState';
import { automationRunService } from '../services/automationRunService';

export function AutomationBanner(): React.ReactElement | null {
  const state = useAutomationRunState();

  if (state.phase === 'idle') return null;

  const label =
    state.phase === 'waiting'
      ? 'Automation running (waiting for app to initialise)'
      : state.phase === 'stopping'
        ? 'Automation stopping…'
        : 'Automation running';

  const detail = state.graphName ? `Graph: ${state.graphName}` : state.graphFileId ? `Graph: ${state.graphFileId}` : '';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2000,
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

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => automationRunService.requestStop()}
          disabled={state.phase === 'stopping'}
          style={{
            border: '1px solid rgba(255,255,255,0.25)',
            background: state.phase === 'stopping' ? 'rgba(255,255,255,0.12)' : '#ef4444',
            color: '#fff',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: 700,
            cursor: state.phase === 'stopping' ? 'not-allowed' : 'pointer',
          }}
          title="Stop automation (will abort between steps and between retrieve items)"
        >
          Stop
        </button>
      </div>
    </div>
  );
}


