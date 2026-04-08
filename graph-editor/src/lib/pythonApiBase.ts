/**
 * pythonApiBase — single source of truth for the Python API base URL.
 *
 * Browser dev:  derives from window.location.hostname so the app works whether
 *               accessed via localhost, 127.0.0.1, or a LAN/WSL IP.
 * Browser prod: empty string (Vercel serverless, same origin).
 * Node (CLI):   PYTHON_API_URL env var, or http://localhost:9000.
 */
function resolvePythonApiBase(): string {
  // Node / CLI environment — no window, no import.meta.env.DEV
  if (typeof window === 'undefined') {
    return process.env.PYTHON_API_URL || 'http://localhost:9000';
  }
  // Browser prod (Vercel)
  if (!import.meta.env.DEV) return '';
  // Browser dev
  return import.meta.env.VITE_PYTHON_API_URL || `http://${window.location.hostname || 'localhost'}:9000`;
}

export const PYTHON_API_BASE: string = resolvePythonApiBase();
