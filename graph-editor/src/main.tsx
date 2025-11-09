import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { createDASRunner } from './lib/das';

// Make DAS Runner available globally for console testing
if (typeof window !== 'undefined') {
  (window as any).createDASRunner = createDASRunner;
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
