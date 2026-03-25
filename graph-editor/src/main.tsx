// ---------------------------------------------------------------------------
// Polyfill: crypto.randomUUID + crypto.subtle for insecure contexts
// (e.g. http:// on a non-localhost IP such as a WSL address).
// Must run BEFORE any other import that calls crypto.randomUUID().
// ---------------------------------------------------------------------------
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  // Fallback UUID v4 using crypto.getRandomValues (available in all modern browsers)
  (crypto as any).randomUUID = (): string => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { createDASRunner } from './lib/das';
import { getURLBooleanParam } from './lib/urlSettings';
import { consoleMirrorService } from './services/consoleMirrorService';
import { sessionLogMirrorService } from './services/sessionLogMirrorService';
import { devDiagnosticService } from './services/devDiagnosticService';
import { sessionLogService } from './services/sessionLogService';
import { installE2eHooks } from './dev/e2eHooks';

// Make DAS Runner available globally for console testing
if (typeof window !== 'undefined') {
  (window as any).createDASRunner = createDASRunner;
}

// URL param: enable verbose session logging (off by default).
// Must run BEFORE sessionLogService.initialize() so early operations log with the intended verbosity.
if (typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(window.location.search);
    if (getURLBooleanParam(params, 'sessionlogdiag')) {
      sessionLogService.setDiagnosticLoggingEnabled(true);
    }
  } catch {
    // Ignore URL parsing failures (tests/non-browser environments)
  }
}

// Initialise session logging BEFORE React effects run.
// Without this, early share boot effects can emit logs which are then wiped when AppShell initialises.
void sessionLogService.initialize();

// If enabled (e.g. via ?sessionlogdiag), record an explicit note in the session log for debuggability.
if (sessionLogService.getDiagnosticLoggingEnabled()) {
  sessionLogService.info(
    'session',
    'DIAGNOSTIC_LOGGING_ENABLED',
    'Diagnostic session logging enabled via URL parameter',
    'param: sessionlogdiag'
  );
}

// Dev-only: install console mirroring hook (off by default; opt-in via localStorage).
// IMPORTANT: devDiagnosticService.install() MUST run BEFORE consoleMirrorService.install()
// so it captures the real (pre-hook) console.warn/log references.
if (import.meta.env.DEV) {
  devDiagnosticService.install();
  consoleMirrorService.install();
  sessionLogMirrorService.install();
  installE2eHooks();

  // If console mirroring was already enabled via localStorage, ensure the session log mirror
  // is enabled too (so both streams stay in sync after reloads).
  if (consoleMirrorService.isEnabled()) {
    sessionLogMirrorService.enable();
  }
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
