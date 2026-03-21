"""
Phase C: Slice DSL parsing and classification.

Pure functions for extracting context keys from sliceDSL strings,
grouping by dimension, and classifying MECE vs non-MECE.

See doc 14 §2 for the full specification.
"""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Temporal qualifier patterns (to strip from sliceDSL)
# ---------------------------------------------------------------------------

# Matches window(...), cohort(...), asat(...) including nested parens
_TEMPORAL_RE = re.compile(
    r"\.\s*(?:window|cohort|asat)\([^)]*\)"
    r"|^(?:window|cohort|asat)\([^)]*\)\s*\.?"
    r"|\.?\s*(?:window|cohort|asat)\([^)]*\)$",
    re.IGNORECASE,
)


def context_key(slice_dsl: str) -> str:
    """Extract the context portion of a sliceDSL, stripping temporal qualifiers.

    Examples:
        "context(channel:google).window(6-Sep-25:16-Mar-26)"
            → "context(channel:google)"
        "context(channel:google).context(device:mobile).cohort(...)"
            → "context(channel:google).context(device:mobile)"
        "window(6-Sep-25:16-Mar-26)"
            → ""  (empty = aggregate/unsliced)
        "visited(classic-cart).window(...)"
            → "visited(classic-cart)"
    """
    if not slice_dsl:
        return ""

    # Split into dot-separated parts, keep non-temporal ones
    parts = []
    for part in _split_dsl_parts(slice_dsl):
        lower = part.strip().lower()
        if lower.startswith(("window(", "cohort(", "asat(")):
            continue
        parts.append(part.strip())

    return ".".join(parts)


def _split_dsl_parts(dsl: str) -> list[str]:
    """Split a sliceDSL string on dots, respecting parenthesised content.

    "context(channel:google).window(6-Sep-25:16-Mar-26)" → ["context(channel:google)", "window(6-Sep-25:16-Mar-26)"]
    """
    parts = []
    depth = 0
    current = []
    for ch in dsl:
        if ch == '(':
            depth += 1
            current.append(ch)
        elif ch == ')':
            depth -= 1
            current.append(ch)
        elif ch == '.' and depth == 0:
            if current:
                parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append(''.join(current))
    return parts


def dimension_key(ctx_key: str) -> str:
    """Extract the dimension key from a context_key.

    "context(channel:google)" → "channel"
    "context(channel:google).context(device:mobile)" → "channel×device"
    "visited(classic-cart)" → "visited"
    "case(test:variant)" → "case:test"
    "" → ""

    Dimension keys are sorted alphabetically for determinism.
    """
    if not ctx_key:
        return ""

    parts = _split_dsl_parts(ctx_key)
    dims = []
    for part in parts:
        part = part.strip()
        lower = part.lower()
        if lower.startswith("context("):
            # Extract dimension name: context(channel:value) → channel
            inner = part[len("context("):-1] if part.endswith(")") else part[len("context("):]
            dim_name = inner.split(":")[0] if ":" in inner else inner
            dims.append(dim_name)
        elif lower.startswith("visited("):
            dims.append("visited")
        elif lower.startswith("visitedany("):
            dims.append("visitedAny")
        elif lower.startswith("case("):
            inner = part[len("case("):-1] if part.endswith(")") else part[len("case("):]
            case_name = inner.split(":")[0] if ":" in inner else inner
            dims.append(f"case:{case_name}")
        elif lower.startswith("contextany("):
            inner = part[len("contextAny("):-1] if part.endswith(")") else part[len("contextAny("):]
            dim_name = inner.split(":")[0] if ":" in inner else inner
            dims.append(dim_name)

    dims.sort()
    return "×".join(dims)


def is_mece_dimension(dim_key: str) -> bool:
    """Classify whether a dimension key represents a MECE partition.

    Per doc 14 §3.2 (Option C):
    - context() dimensions → MECE (channel, device, region, etc.)
    - case() dimensions → MECE (A/B test assignment is exclusive)
    - visited() → non-MECE (a user can visit multiple nodes)

    Compound dimensions (channel×device) are MECE if all component
    dimensions are MECE.
    """
    if not dim_key:
        return False

    components = dim_key.split("×")
    for comp in components:
        if comp == "visited" or comp == "visitedAny":
            return False
    return True


def extract_dimensions(slice_dsls: list[str]) -> dict[str, list[str]]:
    """Group a list of sliceDSL strings by dimension key.

    Returns dimension_key → [context_key, ...] mapping.
    Aggregate entries (empty context_key) are excluded.

    Example:
        ["context(channel:google).window(...)",
         "context(channel:social).window(...)",
         "window(...)"]
        →
        {"channel": ["context(channel:google)", "context(channel:social)"]}
    """
    result: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()

    for dsl in slice_dsls:
        ctx = context_key(dsl)
        if not ctx:
            continue  # aggregate — skip
        dim = dimension_key(ctx)
        if not dim:
            continue

        pair = (dim, ctx)
        if pair in seen:
            continue
        seen.add(pair)

        if dim not in result:
            result[dim] = []
        result[dim].append(ctx)

    return result
