"""dagnet-cli daemon client — spawn the long-lived daemon and dispatch requests.

Replaces per-call `subprocess.run(['bash', 'analyse.sh', ...])` with a single
daemon process that serves NDJSON requests. Pays the Node + tsx + module-graph
cold-start cost once per pytest session instead of once per call.

Wire format mirrors `graph-editor/src/cli/daemon.ts`:
    Request  : {"id": "<n>", "command": "analyse"|"param-pack", "args": [...]}
    Response : {"id": "<n>", "ok": true,  "stdout": "..."}
            or {"id": "<n>", "ok": false, "exit_code": N, "error": "...", "stdout": "..."}

Usage:
    client = DaemonClient.start()
    resp = client.call("analyse", ["--graph", "/path", ...])
    client.quit()

Lifetime is normally managed by the pytest session fixture in conftest.py.
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional


_DAGNET_ROOT = Path(__file__).resolve().parents[3]
_DAEMON_SH = _DAGNET_ROOT / "graph-ops" / "scripts" / "daemon.sh"

# Set DAGNET_USE_DAEMON=0 to fall back to per-call subprocess invocations
# (e.g. when bisecting a daemon-specific issue).
_DAEMON_DISABLED = os.environ.get("DAGNET_USE_DAEMON", "1") == "0"

# Slow-call diagnostic threshold (seconds). When a daemon request takes
# longer than this, DaemonClient.call emits a self-diagnostic block so
# operators can see WHY a call blew up rather than the catch-all
# "sometimes it's slow". Override per-environment with
# DAGNET_SLOW_CALL_THRESHOLD_S; set to 0 to disable.
_SLOW_CALL_THRESHOLD_S = float(os.environ.get("DAGNET_SLOW_CALL_THRESHOLD_S", "10"))

_default_client: Optional["DaemonClient"] = None
_default_client_lock = threading.Lock()


class DaemonError(RuntimeError):
    """Raised when the daemon reports a request failure."""

    def __init__(self, message: str, exit_code: int, stdout: str, stderr: str) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


class DaemonClient:
    """A live connection to a single dagnet-cli daemon subprocess."""

    def __init__(self, proc: subprocess.Popen) -> None:
        self._proc = proc
        self._lock = threading.Lock()
        self._counter = 0
        self._stderr_buf: list[str] = []
        self._spawn_monotonic = time.monotonic()
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True
        )
        self._stderr_thread.start()

    @classmethod
    def start(cls, *, env: Optional[dict[str, str]] = None) -> "DaemonClient":
        """Spawn the daemon and wait for the ready handshake."""
        proc = subprocess.Popen(
            ["bash", str(_DAEMON_SH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env or dict(os.environ),
        )
        ready_line = proc.stdout.readline()
        if not ready_line:
            stderr = proc.stderr.read() if proc.stderr else ""
            raise DaemonError(
                f"daemon failed to start. stderr:\n{stderr}",
                exit_code=proc.returncode or -1,
                stdout="",
                stderr=stderr,
            )
        ready = json.loads(ready_line)
        if not ready.get("ready"):
            raise DaemonError(
                f"unexpected daemon ready handshake: {ready_line!r}",
                exit_code=-1,
                stdout=ready_line,
                stderr="",
            )
        return cls(proc)

    def _drain_stderr(self) -> None:
        if self._proc.stderr is None:
            return
        for line in self._proc.stderr:
            self._stderr_buf.append(line)
            # Cap to last ~1000 lines to bound memory if the daemon is chatty.
            if len(self._stderr_buf) > 1000:
                del self._stderr_buf[:500]

    def _next_id(self) -> str:
        with self._lock:
            self._counter += 1
            return str(self._counter)

    def call(self, command: str, args: list[str]) -> str:
        """Send a request and return the captured stdout from the command.

        Raises DaemonError on non-zero exit. Thread-safe via internal lock,
        but the daemon serialises requests internally so concurrent callers
        will block on each other's I/O.
        """
        if self._proc.poll() is not None:
            raise DaemonError(
                f"daemon is no longer running (exit {self._proc.returncode})",
                exit_code=self._proc.returncode or -1,
                stdout="",
                stderr="".join(self._stderr_buf[-200:]),
            )

        req_id = self._next_id()
        req = {"id": req_id, "command": command, "args": args}
        payload = json.dumps(req) + "\n"

        t_start = time.monotonic()
        stderr_mark = len(self._stderr_buf)
        with self._lock:
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None
            self._proc.stdin.write(payload)
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
        elapsed = time.monotonic() - t_start
        if _SLOW_CALL_THRESHOLD_S > 0 and elapsed > _SLOW_CALL_THRESHOLD_S:
            self._emit_slow_call_diagnostic(
                command=command, args=args, elapsed=elapsed,
                stderr_mark=stderr_mark,
            )

        if not line:
            stderr = "".join(self._stderr_buf[-200:])
            raise DaemonError(
                f"daemon closed stdout mid-request. stderr tail:\n{stderr}",
                exit_code=-1,
                stdout="",
                stderr=stderr,
            )
        resp = json.loads(line)
        if resp.get("id") != req_id:
            raise DaemonError(
                f"response id mismatch: sent {req_id}, got {resp.get('id')!r}",
                exit_code=-1,
                stdout=resp.get("stdout", ""),
                stderr="".join(self._stderr_buf[-200:]),
            )
        if not resp.get("ok"):
            raise DaemonError(
                resp.get("error") or "daemon reported failure",
                exit_code=resp.get("exit_code", 1),
                stdout=resp.get("stdout", ""),
                stderr="".join(self._stderr_buf[-200:]),
            )
        return resp.get("stdout", "")

    def call_json(self, command: str, args: list[str]) -> dict[str, Any]:
        """Convenience wrapper: call() + parse the captured stdout as JSON.

        Strips any leading non-JSON noise (some commands prepend banner text
        before the first `{`), matching the existing _parse_json_stdout
        helper used by the subprocess code path.
        """
        stdout = self.call(command, args)
        idx = stdout.find("{")
        if idx < 0:
            raise DaemonError(
                f"no JSON in {command} stdout. head:\n{stdout[:500]}",
                exit_code=-1,
                stdout=stdout,
                stderr="",
            )
        return json.loads(stdout[idx:])

    def _emit_slow_call_diagnostic(
        self,
        *,
        command: str,
        args: list[str],
        elapsed: float,
        stderr_mark: int,
    ) -> None:
        """Print an audit block when a single daemon request exceeds the
        configured threshold. The block is intended to give the operator
        enough state to triage WHY the call was slow rather than treating
        the slowness as ambient noise.
        """
        # Reconstruct the user-visible CLI surface from the args list so
        # the slow request is replayable from the log line alone.
        graph_idx = args.index("--name") + 1 if "--name" in args else -1
        graph = args[graph_idx] if 0 < graph_idx < len(args) else "<unknown>"
        query_idx = args.index("--query") + 1 if "--query" in args else -1
        query = args[query_idx] if 0 < query_idx < len(args) else "<no query>"
        type_idx = args.index("--type") + 1 if "--type" in args else -1
        atype = args[type_idx] if 0 < type_idx < len(args) else "(param-pack)"

        # Daemon stderr emitted DURING this request only — anything before
        # stderr_mark belongs to a previous request and is excluded.
        new_stderr = "".join(self._stderr_buf[stderr_mark:]).strip()

        # Daemon age — recorded at spawn, immune to /proc/stat parsing bugs.
        proc_age_s = time.monotonic() - self._spawn_monotonic

        rss_mb: float | None = None
        try:
            with open(f"/proc/{self._proc.pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_mb = float(line.split()[1]) / 1024
                        break
        except Exception:
            pass

        bar = "─" * 76
        msg = [
            "",
            f"┌{bar}",
            f"│ [daemon-slow-call] {elapsed:.2f}s exceeded threshold "
            f"({_SLOW_CALL_THRESHOLD_S:.1f}s)",
            f"│   command:   {command}",
            f"│   type:      {atype}",
            f"│   graph:     {graph}",
            f"│   query:     {query}",
            f"│   daemon pid={self._proc.pid} age={proc_age_s:.1f}s",
            f"│   daemon RSS={rss_mb:.1f} MiB" if rss_mb is not None else
            "│   daemon RSS=?",
        ]
        if new_stderr:
            msg.append("│   daemon stderr during this request:")
            for line in new_stderr.splitlines()[-30:]:
                msg.append(f"│     {line}")
        else:
            msg.append("│   daemon stderr during this request: (empty)")
        msg.append(f"└{bar}")
        print("\n".join(msg), file=sys.stderr, flush=True)

    def quit(self) -> None:
        """Send a quit request and wait for the daemon to exit."""
        if self._proc.poll() is not None:
            return
        try:
            with self._lock:
                if self._proc.stdin is not None:
                    self._proc.stdin.write(
                        json.dumps({"id": "quit", "command": "quit"}) + "\n"
                    )
                    self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=5)


def get_default_client() -> Optional["DaemonClient"]:
    """Return the process-wide daemon client, lazily started on first use.

    Returns None when DAGNET_USE_DAEMON=0 — callers should fall back to the
    per-call subprocess path. The daemon is shut down via atexit so the
    pytest session does not leave it dangling.
    """
    if _DAEMON_DISABLED:
        return None
    global _default_client
    if _default_client is not None:
        return _default_client
    with _default_client_lock:
        if _default_client is None:
            _default_client = DaemonClient.start()
            atexit.register(_shutdown_default_client)
    return _default_client


def _shutdown_default_client() -> None:
    global _default_client
    if _default_client is not None:
        try:
            _default_client.quit()
        except Exception:
            pass
        _default_client = None
