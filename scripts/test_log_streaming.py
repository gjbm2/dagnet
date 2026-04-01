#!/usr/bin/env python3
"""
Integration tests for the dev log streaming pipeline.

Tests the real scripts end-to-end:
  - scripts/jsonl-tee.py  (stdin → JSONL file + stdout passthrough)
  - scripts/extract-mark-logs.sh  (mark-windowed extraction from JSONL)
  - Vite mark propagation format (mark entries in Python log file)

Run:  cd <repo-root> && python -m pytest scripts/test_log_streaming.py -v
"""
import json
import os
import subprocess
import tempfile
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
JSONL_TEE = REPO_ROOT / 'scripts' / 'jsonl-tee.py'
EXTRACT_SCRIPT = REPO_ROOT / 'scripts' / 'extract-mark-logs.sh'


# ── jsonl-tee.py tests ────────────────────────────────────────────────

class TestJsonlTee:
    """Contract: pipe stdin lines to stdout unchanged AND append JSONL to file."""

    def test_passthrough_matches_input(self, tmp_path):
        """stdout must be identical to stdin — the tee must not eat or mangle lines."""
        out_file = tmp_path / 'out.jsonl'
        input_lines = "line one\nline two\nline three\n"

        result = subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input=input_lines, capture_output=True, text=True, timeout=5,
        )

        assert result.returncode == 0
        assert result.stdout == input_lines

    def test_jsonl_entries_have_correct_schema(self, tmp_path):
        """Each non-empty line must produce a JSONL entry with kind, ts_ms, level, message."""
        out_file = tmp_path / 'out.jsonl'
        input_lines = "[tag] hello world\nINFO: request ok\n"

        subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input=input_lines, capture_output=True, text=True, timeout=5,
        )

        entries = [json.loads(l) for l in out_file.read_text().strip().splitlines()]
        assert len(entries) == 2

        for e in entries:
            assert e['kind'] == 'py'
            assert isinstance(e['ts_ms'], int)
            assert e['ts_ms'] > 0
            assert e['level'] == 'stdout'
            assert isinstance(e['message'], str)
            assert len(e['message']) > 0

        assert entries[0]['message'] == '[tag] hello world'
        assert entries[1]['message'] == 'INFO: request ok'

    def test_empty_lines_are_skipped_in_jsonl(self, tmp_path):
        """Empty and whitespace-only lines must pass through but NOT produce JSONL entries."""
        out_file = tmp_path / 'out.jsonl'
        input_lines = "real line\n\n   \nanother real line\n"

        result = subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input=input_lines, capture_output=True, text=True, timeout=5,
        )

        # Passthrough preserves all lines including blanks
        assert result.stdout == input_lines

        # JSONL has only the two real lines
        entries = [json.loads(l) for l in out_file.read_text().strip().splitlines()]
        assert len(entries) == 2
        assert entries[0]['message'] == 'real line'
        assert entries[1]['message'] == 'another real line'

    def test_special_characters_are_json_escaped(self, tmp_path):
        """Quotes, backslashes, and unicode must survive JSON encoding."""
        out_file = tmp_path / 'out.jsonl'
        input_lines = 'has "quotes" and \\backslash\nhas tàbs\n'

        subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input=input_lines, capture_output=True, text=True, timeout=5,
        )

        entries = [json.loads(l) for l in out_file.read_text().strip().splitlines()]
        assert entries[0]['message'] == 'has "quotes" and \\backslash'
        assert entries[1]['message'] == 'has tàbs'

    def test_appends_to_existing_file(self, tmp_path):
        """Must append, not overwrite, if the file already exists."""
        out_file = tmp_path / 'out.jsonl'
        out_file.write_text('{"existing":"entry"}\n')

        subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input="new line\n", capture_output=True, text=True, timeout=5,
        )

        lines = out_file.read_text().strip().splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0]) == {"existing": "entry"}
        assert json.loads(lines[1])['message'] == 'new line'

    def test_creates_parent_directories(self, tmp_path):
        """Must create intermediate directories if they don't exist."""
        out_file = tmp_path / 'sub' / 'dir' / 'out.jsonl'

        subprocess.run(
            ['python3', str(JSONL_TEE), str(out_file)],
            input="hello\n", capture_output=True, text=True, timeout=5,
        )

        assert out_file.exists()
        entries = [json.loads(l) for l in out_file.read_text().strip().splitlines()]
        assert len(entries) == 1


# ── extract-mark-logs.sh tests ────────────────────────────────────────

class TestExtractMarkLogs:
    """Contract: extract log windows between marks from JSONL stream files."""

    @pytest.fixture
    def debug_dir(self, tmp_path):
        """Create a fake debug directory with all three stream files."""
        d = tmp_path / 'debug'
        d.mkdir()
        (d / 'graph-snapshots').mkdir()
        return d

    def _write_stream(self, debug_dir, filename, entries):
        """Write a list of dicts as JSONL lines."""
        path = debug_dir / filename
        with open(path, 'w') as f:
            for e in entries:
                f.write(json.dumps(e) + '\n')
        return path

    def _run_extract(self, debug_dir, args):
        """Run extract-mark-logs.sh with patched file paths."""
        # The script uses hardcoded paths relative to REPO_ROOT.
        # We can't override them, so we create a patched copy.
        script_text = EXTRACT_SCRIPT.read_text()
        script_text = script_text.replace(
            'CONSOLE_LOG="$REPO_ROOT/debug/tmp.browser-console.jsonl"',
            f'CONSOLE_LOG="{debug_dir}/tmp.browser-console.jsonl"',
        )
        script_text = script_text.replace(
            'SESSION_LOG="$REPO_ROOT/debug/tmp.session-log.jsonl"',
            f'SESSION_LOG="{debug_dir}/tmp.session-log.jsonl"',
        )
        script_text = script_text.replace(
            'PYTHON_LOG="$REPO_ROOT/debug/tmp.python-server.jsonl"',
            f'PYTHON_LOG="{debug_dir}/tmp.python-server.jsonl"',
        )
        script_text = script_text.replace(
            'SNAPSHOTS_DIR="$REPO_ROOT/debug/graph-snapshots"',
            f'SNAPSHOTS_DIR="{debug_dir}/graph-snapshots"',
        )
        # Also patch diag dump paths
        script_text = script_text.replace(
            'DIAG_DUMP="$REPO_ROOT/debug/tmp.diag-state.json"',
            f'DIAG_DUMP="{debug_dir}/tmp.diag-state.json"',
        )
        script_text = script_text.replace(
            'DIAG_DUMP_OLD="$REPO_ROOT/debug/tmp.registry-dump.json"',
            f'DIAG_DUMP_OLD="{debug_dir}/tmp.registry-dump.json"',
        )

        patched = debug_dir / '_extract.sh'
        patched.write_text(script_text)
        patched.chmod(0o755)

        result = subprocess.run(
            ['bash', str(patched)] + args,
            capture_output=True, text=True, timeout=10,
        )
        return result

    def test_python_stream_windowed_by_marks(self, debug_dir):
        """Python log entries between two marks are extracted correctly."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "py", "ts_ms": 1000, "level": "stdout", "message": "before mark"},
            {"kind": "mark", "ts_ms": 2000, "label": "my-mark"},
            {"kind": "py", "ts_ms": 2001, "level": "stdout", "message": "inside window"},
            {"kind": "py", "ts_ms": 2002, "level": "stdout", "message": "also inside"},
            {"kind": "mark", "ts_ms": 3000, "label": "next-mark"},
            {"kind": "py", "ts_ms": 3001, "level": "stdout", "message": "after window"},
        ])

        result = self._run_extract(debug_dir, ['my-mark', '--python-only'])

        assert result.returncode == 0
        assert 'inside window' in result.stdout
        assert 'also inside' in result.stdout
        assert 'before mark' not in result.stdout
        assert 'after window' not in result.stdout

    def test_last_mark_used_by_default(self, debug_dir):
        """When multiple marks match, only the LAST one's window is shown."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "bug"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "first window"},
            {"kind": "mark", "ts_ms": 2000, "label": "bug"},
            {"kind": "py", "ts_ms": 2001, "level": "stdout", "message": "second window"},
        ])

        result = self._run_extract(debug_dir, ['bug', '--python-only'])

        assert 'second window' in result.stdout
        assert 'first window' not in result.stdout

    def test_all_flag_shows_every_matching_window(self, debug_dir):
        """--all must show windows from every matching mark."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "bug"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "first window"},
            {"kind": "mark", "ts_ms": 2000, "label": "bug"},
            {"kind": "py", "ts_ms": 2001, "level": "stdout", "message": "second window"},
        ])

        result = self._run_extract(debug_dir, ['bug', '--python-only', '--all'])

        assert 'first window' in result.stdout
        assert 'second window' in result.stdout

    def test_python_only_excludes_other_streams(self, debug_dir):
        """--python-only must NOT show console or session streams."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "log", "ts_ms": 1001, "level": "log", "args": ["console stuff"]},
        ])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [
            {"kind": "session", "ts_ms": 1000, "operation": "DEV_MARK", "message": "test"},
            {"kind": "session", "ts_ms": 1001, "operation": "GIT_PULL", "message": "session stuff"},
        ])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "python stuff"},
        ])

        result = self._run_extract(debug_dir, ['test', '--python-only'])

        assert 'python stuff' in result.stdout
        assert 'console stuff' not in result.stdout
        assert 'session stuff' not in result.stdout

    def test_console_only_excludes_python(self, debug_dir):
        """--console-only must NOT show Python stream."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "log", "ts_ms": 1001, "level": "log", "args": ["console stuff"]},
        ])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "python stuff"},
        ])

        result = self._run_extract(debug_dir, ['test', '--console-only'])

        assert 'console stuff' in result.stdout
        assert 'PYTHON SERVER STREAM' not in result.stdout

    def test_session_only_excludes_python(self, debug_dir):
        """--session-only must NOT show Python stream."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [
            {"kind": "session", "ts_ms": 1000, "operation": "DEV_MARK", "message": "test"},
            {"kind": "session", "ts_ms": 1001, "operation": "GIT_PULL", "message": "session stuff"},
        ])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "python stuff"},
        ])

        result = self._run_extract(debug_dir, ['test', '--session-only'])

        assert 'session stuff' in result.stdout
        assert 'PYTHON SERVER STREAM' not in result.stdout

    def test_default_shows_all_three_streams(self, debug_dir):
        """No filter flag must show console + session + python."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "log", "ts_ms": 1001, "level": "log", "args": ["console line"]},
        ])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [
            {"kind": "session", "ts_ms": 1000, "operation": "DEV_MARK", "message": "test"},
            {"kind": "session", "ts_ms": 1001, "operation": "GIT_PULL", "message": "session line"},
        ])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "test"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "python line"},
        ])

        result = self._run_extract(debug_dir, ['test'])

        assert 'CONSOLE STREAM' in result.stdout
        assert 'SESSION STREAM' in result.stdout
        assert 'PYTHON SERVER STREAM' in result.stdout
        assert 'console line' in result.stdout
        assert 'session line' in result.stdout
        assert 'python line' in result.stdout

    def test_trim_reduces_all_three_files(self, debug_dir):
        """--trim must trim console, session, AND python log files."""
        for fname, mark_pattern in [
            ('tmp.browser-console.jsonl', {"kind": "mark", "ts_ms": 1, "label": "m"}),
            ('tmp.session-log.jsonl', {"kind": "session", "ts_ms": 1, "operation": "DEV_MARK", "message": "m"}),
            ('tmp.python-server.jsonl', {"kind": "mark", "ts_ms": 1, "label": "m"}),
        ]:
            entries = [mark_pattern]
            for i in range(50):
                entries.append({"kind": "py", "ts_ms": 100 + i, "level": "stdout", "message": f"line {i}"})
            self._write_stream(debug_dir, fname, entries)

        result = self._run_extract(debug_dir, ['--trim', '10'])

        assert result.returncode == 0
        # Each file should be trimmed
        for fname in ['tmp.browser-console.jsonl', 'tmp.session-log.jsonl', 'tmp.python-server.jsonl']:
            lines = (debug_dir / fname).read_text().strip().splitlines()
            assert len(lines) <= 10, f"{fname} has {len(lines)} lines, expected <= 10"

    def test_no_mark_match_reports_cleanly(self, debug_dir):
        """Searching for a nonexistent mark must not crash."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "py", "ts_ms": 1000, "level": "stdout", "message": "no marks here"},
        ])

        result = self._run_extract(debug_dir, ['nonexistent', '--python-only'])

        assert result.returncode == 0
        assert 'no marks matching' in result.stdout

    def test_window_extends_to_eof_when_no_next_mark(self, debug_dir):
        """If there's no mark after the matched one, window extends to EOF."""
        self._write_stream(debug_dir, 'tmp.browser-console.jsonl', [])
        self._write_stream(debug_dir, 'tmp.session-log.jsonl', [])
        self._write_stream(debug_dir, 'tmp.python-server.jsonl', [
            {"kind": "mark", "ts_ms": 1000, "label": "only-mark"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "line A"},
            {"kind": "py", "ts_ms": 1002, "level": "stdout", "message": "line B"},
            {"kind": "py", "ts_ms": 1003, "level": "stdout", "message": "line C"},
        ])

        result = self._run_extract(debug_dir, ['only-mark', '--python-only'])

        assert 'line A' in result.stdout
        assert 'line B' in result.stdout
        assert 'line C' in result.stdout


# ── Mark format compatibility ─────────────────────────────────────────

class TestMarkFormat:
    """The Vite middleware writes marks to the Python log with a specific format.
    The extract script must recognise that format."""

    def test_vite_propagated_mark_is_extractable(self, tmp_path):
        """Marks written by Vite middleware (kind:mark) must be found by the extract script."""
        debug_dir = tmp_path / 'debug'
        debug_dir.mkdir()
        (debug_dir / 'graph-snapshots').mkdir()

        # Simulate: jsonl-tee wrote server lines, Vite injected a mark
        py_log = debug_dir / 'tmp.python-server.jsonl'
        entries = [
            {"kind": "py", "ts_ms": 999, "level": "stdout", "message": "server started"},
            # This is the exact format the Vite middleware writes:
            {"kind": "mark", "ts_ms": 1000, "label": "vite-mark"},
            {"kind": "py", "ts_ms": 1001, "level": "stdout", "message": "after mark"},
        ]
        with open(py_log, 'w') as f:
            for e in entries:
                f.write(json.dumps(e) + '\n')

        # Empty other streams
        (debug_dir / 'tmp.browser-console.jsonl').write_text('')
        (debug_dir / 'tmp.session-log.jsonl').write_text('')

        # Patch and run extract script
        script_text = EXTRACT_SCRIPT.read_text()
        for old, new in [
            ('CONSOLE_LOG="$REPO_ROOT/debug/tmp.browser-console.jsonl"',
             f'CONSOLE_LOG="{debug_dir}/tmp.browser-console.jsonl"'),
            ('SESSION_LOG="$REPO_ROOT/debug/tmp.session-log.jsonl"',
             f'SESSION_LOG="{debug_dir}/tmp.session-log.jsonl"'),
            ('PYTHON_LOG="$REPO_ROOT/debug/tmp.python-server.jsonl"',
             f'PYTHON_LOG="{debug_dir}/tmp.python-server.jsonl"'),
            ('SNAPSHOTS_DIR="$REPO_ROOT/debug/graph-snapshots"',
             f'SNAPSHOTS_DIR="{debug_dir}/graph-snapshots"'),
            ('DIAG_DUMP="$REPO_ROOT/debug/tmp.diag-state.json"',
             f'DIAG_DUMP="{debug_dir}/tmp.diag-state.json"'),
            ('DIAG_DUMP_OLD="$REPO_ROOT/debug/tmp.registry-dump.json"',
             f'DIAG_DUMP_OLD="{debug_dir}/tmp.registry-dump.json"'),
        ]:
            script_text = script_text.replace(old, new)

        patched = debug_dir / '_extract.sh'
        patched.write_text(script_text)
        patched.chmod(0o755)

        result = subprocess.run(
            ['bash', str(patched), 'vite-mark', '--python-only'],
            capture_output=True, text=True, timeout=10,
        )

        assert result.returncode == 0
        assert 'after mark' in result.stdout
        assert 'server started' not in result.stdout
