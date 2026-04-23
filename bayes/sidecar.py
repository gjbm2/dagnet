"""
Cached Bayes patch sidecar for synth-graph test fixtures.

Routine pytest must stay read-only with respect to the shared synth
graph files. Instead of persisting projected Bayes fields onto those
graphs, we cache the raw worker/result payload in a small sidecar keyed
by the real Bayes inputs: the truth YAML plus the referenced parameter
files. When either changes, the sidecar invalidates and a fresh fit is
required.

The sidecar deliberately stores the *unprojected* payload. Tests then
replay that payload through the canonical TypeScript `applyPatch` path
in memory, so graph-edge posteriors, parameter-file `posterior.slices`,
`model_vars`, and promoted latency fields are all produced by the same
code path as production.

Public API:
    compute_fingerprint(truth_path, param_paths) -> dict
    save_sidecar(path, sidecar_fingerprint, payload) -> None
    load_sidecar(path, expected_fingerprint) -> dict | None
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from typing import Any, Dict, Iterable, Optional


SCHEMA_VERSION = 2

_RESERVED_SIDECAR_KEYS = {"schema_version", "generated_at", "sidecar_fingerprint"}


# ─── Fingerprint ───────────────────────────────────────────────────────

def _sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _param_id_from_path(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def compute_fingerprint(truth_path: str, param_paths: Iterable[str]) -> Dict[str, Any]:
    """Return a fingerprint that flips whenever truth or any param file
    content changes. Order of param_paths is not significant.

    Raises FileNotFoundError / OSError when truth_path is absent — a
    missing truth file is a hard error, not a silent fresh verdict.
    """
    truth_sha = _sha256_file(truth_path)
    param_hashes: Dict[str, str] = {}
    for p in param_paths:
        param_hashes[_param_id_from_path(p)] = _sha256_file(p)
    return {
        "truth_sha256": truth_sha,
        "param_file_hashes": param_hashes,
    }


# ─── Save / load ───────────────────────────────────────────────────────

def save_sidecar(
    path: str,
    sidecar_fingerprint: Dict[str, Any],
    payload: Dict[str, Any],
) -> None:
    """Write the sidecar JSON.

    The generated_at field is informational only — sidecar_fingerprint
    is the sole authority for staleness. Human-readable UK date format
    (`d-MMM-yy HH:MM:SS`) matches project conventions.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload_data = dict(payload or {})
    for key in _RESERVED_SIDECAR_KEYS:
        payload_data.pop(key, None)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now().strftime("%-d-%b-%y %H:%M:%S"),
        "sidecar_fingerprint": sidecar_fingerprint,
    }
    payload.update(payload_data)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
        f.write("\n")


def load_sidecar(
    path: str,
    expected_fingerprint: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Return the saved payload iff schema + fingerprint both match.

    Returns None when the file is absent, the schema is old, or the
    sidecar fingerprint drifts. Raises on malformed JSON — silent
    corruption is worse than a loud failure.
    """
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    if data.get("schema_version") != SCHEMA_VERSION:
        return None
    if data.get("sidecar_fingerprint") != expected_fingerprint:
        return None
    return data
