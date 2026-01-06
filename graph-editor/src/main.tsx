import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { createDASRunner } from './lib/das';
import { consoleMirrorService } from './services/consoleMirrorService';
import { sessionLogMirrorService } from './services/sessionLogMirrorService';

// Make DAS Runner available globally for console testing
if (typeof window !== 'undefined') {
  (window as any).createDASRunner = createDASRunner;
}

// Dev-only: install console mirroring hook (off by default; opt-in via localStorage).
if (import.meta.env.DEV) {
  consoleMirrorService.install();
  sessionLogMirrorService.install();

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
