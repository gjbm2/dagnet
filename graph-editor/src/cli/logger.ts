/**
 * CLI logger — centralised stderr logging with consistent prefix.
 *
 * All CLI status/diagnostic output goes to stderr (stdout is reserved
 * for structured data output). This module replaces scattered
 * `console.error('[cli] ...')` calls with a consistent interface.
 *
 * Diagnostic mode (--diagnostic / --diag) emits detailed pipeline
 * trace information via log.diag(). Enable with setDiagnostic(true)
 * — called automatically by cliEntry.ts when the flag is present.
 */

let _diagnosticEnabled = false;

/** Enable or disable diagnostic trace output. */
export function setDiagnostic(enabled: boolean): void {
  _diagnosticEnabled = enabled;
}

/** Returns true if diagnostic mode is active. */
export function isDiagnostic(): boolean {
  return _diagnosticEnabled;
}

export const log = {
  /** Informational status (e.g. "Loading graph...") */
  info: (msg: string) => console.error(`[cli] ${msg}`),

  /** Warnings that don't prevent completion */
  warn: (msg: string) => console.error(`[cli] WARNING: ${msg}`),

  /** Errors that will cause the command to fail */
  error: (msg: string) => console.error(`[cli] ERROR: ${msg}`),

  /** Fatal errors — logs and exits with the given code */
  fatal: (msg: string, exitCode = 1): never => {
    console.error(`[cli] ERROR: ${msg}`);
    process.exit(exitCode);
    // TypeScript needs this for `never` return type
    throw new Error('unreachable');
  },

  /** Diagnostic trace — only emits when --diagnostic / --diag is active.
   *  Use for detailed per-edge, per-stage pipeline state that would be
   *  too noisy for normal operation but essential for debugging. */
  diag: (msg: string) => {
    if (_diagnosticEnabled) console.error(`[diag] ${msg}`);
  },
};
