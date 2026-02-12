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
from typing import List, Tuple

_CLAUSE_RE = re.compile(r"(?:^|\.)([a-zA-Z_-]+)\(([^()]*)\)")
_MODE_CLAUSES = {"window", "cohort"}
_CANON_NAME = {
    "at": "asat",
    "asat": "asat",
    "contextany": "contextAny",
    "visitedany": "visitedAny",
}

def _split_top_level_args(args: str) -> List[str]:
    # Slice-key grammar forbids nested parentheses in args.
    return [t.strip() for t in str(args or "").split(",") if str(t or "").strip()]

def normalise_slice_key_for_matching(slice_key: str) -> str:
    """
    Normalise a slice_key for *matching* purposes.

    Historical data stores slice_key values that include date-range arguments inside
    window(...) / cohort(...). Those args are not part of slice identity for reads:
    the DB already carries time in anchor_day (what day) and retrieved_at (which version).

    Additionally, clause order is not semantically meaningful for constraint DSL:
      context(channel:paid-search).cohort() == cohort().context(channel:paid-search)

    We therefore canonicalise into a stable, order-independent representation:
    - strip args from window()/cohort()
    - normalise args for known clause types (e.g. contextAny pairs)
    - dedupe idempotent clauses
    - sort non-mode clauses, then append mode clauses (window/cohort) at the end
    """
    s = str(slice_key or "").strip().strip(".")
    if not s:
        return ""

    clauses: List[Tuple[str, str, str]] = []
    for m in _CLAUSE_RE.finditer(s):
        name_raw = str(m.group(1) or "").strip()
        name_lower = name_raw.lower()
        name = _CANON_NAME.get(name_lower, name_lower)
        args_raw = str(m.group(2) or "").strip()
        if not name_lower:
            continue
        clauses.append((name_lower, name, args_raw))

    if not clauses:
        # No DSL clauses found — preserve the raw string as-is.
        # This handles sentinel values like "__epoch_gap__" which are not DSL
        # but must survive as literal slice_key matchers (not collapse to "").
        return s

    def norm_args(name_lower: str, args_raw: str) -> str:
        if name_lower in _MODE_CLAUSES:
            return ""

        args = str(args_raw or "").strip()
        if name_lower in ("context", "case"):
            if not args:
                return ""
            if ":" not in args:
                return args.strip()
            k, v = args.split(":", 1)
            k = k.strip()
            v = v.strip()
            return f"{k}:{v}" if v else k

        if name_lower == "contextany":
            pairs = []
            for tok in _split_top_level_args(args):
                if ":" in tok:
                    k, v = tok.split(":", 1)
                    k = k.strip()
                    v = v.strip()
                else:
                    k = tok.strip()
                    v = ""
                if k:
                    pairs.append((k, v))
            uniq = sorted(set(pairs), key=lambda kv: (kv[0], kv[1]))
            return ",".join([f"{k}:{v}" if v else k for (k, v) in uniq])

        toks = _split_top_level_args(args)
        if len(toks) <= 1:
            return toks[0] if toks else ""
        uniq = sorted(set(toks))
        return ",".join(uniq)

    def clause_str(name_canon: str, args_norm: str) -> str:
        a = str(args_norm or "").strip()
        return f"{name_canon}({a})"

    canon_clauses = [
        (name_lower, clause_str(name_canon, norm_args(name_lower, args_raw)))
        for (name_lower, name_canon, args_raw) in clauses
    ]

    # Dedupe idempotent clauses by canonical string.
    mode = sorted({c for (n, c) in canon_clauses if n in _MODE_CLAUSES})
    rest = sorted({c for (n, c) in canon_clauses if n not in _MODE_CLAUSES})

    return ".".join(rest + mode)

