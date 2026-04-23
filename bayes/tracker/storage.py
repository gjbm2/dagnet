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
from typing import IO, Iterator

import yaml

from .schema import TrackerState


class TrackerStorageError(RuntimeError):
    """Malformed, missing, or unreadable tracker file."""


def _lock_path(path: Path) -> Path:
    return Path(str(path) + ".lock")


class _LockEntry:
    __slots__ = ("rlock", "fh", "depth")

    def __init__(self) -> None:
        self.rlock = threading.RLock()
        self.fh: IO[bytes] | None = None
        self.depth = 0


_registry_mutex = threading.Lock()
_lock_registry: dict[str, _LockEntry] = {}


def _entry_for(key: str) -> _LockEntry:
    with _registry_mutex:
        e = _lock_registry.get(key)
        if e is None:
            e = _LockEntry()
            _lock_registry[key] = e
        return e


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Acquire a cross-process fcntl.flock on a sentinel file plus an
    in-process reentrant lock. Reentry from the same thread is safe —
    only the outermost acquirer takes/releases the flock. Cross-process
    safety comes from the flock itself."""
    lp = _lock_path(path)
    lp.parent.mkdir(parents=True, exist_ok=True)
    key = str(lp.absolute())
    entry = _entry_for(key)
    with entry.rlock:
        if entry.depth == 0:
            entry.fh = open(lp, "a+b")
            fcntl.flock(entry.fh.fileno(), fcntl.LOCK_EX)
        entry.depth += 1
        try:
            yield
        finally:
            entry.depth -= 1
            if entry.depth == 0 and entry.fh is not None:
                fcntl.flock(entry.fh.fileno(), fcntl.LOCK_UN)
                entry.fh.close()
                entry.fh = None


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
