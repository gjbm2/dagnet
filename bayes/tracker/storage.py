"""YAML storage with cross-process locking and atomic writes.

Every load re-validates against the schema. Unknown keys, missing
required fields, and enum violations raise a hard error — the tracker
refuses to serve reads or writes on a malformed file rather than
silently normalising it.
"""

from __future__ import annotations

import fcntl
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import yaml

from .schema import TrackerState


class TrackerStorageError(RuntimeError):
    """Malformed, missing, or unreadable tracker file."""


_process_lock = threading.RLock()


def _lock_path(path: Path) -> Path:
    return Path(str(path) + ".lock")


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Acquire a cross-process fcntl.flock on a sentinel file plus an
    in-process reentrant lock. The sentinel is stable across atomic
    replaces of the canonical YAML."""
    lp = _lock_path(path)
    lp.parent.mkdir(parents=True, exist_ok=True)
    with _process_lock:
        with open(lp, "a+b") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def atomic_write(path: Path, text: str) -> None:
    """Write `text` to `path` atomically: temp file in same dir, fsync,
    rename. Partial writes cannot be observed."""
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _yaml_dump(state: TrackerState) -> str:
    data = state.model_dump(mode="json", exclude_none=True)
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


def load(path: Path) -> TrackerState:
    if not path.exists():
        raise TrackerStorageError(f"tracker file not found: {path}")
    with exclusive_lock(path):
        raw = path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as e:
        raise TrackerStorageError(f"YAML parse error: {e}") from e
    try:
        state = TrackerState.model_validate(data)
        state.validate_cross_refs()
    except Exception as e:
        raise TrackerStorageError(f"schema validation failed: {e}") from e
    return state


def save(path: Path, state: TrackerState) -> None:
    state.validate_cross_refs()
    text = _yaml_dump(state)
    with exclusive_lock(path):
        atomic_write(path, text)
