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
let _daemonMode = false;

/** Enable or disable diagnostic trace output. */
export function setDiagnostic(enabled: boolean): void {
  _diagnosticEnabled = enabled;
}

/** Returns true if diagnostic mode is active. */
export function isDiagnostic(): boolean {
  return _diagnosticEnabled;
}

/** Toggle daemon mode. When on, exit() throws CLIExitError instead of terminating. */
export function setDaemonMode(enabled: boolean): void {
  _daemonMode = enabled;
}

/** Returns true if daemon mode is active. */
export function isDaemonMode(): boolean {
  return _daemonMode;
}

/** Thrown by exit() when daemon mode is active so the daemon can catch it. */
export class CLIExitError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CLIExitError';
  }
}

/** Daemon-aware process exit. In daemon mode throws CLIExitError so the daemon
 *  can report the failure on its protocol channel without terminating. */
export function exit(code: number, message?: string): never {
  if (_daemonMode) {
    throw new CLIExitError(code, message ?? `CLI exit code ${code}`);
  }
  process.exit(code);
  throw new Error('unreachable');
}

export const log = {
  /** Informational status (e.g. "Loading graph...") */
  info: (msg: string) => console.error(`[cli] ${msg}`),

  /** Warnings that don't prevent completion */
  warn: (msg: string) => console.error(`[cli] WARNING: ${msg}`),

  /** Errors that will cause the command to fail */
  error: (msg: string) => console.error(`[cli] ERROR: ${msg}`),

  /** Fatal errors — logs and exits with the given code.
   *  In daemon mode this throws CLIExitError instead of terminating. */
  fatal: (msg: string, exitCode = 1): never => {
    console.error(`[cli] ERROR: ${msg}`);
    return exit(exitCode, msg);
  },

  /** Diagnostic trace — only emits when --diagnostic / --diag is active.
   *  Use for detailed per-edge, per-stage pipeline state that would be
   *  too noisy for normal operation but essential for debugging. */
  diag: (msg: string) => {
    if (_diagnosticEnabled) console.error(`[diag] ${msg}`);
  },
};
