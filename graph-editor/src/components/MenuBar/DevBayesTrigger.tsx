import React, { useState, useEffect } from 'react';
import { useBayesTrigger } from '../../hooks/useBayesTrigger';
import type { BayesTriggerStatus, BayesComputeMode } from '../../hooks/useBayesTrigger';
import './MenuBar.css';

import { PYTHON_API_BASE } from '../../lib/pythonApiBase';

const STORAGE_KEY = 'dagnet-bayes-compute-mode';
const TUNNEL_START_URL = `${PYTHON_API_BASE}/api/bayes/tunnel/start`;
const TUNNEL_STOP_URL = `${PYTHON_API_BASE}/api/bayes/tunnel/stop`;
const TUNNEL_STATUS_URL = `${PYTHON_API_BASE}/api/bayes/tunnel/status`;

function getStoredMode(): BayesComputeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'modal' || v === 'local') return v;
  } catch { /* ignore */ }
  return 'local';
}

/**
 * Dev-only button + mode toggle for triggering a Bayes roundtrip.
 *
 * Positioned in MenuBar's dagnet-right-controls, next to DevConsoleMirrorControls.
 * Behaviour lives in useBayesTrigger; this component is a thin access point.
 */
export function DevBayesTrigger() {
  const [mode, setMode] = useState<BayesComputeMode>(getStoredMode);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const { status, jobId, error, trigger } = useBayesTrigger(mode);

  // On mount (or mode change), check if a tunnel is already running
  useEffect(() => {
    if (mode === 'modal') {
      fetch(TUNNEL_STATUS_URL)
        .then(r => r.json())
        .then(d => setTunnelUrl(d.tunnel_url ?? null))
        .catch(() => setTunnelUrl(null));
    }
  }, [mode]);

  if (!import.meta.env.DEV) return null;

  const statusLabel: Record<BayesTriggerStatus, string> = {
    idle: 'Bayes',
    submitting: 'Submitting…',
    running: 'Running…',
    complete: 'Done',
    failed: 'Failed',
  };

  const isActive = status === 'submitting' || status === 'running';

  const toggleMode = async () => {
    const next = mode === 'local' ? 'modal' : 'local';

    if (next === 'modal') {
      // Start tunnel when switching to Modal mode
      try {
        const resp = await fetch(TUNNEL_START_URL, { method: 'POST' });
        const data = await resp.json();
        setTunnelUrl(data.tunnel_url ?? null);
      } catch {
        setTunnelUrl(null);
      }
    } else {
      // Stop tunnel when switching away from Modal mode
      try {
        await fetch(TUNNEL_STOP_URL, { method: 'POST' });
      } catch { /* ignore */ }
      setTunnelUrl(null);
    }

    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  };

  const modeTitle = mode === 'modal' && tunnelUrl
    ? `Compute mode: ${mode}. Tunnel: ${tunnelUrl}. Click to switch.`
    : `Compute mode: ${mode}. Click to switch.`;

  return (
    <div className="dagnet-dev-bayes-controls">
      <button
        className="dagnet-dev-bayes-mode-toggle"
        onClick={toggleMode}
        disabled={isActive}
        type="button"
        title={modeTitle}
      >
        {mode === 'local' ? 'L' : 'M'}
      </button>
      <button
        className={`dagnet-dev-bayes-btn dagnet-dev-bayes-btn--${status}`}
        onClick={trigger}
        type="button"
        title={
          error
            ? `Last error: ${error}`
            : jobId
              ? `Last job: ${jobId} (${mode})`
              : `Submit Bayes fit (${mode})`
        }
      >
        {statusLabel[status]}
      </button>
    </div>
  );
}
