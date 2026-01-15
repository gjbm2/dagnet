import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { createDASRunner } from './lib/das';
import { consoleMirrorService } from './services/consoleMirrorService';
import { sessionLogMirrorService } from './services/sessionLogMirrorService';
import { sessionLogService } from './services/sessionLogService';
import { installE2eHooks } from './dev/e2eHooks';

// Make DAS Runner available globally for console testing
if (typeof window !== 'undefined') {
  (window as any).createDASRunner = createDASRunner;
}

// Initialise session logging BEFORE React effects run.
// Without this, early share boot effects can emit logs which are then wiped when AppShell initialises.
void sessionLogService.initialize();

// Dev-only: install console mirroring hook (off by default; opt-in via localStorage).
if (import.meta.env.DEV) {
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
