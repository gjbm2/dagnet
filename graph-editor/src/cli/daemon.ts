#!/usr/bin/env node
/**
 * dagnet-cli daemon — long-lived process that serves analyse / param-pack
 * requests over NDJSON on stdin/stdout.
 *
 * Pays the Node + tsx + module-graph startup cost once instead of per call.
 * Same fidelity as the standalone CLI: each request reuses the existing
 * `commands/analyse.ts` and `commands/paramPack.ts` `run()` functions, so
 * preparation, BE dispatch, and result serialisation are byte-identical.
 *
 * Wire format (one JSON object per line, both directions):
 *
 *   Request:   {"id": "<string>", "command": "analyse"|"param-pack"|"ping"|"quit",
 *               "args": ["--graph", "/path", "--name", "g", ...]}
 *
 *   Response:  {"id": "<string>", "ok": true,  "stdout": "<captured stdout>"}
 *           or {"id": "<string>", "ok": false, "exit_code": <n>,
 *               "error": "<msg>", "stdout": "<captured stdout up to failure>"}
 *
 *   Lifecycle: a single `{"ready": true, "pid": <pid>}` line is emitted
 *   before the first request is read, so clients can wait for it.
 *   `quit` exits cleanly. Idle for IDLE_TIMEOUT_MS (default 5 minutes)
 *   also exits cleanly.
 *
 * Per-request reset surface (anything that leaks between requests goes here):
 *   - process.argv (rewritten per request)
 *   - global flags __dagnetDiagnostics, __dagnetComputeNoCache
 *   - logger diagnostic flag
 *   - fileRegistry: re-seeded from disk by bootstrap → seedFileRegistry,
 *     which overwrites any prior --bayes-vars in-place mutations
 *
 * Process.exit() in commands is replaced by exit() (logger.ts) which throws
 * CLIExitError in daemon mode. The handler catches and reports as a failed
 * response, so a bad request never kills the daemon.
 */

import { initCLI } from './cliEntry.js';
import { setDaemonMode, setDiagnostic, CLIExitError, log } from './logger.js';

// Capture stdout.write before any per-request monkey-patching so the daemon
// always emits its protocol on the real channel.
const realStdoutWrite = process.stdout.write.bind(process.stdout);

setDaemonMode(true);
initCLI();
await import('fake-indexeddb/auto');

const { run: runAnalyse } = await import('./commands/analyse.js');
const { run: runParamPack } = await import('./commands/paramPack.js');

const IDLE_TIMEOUT_MS = Number(process.env.DAGNET_DAEMON_IDLE_MS ?? 5 * 60 * 1000);

interface DaemonRequest {
  id: string;
  command: 'analyse' | 'param-pack' | 'ping' | 'quit';
  args?: string[];
}

interface DaemonResponse {
  id: string;
  ok: boolean;
  exit_code?: number;
  error?: string;
  stdout?: string;
}

function writeProtocol(obj: unknown): void {
  realStdoutWrite(JSON.stringify(obj) + '\n');
}

function resetPerRequest(args: string[]): void {
  // Globals consulted by analyse.ts / BE adapters.
  delete (globalThis as Record<string, unknown>).__dagnetDiagnostics;
  delete (globalThis as Record<string, unknown>).__dagnetComputeNoCache;
  // Diagnostic flag is cleared and then bootstrap will re-enable if --diag/--diagnostic.
  setDiagnostic(args.includes('--diag') || args.includes('--diagnostic'));
}

async function handleRequest(req: DaemonRequest): Promise<DaemonResponse> {
  if (req.command === 'ping') return { id: req.id, ok: true, stdout: 'pong' };

  const args = req.args ?? [];
  resetPerRequest(args);

  // Rewrite process.argv so bootstrap()'s parseArgs reads the right flags.
  // First two slots mirror Node's argv[0] (executable) + argv[1] (script).
  process.argv = ['node', `cli-${req.command}`, ...args];

  // Capture stdout for this request only. Stderr is left alone so log.info /
  // log.warn / log.diag still surface live for the operator (and the test
  // fixture can choose whether to forward them).
  const stdoutChunks: string[] = [];
  const capturedWrite = ((chunk: unknown): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capturedWrite;

  try {
    if (req.command === 'analyse') {
      await runAnalyse();
    } else if (req.command === 'param-pack') {
      await runParamPack();
    } else {
      throw new Error(`unknown command: ${req.command}`);
    }
    return { id: req.id, ok: true, stdout: stdoutChunks.join('') };
  } catch (err) {
    const exitCode = err instanceof CLIExitError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: req.id,
      ok: false,
      exit_code: exitCode,
      error: message,
      stdout: stdoutChunks.join(''),
    };
  } finally {
    process.stdout.write = realStdoutWrite;
  }
}

let idleTimer: NodeJS.Timeout | null = null;
function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log.info(`Daemon idle for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s — exiting.`);
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
  // Don't keep the event loop alive on the timer alone — stdin EOF should still exit.
  idleTimer.unref?.();
}

// Serialise request handling: BE can't handle concurrent requests safely,
// and the FE preparation pipeline mutates process-wide state.
let queue: Promise<void> = Promise.resolve();

function enqueue(line: string): void {
  queue = queue.then(async () => {
    let req: DaemonRequest;
    try {
      req = JSON.parse(line) as DaemonRequest;
    } catch (err) {
      writeProtocol({
        id: '',
        ok: false,
        error: `malformed JSON request: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (req.command === 'quit') {
      writeProtocol({ id: req.id, ok: true, stdout: 'bye' });
      process.exit(0);
    }
    resetIdleTimer();
    const resp = await handleRequest(req);
    writeProtocol(resp);
  });
}

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) enqueue(line);
  }
});
process.stdin.on('end', () => {
  // Flush any in-flight work, then exit.
  queue.finally(() => process.exit(0));
});

writeProtocol({ ready: true, pid: process.pid });
log.info(`Daemon ready (pid ${process.pid}, idle timeout ${Math.round(IDLE_TIMEOUT_MS / 1000)}s)`);
resetIdleTimer();
