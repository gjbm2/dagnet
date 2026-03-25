/**
 * pythonApiBase — single source of truth for the Python API base URL.
 *
 * Dev:  derives from window.location.hostname so the app works whether
 *       accessed via localhost, 127.0.0.1, or a LAN/WSL IP.
 * Prod: empty string (Vercel serverless, same origin).
 */
export const PYTHON_API_BASE: string = import.meta.env.DEV
  ? (import.meta.env.VITE_PYTHON_API_URL || `http://${window.location.hostname || 'localhost'}:9000`)
  : '';
