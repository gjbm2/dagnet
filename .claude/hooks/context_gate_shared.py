#!/usr/bin/env python3
"""Shared helpers for the context-enforcement hooks."""

from __future__ import annotations

import json
from pathlib import Path

RECEIPT_OPEN = "<briefing-receipt>"
RECEIPT_CLOSE = "</briefing-receipt>"
OVERRIDE_PREFIX = "briefing-override:"
CACHE_SUFFIX = ".briefing-receipt.json"
MAX_CACHED_RECEIPTS = 12


def read_transcript(path: str) -> list[dict]:
    if not path:
        return []
    transcript_path = Path(path).expanduser()
    if not transcript_path.exists():
        return []

    out = []
    with transcript_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def extract_text_blocks(msg_content) -> list[str]:
    """Return text items from a message content list or string."""
    if isinstance(msg_content, str):
        return [msg_content]
    if not isinstance(msg_content, list):
        return []

    texts = []
    for item in msg_content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            text = item.get("text", "")
            if isinstance(text, str):
                texts.append(text)
    return texts


def entry_role(entry: dict) -> str:
    """Return the conversational role for a transcript entry."""
    role = entry.get("type")
    if role in {"user", "assistant"}:
        return role

    role = entry.get("role")
    if role in {"user", "assistant"}:
        return role

    msg = entry.get("message", {}) or {}
    role = msg.get("role")
    if role in {"user", "assistant"}:
        return role
    return ""


def most_recent_user_text(transcript: list[dict]) -> tuple[int, str]:
    """Return (index, joined text) of the most recent genuine user message."""
    for i in range(len(transcript) - 1, -1, -1):
        entry = transcript[i]
        if entry_role(entry) != "user":
            continue

        msg = entry.get("message", {}) or {}
        content = msg.get("content", [])
        if isinstance(content, list):
            has_text = any(
                isinstance(c, dict) and c.get("type") == "text" for c in content
            )
            if not has_text:
                continue

        texts = extract_text_blocks(content)
        return i, "\n".join(texts)
    return -1, ""


def extract_receipt_blocks(text: str) -> list[str]:
    """Return all well-formed briefing-receipt bodies from text."""
    blocks: list[str] = []
    pos = 0
    while True:
        open_at = text.find(RECEIPT_OPEN, pos)
        if open_at == -1:
            break
        body_start = open_at + len(RECEIPT_OPEN)
        close_at = text.find(RECEIPT_CLOSE, body_start)
        if close_at == -1:
            break
        blocks.append(text[body_start:close_at].strip())
        pos = close_at + len(RECEIPT_CLOSE)
    return blocks


def find_receipt_in_text(text: str) -> str | None:
    blocks = extract_receipt_blocks(text)
    return blocks[-1] if blocks else None


def find_receipt_in_turn(transcript: list[dict], user_idx: int) -> str | None:
    """Scan assistant messages after user_idx for a briefing-receipt block."""
    buf = []
    for entry in transcript[user_idx + 1:]:
        if entry_role(entry) != "assistant":
            continue
        msg = entry.get("message", {}) or {}
        for txt in extract_text_blocks(msg.get("content", [])):
            buf.append(txt)
    return find_receipt_in_text("\n".join(buf))


def find_receipts_in_transcript(transcript: list[dict]) -> list[str]:
    """Return all assistant-emitted briefing receipts in transcript order."""
    receipts: list[str] = []
    for entry in transcript:
        if entry_role(entry) != "assistant":
            continue
        msg = entry.get("message", {}) or {}
        for txt in extract_text_blocks(msg.get("content", [])):
            receipts.extend(extract_receipt_blocks(txt))
    return receipts


def receipt_cache_path(transcript_path: str) -> Path | None:
    if not transcript_path:
        return None
    path = Path(transcript_path).expanduser()
    if not path.name:
        return None
    return path.with_name(f"{path.stem}{CACHE_SUFFIX}")


def load_cached_receipts(transcript_path: str) -> list[str]:
    cache_path = receipt_cache_path(transcript_path)
    if cache_path is None or not cache_path.exists():
        return []

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    receipts: list[str] = []
    cached_items = payload.get("receipts")
    if isinstance(cached_items, list):
        for item in cached_items:
            receipt = item.get("receipt") if isinstance(item, dict) else item
            if not isinstance(receipt, str):
                continue
            receipt = receipt.strip()
            if receipt and receipt not in receipts:
                receipts.append(receipt)

    legacy_receipt = payload.get("receipt")
    if isinstance(legacy_receipt, str):
        legacy_receipt = legacy_receipt.strip()
        if legacy_receipt and legacy_receipt not in receipts:
            receipts.append(legacy_receipt)

    return receipts


def load_cached_receipt(transcript_path: str, user_idx: int | None = None) -> str | None:
    """Return the newest cached receipt, regardless of user turn.

    `user_idx` is retained for backwards-compatible callers but is no longer
    used as a validity gate. Receipts are conversation-scoped: once emitted,
    they remain available for later turns in the same transcript.
    """
    receipts = load_cached_receipts(transcript_path)
    return receipts[0] if receipts else None


def store_cached_receipt(transcript_path: str, user_idx: int, receipt: str) -> bool:
    cache_path = receipt_cache_path(transcript_path)
    if cache_path is None:
        return False

    receipt = receipt.strip()
    if not receipt:
        return False

    existing = load_cached_receipts(transcript_path)
    receipts = [receipt] + [item for item in existing if item != receipt]
    receipts = receipts[:MAX_CACHED_RECEIPTS]
    payload = {
        "version": 2,
        "user_idx": user_idx,
        "receipts": [{"receipt": item} for item in receipts],
    }
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(payload), encoding="utf-8")
        return True
    except OSError:
        return False
