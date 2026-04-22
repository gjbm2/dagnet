#!/usr/bin/env python3
"""Stop hook: persist briefing receipts for the current conversation.

PreToolUse cannot inspect the in-flight assistant message that contains a
blocked Edit/Write call, so this hook captures receipt blocks from
`last_assistant_message` after the response completes. The latest receipt is
cached immediately, and older receipts remain discoverable from the transcript.
"""

from __future__ import annotations

import json
import re
import sys

from context_gate_shared import (
    RECEIPT_CLOSE,
    RECEIPT_OPEN,
    find_receipt_in_text,
    most_recent_user_text,
    read_transcript,
    store_cached_receipt,
)


def transcript_path_for_event(payload: dict) -> str:
    agent_path = payload.get("agent_transcript_path")
    if isinstance(agent_path, str) and agent_path.strip():
        return agent_path
    transcript_path = payload.get("transcript_path")
    if isinstance(transcript_path, str):
        return transcript_path
    return ""


def message_is_receipt_only(message: str) -> bool:
    cleaned = re.sub(
        re.escape(RECEIPT_OPEN) + r".*?" + re.escape(RECEIPT_CLOSE),
        "",
        message,
        flags=re.S,
    )
    return cleaned.strip() == ""


def continue_message() -> str:
    return (
        "Briefing receipt recorded for this conversation. Continue with the "
        "scoped Edit/Write now, and do not re-emit the same receipt unless it changes."
    )


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0

    message = payload.get("last_assistant_message")
    if not isinstance(message, str) or not message.strip():
        return 0

    receipt = find_receipt_in_text(message)
    if receipt is None:
        return 0

    transcript_path = transcript_path_for_event(payload)
    transcript = read_transcript(transcript_path)
    user_idx, _ = most_recent_user_text(transcript)
    if user_idx < 0:
        return 0

    stored = store_cached_receipt(transcript_path, user_idx, receipt)
    if not stored:
        return 0

    if payload.get("stop_hook_active"):
        return 0

    response: dict[str, str] = {}
    loop_count = payload.get("loop_count", 0)
    status = payload.get("status")
    if status == "completed" and isinstance(loop_count, int) and loop_count < 1:
        response["followup_message"] = continue_message()

    if message_is_receipt_only(message) and "status" not in payload:
        # Backwards-compatible fallback for runtimes that honour Stop-hook
        # decision control rather than follow-up messages.
        response["decision"] = "block"
        response["reason"] = continue_message()

    if response:
        print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
