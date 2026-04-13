/**
 * Shared CLI entry-point setup — console suppression, polyfills,
 * and credential loading.
 *
 * Must run before any other imports to silence module-level logging
 * from dependencies (ShareBootResolver, AppDatabase, LAG debug, etc.).
 *
 * Credentials: auto-loads `.env.amplitude.local` from the repo root
 * so that `--allow-external-fetch` works without manual env setup.
 * See docs/archive/graph-editor-docs/AMPLITUDE_CREDENTIALS_SETUP.md.
 *
 * Usage in entry points:
 *   import { initCLI } from './cliEntry.js';
 *   initCLI();
 *   const { run } = await import('./commands/analyse.js');
 *   await run();
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Load key=value pairs from a dotenv file into process.env.
 * Does not override existing env vars.
 */
function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Don't override existing env vars
    process.env[key] ??= value;
  }
}

export function initCLI(): void {
  const rawArgs = process.argv.slice(2);
  const verbose = rawArgs.includes('--verbose') || rawArgs.includes('-v');
  const showSessionLog = rawArgs.includes('--session-log');

  if (!verbose) {
    const noop = () => {};
    console.log = noop;
    console.warn = noop;
    if (!showSessionLog) console.info = noop;
  }

  // Polyfill import.meta.env for Node (Vite provides this in browser).
  if (typeof (import.meta as any).env === 'undefined') {
    (import.meta as any).env = { DEV: false };
  }

  // Auto-load Amplitude credentials from repo-root .env.amplitude.local.
  // The file lives at <repo-root>/.env.amplitude.local; this file is in
  // <repo-root>/graph-editor/src/cli/, so walk up 3 levels.
  const repoRoot = resolve(dirname(import.meta.url.replace('file://', '')), '..', '..', '..');
  loadEnvFile(resolve(repoRoot, '.env.amplitude.local'));

  // Auto-enable the credentials manager's Node env-var path when keys
  // are available (the manager gates on DAGNET_LOCAL_E2E_CREDENTIALS).
  if (process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_SECRET_KEY) {
    process.env.DAGNET_LOCAL_E2E_CREDENTIALS ??= '1';
  }
}
