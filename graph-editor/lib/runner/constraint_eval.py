"""
Constraint evaluation helpers (Python runner)

Purpose:
- Provide a Python equivalent of the frontend's `parseConstraints` + `evaluateConstraint`
  for constraint-only DSL strings used by conditional probabilities (`conditional_p[i].condition`).

Supported constraint functions (parity with TS evaluateConstraint):
- visited(nodeId[,nodeId...])
- exclude(nodeId[,nodeId...])
- visitedAny(nodeId[,nodeId...])  (any in group satisfies)
- context(key:value)
- case(key:value)

Unsupported/ignored in conditional conditions:
- contextAny(...)
- window(...), cohort(...)
- minus(...), plus(...)

We make unsupported constructs explicit by raising ValueError when they are present.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, List, Tuple
import re


_FUNC_RE = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(")
_VISITED_RE = re.compile(r"visited\(\s*([^)]+?)\s*\)")
_EXCLUDE_RE = re.compile(r"exclude\(\s*([^)]+?)\s*\)")
_VISITED_ANY_RE = re.compile(r"visitedAny\(\s*([^)]+?)\s*\)")
_CASE_RE = re.compile(r"case\(\s*([^:()]+?)\s*:\s*([^)]+?)\s*\)")
_CONTEXT_RE = re.compile(r"context\(\s*([^:()]+?)\s*:\s*([^)]+?)\s*\)")


SUPPORTED_FUNCS = {"visited", "exclude", "visitedAny", "context", "case"}
UNSUPPORTED_FUNCS = {"contextAny", "window", "cohort", "minus", "plus", "from", "to"}


@dataclass(frozen=True)
class ParsedConstraintCondition:
    visited: List[str]
    exclude: List[str]
    visited_any: List[List[str]]
    cases: List[Tuple[str, str]]
    contexts: List[Tuple[str, str]]


def _split_csv(raw: str) -> List[str]:
    return [p.strip() for p in raw.split(",") if p.strip()]


def parse_constraint_condition(condition: Optional[str]) -> ParsedConstraintCondition:
    if not condition or not isinstance(condition, str):
        return ParsedConstraintCondition(visited=[], exclude=[], visited_any=[], cases=[], contexts=[])

    # Detect unsupported functions explicitly.
    funcs = {m.group(1) for m in _FUNC_RE.finditer(condition)}
    unknown = {f for f in funcs if (f not in SUPPORTED_FUNCS)}
    # If it contains explicit unsupported-known funcs, error. If it contains any other unknown, also error.
    if unknown:
        raise ValueError(f"Unsupported conditional condition DSL functions: {', '.join(sorted(unknown))}")

    visited: List[str] = []
    exclude: List[str] = []
    visited_any: List[List[str]] = []
    cases: List[Tuple[str, str]] = []
    contexts: List[Tuple[str, str]] = []

    for m in _VISITED_RE.finditer(condition):
        visited.extend(_split_csv(m.group(1)))

    for m in _EXCLUDE_RE.finditer(condition):
        exclude.extend(_split_csv(m.group(1)))

    for m in _VISITED_ANY_RE.finditer(condition):
        group = _split_csv(m.group(1))
        if group:
            # Deduplicate within group while preserving order
            seen = set()
            out: List[str] = []
            for nid in group:
                if nid in seen:
                    continue
                seen.add(nid)
                out.append(nid)
            if out:
                visited_any.append(out)

    for m in _CASE_RE.finditer(condition):
        cases.append((m.group(1).strip(), m.group(2).strip()))

    for m in _CONTEXT_RE.finditer(condition):
        contexts.append((m.group(1).strip(), m.group(2).strip()))

    return ParsedConstraintCondition(
        visited=visited,
        exclude=exclude,
        visited_any=visited_any,
        cases=cases,
        contexts=contexts,
    )


def evaluate_constraint_condition(
    condition: Optional[str],
    *,
    visited_nodes: set[str],
    context: Optional[Dict[str, str]] = None,
    case_variants: Optional[Dict[str, str]] = None,
) -> bool:
    parsed = parse_constraint_condition(condition)

    if parsed.visited:
        if not all(v in visited_nodes for v in parsed.visited):
            return False

    if parsed.exclude:
        if any(v in visited_nodes for v in parsed.exclude):
            return False

    if parsed.visited_any:
        if not any(any(v in visited_nodes for v in group) for group in parsed.visited_any):
            return False

    if parsed.contexts:
        if not context:
            return False
        if not all(context.get(k) == v for (k, v) in parsed.contexts):
            return False

    if parsed.cases:
        if not case_variants:
            return False
        if not all(case_variants.get(k) == v for (k, v) in parsed.cases):
            return False

    return True


def constraint_specificity_score(condition: Optional[str]) -> int:
    """
    Compute a "most specific wins" score for conditional condition strings.

    Policy (mirrors TS What-If matching):
    - Positive evidence of specificity: ANDed constraints (visited/exclude/context/case).
    - visitedAny(...) is OR-shaped and generally *less* specific as it grows; we apply a penalty.
    - Higher score wins; ties should be resolved by caller using stable ordering.
    """
    parsed = parse_constraint_condition(condition)
    positive = len(parsed.visited) + len(parsed.exclude) + len(parsed.cases) + len(parsed.contexts)
    visited_any_penalty = sum(len(g) for g in parsed.visited_any)
    return positive * 1000 - visited_any_penalty


