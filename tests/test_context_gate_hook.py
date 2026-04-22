from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / ".claude" / "hooks" / "context-gate.py"
STOP_HOOK = REPO_ROOT / ".claude" / "hooks" / "context-stop.py"
TARGET = REPO_ROOT / "bayes" / "truth" / "synth-lat4.truth.yaml"
REQUIRED_READS = [
    REPO_ROOT / "docs" / "current" / "codebase" / "SYNC_SYSTEM_OVERVIEW.md",
    REPO_ROOT / "docs" / "current" / "codebase" / "RESERVED_QUERY_TERMS_GLOSSARY.md",
    REPO_ROOT / "docs" / "current" / "codebase" / "DEV_ENVIRONMENT_AND_HMR.md",
    REPO_ROOT / "docs" / "current" / "codebase" / "BAYESIAN_ENGINE_RESEARCH.md",
]


def _run_gate(transcript_path: Path) -> subprocess.CompletedProcess[str]:
    payload = {
        "tool_name": "Edit",
        "tool_input": {"file_path": str(TARGET)},
        "transcript_path": str(transcript_path),
        "session_id": "pytest",
        "cwd": str(REPO_ROOT),
        "hook_event_name": "PreToolUse",
    }
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(REPO_ROOT)
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def _run_stop(
    transcript_path: Path,
    last_assistant_message: str,
    *,
    stop_hook_active: bool = False,
    status: str | None = None,
    loop_count: int | None = None,
) -> subprocess.CompletedProcess[str]:
    payload = {
        "session_id": "pytest",
        "transcript_path": str(transcript_path),
        "cwd": str(REPO_ROOT),
        "hook_event_name": "Stop",
        "stop_hook_active": stop_hook_active,
        "last_assistant_message": last_assistant_message,
    }
    if status is not None:
        payload["status"] = status
    if loop_count is not None:
        payload["loop_count"] = loop_count
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(REPO_ROOT)
    return subprocess.run(
        [sys.executable, str(STOP_HOOK)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def _cache_path(transcript_path: Path) -> Path:
    return transcript_path.with_name(f"{transcript_path.stem}.briefing-receipt.json")


def _receipt_text() -> str:
    return """<briefing-receipt>
read:
 - docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md
 - docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md
 - docs/current/codebase/DEV_ENVIRONMENT_AND_HMR.md
 - docs/current/codebase/BAYESIAN_ENGINE_RESEARCH.md
invariants:
 - Cohort and window are distinct evidence families.
 - Changing the cohort anchor changes the raw cohort family.
 - Synthetic fixtures must use FE-authored identities for alternate cohort families.
call-sites:
 - none
</briefing-receipt>"""


def _receipt_text_missing_bayes_doc() -> str:
    return """<briefing-receipt>
read:
 - docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md
 - docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md
 - docs/current/codebase/DEV_ENVIRONMENT_AND_HMR.md
invariants:
 - Cohort and window are distinct evidence families.
 - Changing the cohort anchor changes the raw cohort family.
 - Synthetic fixtures must use FE-authored identities for alternate cohort families.
call-sites:
 - none
</briefing-receipt>"""


def test_context_gate_accepts_override_in_role_based_transcript(tmp_path: Path) -> None:
    transcript = tmp_path / "override.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "role": "user",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "briefing-override: trivial truth file update",
                        }
                    ]
                },
            }
        )
        + "\n"
    )

    result = _run_gate(transcript)

    assert result.returncode == 0, result.stderr
    assert "briefing-override active" in result.stderr


def test_context_gate_accepts_receipt_with_readfile_transcript(tmp_path: Path) -> None:
    transcript = tmp_path / "receipt.jsonl"
    lines = [
        {
            "role": "user",
            "message": {
                "content": [{"type": "text", "text": "please patch"}],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ReadFile",
                        "input": {"path": str(path)},
                    }
                    for path in REQUIRED_READS
                ],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": _receipt_text(),
                    }
                ],
            },
        },
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))

    result = _run_gate(transcript)

    assert result.returncode == 0, result.stderr


def test_stop_hook_caches_receipt_and_blocks_receipt_only_message(tmp_path: Path) -> None:
    transcript = tmp_path / "stop.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "role": "user",
                "message": {
                    "content": [{"type": "text", "text": "please patch"}],
                },
            }
        )
        + "\n"
    )

    result = _run_stop(transcript, _receipt_text())

    assert result.returncode == 0, result.stderr
    stdout = json.loads(result.stdout)
    assert stdout["decision"] == "block"
    assert "Briefing receipt recorded" in stdout["reason"]

    cache_payload = json.loads(_cache_path(transcript).read_text())
    assert cache_payload["user_idx"] == 0
    assert cache_payload["version"] == 2
    assert "BAYESIAN_ENGINE_RESEARCH.md" in cache_payload["receipts"][0]["receipt"]


def test_stop_hook_returns_followup_message_for_completed_status(tmp_path: Path) -> None:
    transcript = tmp_path / "stop-followup.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "role": "user",
                "message": {
                    "content": [{"type": "text", "text": "please patch"}],
                },
            }
        )
        + "\n"
    )

    result = _run_stop(
        transcript,
        _receipt_text(),
        status="completed",
        loop_count=0,
    )

    assert result.returncode == 0, result.stderr
    stdout = json.loads(result.stdout)
    assert "followup_message" in stdout
    assert "decision" not in stdout


def test_context_gate_accepts_cached_receipt_from_stop_hook(tmp_path: Path) -> None:
    transcript = tmp_path / "cached.jsonl"
    lines = [
        {
            "role": "user",
            "message": {
                "content": [{"type": "text", "text": "please patch"}],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ReadFile",
                        "input": {"path": str(path)},
                    }
                    for path in REQUIRED_READS
                ],
            },
        },
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))

    stop_result = _run_stop(transcript, _receipt_text())
    assert stop_result.returncode == 0, stop_result.stderr

    gate_result = _run_gate(transcript)
    assert gate_result.returncode == 0, gate_result.stderr


def test_context_gate_accepts_receipt_from_prior_user_turn(tmp_path: Path) -> None:
    transcript = tmp_path / "prior-turn.jsonl"
    initial_lines = [
        {
            "role": "user",
            "message": {
                "content": [{"type": "text", "text": "first patch"}],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ReadFile",
                        "input": {"path": str(path)},
                    }
                    for path in REQUIRED_READS
                ],
            },
        },
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in initial_lines))

    stop_result = _run_stop(transcript, _receipt_text())
    assert stop_result.returncode == 0, stop_result.stderr

    with transcript.open("a") as f:
        f.write(
            json.dumps(
                {
                    "role": "user",
                    "message": {
                        "content": [{"type": "text", "text": "second patch"}],
                    },
                }
            )
            + "\n"
        )

    gate_result = _run_gate(transcript)

    assert gate_result.returncode == 0, gate_result.stderr


def test_context_gate_falls_back_to_older_matching_receipt(tmp_path: Path) -> None:
    transcript = tmp_path / "older-matching.jsonl"
    lines = [
        {
            "role": "user",
            "message": {
                "content": [{"type": "text", "text": "first patch"}],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ReadFile",
                        "input": {"path": str(path)},
                    }
                    for path in REQUIRED_READS
                ],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [{"type": "text", "text": _receipt_text()}],
            },
        },
        {
            "role": "user",
            "message": {
                "content": [{"type": "text", "text": "second patch"}],
            },
        },
        {
            "role": "assistant",
            "message": {
                "content": [{"type": "text", "text": _receipt_text_missing_bayes_doc()}],
            },
        },
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))

    gate_result = _run_gate(transcript)

    assert gate_result.returncode == 0, gate_result.stderr
