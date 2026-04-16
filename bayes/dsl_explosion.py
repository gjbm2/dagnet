"""
DSL Explosion — Python port of graph-editor/src/lib/dslExplosion.ts.

Recursive descent parser for compound query DSL expressions.
Produces a list of atomic clause strings from compound expressions.

Equivalences (all produce the same atomic clauses):
    (a;b).c  =  c.(a;b)  =  or(a,b).c  =  or(a.c,b.c)  =  a.c;b.c
    a;b;c    =  or(a,b,c)
    or(a,or(b,c))  =  a;b;c

This module handles structural explosion only (semicolons, or(),
parenthesised groups, dot-distribution).  Bare-key expansion
(context(channel) → one clause per value) is NOT included because it
requires runtime access to the context registry; callers that need it
must expand bare keys separately after calling explode_dsl().
"""

from __future__ import annotations


def explode_dsl(dsl: str) -> list[str]:
    """Explode a compound DSL string into atomic clause strings.

    Returns a list of non-empty, stripped clause strings.
    Empty input returns [].
    """
    if not dsl or not dsl.strip():
        return []
    branches = _parse_expression(dsl.strip())
    # Filter empty branches, strip whitespace
    return [b.strip() for b in branches if b.strip()]


# ---------------------------------------------------------------------------
# Core recursive descent parser
# ---------------------------------------------------------------------------

def _parse_expression(dsl: str) -> list[str]:
    trimmed = dsl.strip()
    if not trimmed:
        return [trimmed]

    # --- or(...) possibly followed by suffix ---
    if _starts_with_or(trimmed):
        open_idx = trimmed.index("(", 2)
        paren_end = _find_matching_paren(trimmed, open_idx)
        if paren_end == -1:
            raise ValueError(f"Unbalanced parentheses in DSL near: {trimmed}")
        or_part = trimmed[:paren_end + 1]
        suffix = trimmed[paren_end + 1:]

        contents = _extract_function_contents(or_part, "or")
        parts = _smart_split(contents, ",", keep_empty=True)
        branches: list[str] = []
        for part in parts:
            if part == "":
                # Empty part in or() → uncontexted branch
                branches.append(suffix[1:] if suffix.startswith(".") else (suffix or ""))
            else:
                part_branches = _parse_expression(part)
                for branch in part_branches:
                    branches.extend(_parse_expression(branch + suffix))
        return branches

    # --- (...) outer parens that wrap the entire string → strip ---
    if trimmed.startswith("(") and not trimmed.startswith("or("):
        paren_end = _find_matching_paren(trimmed, 0)
        if paren_end == len(trimmed) - 1:
            inner = trimmed[1:-1]
            return _parse_expression(inner)

    # --- (...)suffix or (...)(suffix) → cartesian distribution ---
    if trimmed.startswith("(") or trimmed.startswith("or("):
        open_idx = trimmed.index("(")
        paren_end = _find_matching_paren(trimmed, open_idx)
        if paren_end != -1 and paren_end < len(trimmed) - 1:
            next_char = trimmed[paren_end + 1]
            if next_char in (".", "("):
                prefix = trimmed[:paren_end + 1]
                # For (...)(suffix), insert a dot so distribution works uniformly
                if next_char == "(":
                    suffix = "." + trimmed[paren_end + 1:]
                else:
                    suffix = trimmed[paren_end + 1:]

                prefix_branches = _parse_expression(prefix)
                branches = []
                for b in prefix_branches:
                    branches.extend(_parse_expression(b + suffix))
                return branches

    # --- prefix.(...) ---
    dot_paren_idx = _find_dot_paren(trimmed)
    if dot_paren_idx > 0:
        prefix = trimmed[:dot_paren_idx]
        rest = trimmed[dot_paren_idx + 1:]  # skip the dot
        rest_branches = _parse_expression(rest)
        return [prefix if b == "" else f"{prefix}.{b}" for b in rest_branches]

    # --- prefix.or(...) ---
    dot_or_idx = _find_dot_or(trimmed)
    if dot_or_idx > 0:
        prefix = trimmed[:dot_or_idx]
        or_start = dot_or_idx + 1  # points at 'o' in 'or('
        open_paren_idx = trimmed.index("(", or_start)
        paren_end = _find_matching_paren(trimmed, open_paren_idx)
        if paren_end == -1:
            raise ValueError(
                f"Unbalanced parentheses in DSL near: {trimmed[or_start:]}"
            )
        or_part = trimmed[or_start:paren_end + 1]
        suffix = trimmed[paren_end + 1:]

        prefix_branches = _parse_expression(prefix)
        or_branches = _parse_expression(or_part)

        branches = []
        for pb in prefix_branches:
            for ob in or_branches:
                branches.extend(_parse_expression(f"{pb}.{ob}{suffix}"))
        return branches

    # --- Top-level semicolons ---
    if ";" in trimmed:
        parts = _smart_split(trimmed, ";", keep_empty=True)
        branches = []
        for part in parts:
            if part == "":
                branches.append("")
            else:
                branches.extend(_parse_expression(part))
        return branches

    # --- Atomic expression ---
    return [trimmed]


# ---------------------------------------------------------------------------
# Helper: detect or( at start, allowing whitespace between 'or' and '('
# ---------------------------------------------------------------------------

def _starts_with_or(s: str) -> bool:
    if not s.startswith("or"):
        return False
    j = 2
    while j < len(s) and s[j].isspace():
        j += 1
    return j < len(s) and s[j] == "("


# ---------------------------------------------------------------------------
# Helper: find prefix.( pattern at depth 0
# ---------------------------------------------------------------------------

def _find_dot_paren(s: str) -> int:
    depth = 0
    for i in range(len(s) - 1):
        ch = s[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth == 0 and s[i:i + 2] == ".(":
            # Make sure this isn't .or(
            rest = s[i + 1:]
            if rest.startswith("or"):
                j = 2
                while j < len(rest) and rest[j].isspace():
                    j += 1
                if j < len(rest) and rest[j] == "(":
                    continue  # This is .or(...), not .(...)
            return i
    return -1


# ---------------------------------------------------------------------------
# Helper: find prefix.or( pattern at depth 0
# ---------------------------------------------------------------------------

def _find_dot_or(s: str) -> int:
    depth = 0
    for i in range(len(s) - 4):
        ch = s[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth != 0:
            continue
        if s[i] != ".":
            continue
        rest = s[i + 1:]
        if not rest.startswith("or"):
            continue
        j = 2
        while j < len(rest) and rest[j].isspace():
            j += 1
        if j < len(rest) and rest[j] == "(":
            return i
    return -1


# ---------------------------------------------------------------------------
# Parenthesis matching
# ---------------------------------------------------------------------------

def _find_matching_paren(s: str, open_index: int) -> int:
    depth = 1
    for i in range(open_index + 1, len(s)):
        if s[i] == "(":
            depth += 1
        elif s[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


# ---------------------------------------------------------------------------
# Extract contents of funcname(...)
# ---------------------------------------------------------------------------

def _extract_function_contents(s: str, func_name: str) -> str:
    start = s.index("(")
    end = _find_matching_paren(s, start)
    if end == -1:
        raise ValueError(
            f"Unbalanced parentheses in {func_name}() expression: {s}"
        )
    return s[start + 1:end]


# ---------------------------------------------------------------------------
# Paren-aware split on a single-char separator
# ---------------------------------------------------------------------------

def _smart_split(s: str, sep: str, *, keep_empty: bool = False) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0

    for ch in s:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == sep and depth == 0:
            piece = "".join(current).strip()
            if keep_empty or piece:
                parts.append(piece)
            current = []
            continue
        else:
            current.append(ch)

    piece = "".join(current).strip()
    if keep_empty or piece:
        parts.append(piece)
    return parts
