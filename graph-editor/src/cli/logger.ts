/**
 * CLI logger — centralised stderr logging with consistent prefix.
 *
 * All CLI status/diagnostic output goes to stderr (stdout is reserved
 * for structured data output). This module replaces scattered
 * `console.error('[cli] ...')` calls with a consistent interface.
 */

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
};
