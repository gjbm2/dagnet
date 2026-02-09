"""
Slice key normalisation helpers.

These helpers are intentionally lightweight (no DB imports) so they can be used
both by the DB read/write layer (`snapshot_service.py`) and the pure in-memory
derivation runners (e.g. cohort maturity).

Normalisation semantics:
- window(<anything>) -> window()
- cohort(<anything>) -> cohort()

The arguments inside window()/cohort() are not part of slice identity for reads.
Time is carried by anchor_day (cohort day) and retrieved_at (version as-at).
"""

from __future__ import annotations

import re

_SLICE_TEMPORAL_ARGS_RE = re.compile(r"(?:^|\.)(window|cohort)\([^)]*\)")


def normalise_slice_key_for_matching(slice_key: str) -> str:
    """
    Normalise a slice_key for *matching* purposes.

    Historical data stores slice_key values that include date-range arguments inside
    window(...) / cohort(...). Those args are not part of slice identity for reads:
    the DB already carries time in anchor_day (what day) and retrieved_at (which version).
    """
    s = (slice_key or "").strip()
    if not s:
        return ""
    s = _SLICE_TEMPORAL_ARGS_RE.sub(lambda m: f".{m.group(1)}()", s).lstrip(".")
    return s

