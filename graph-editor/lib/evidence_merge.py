"""
Stage 1 typed shared evidence merge library for BE CF and Bayes.

Implements the design in docs/current/project-bayes/73h-shared-evidence-merge-design.md.

This module is pure: it does not query the database, read files, or
import any project-specific row shapes. Callers (BE CF adapter, Bayes
adapter, as-at reconstruction adapter — Stages 2+) convert their native
row shapes into typed `EvidenceCandidate`s and call
`merge_evidence_candidates`.

The module deliberately leaves the legacy file_evidence_supplement.py
helpers untouched. Stage 7 retires those.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date as _date, datetime
from enum import Enum
from typing import Any, Optional


# ─── Enumerations ──────────────────────────────────────────────────────


class EvidenceRole(str, Enum):
    WINDOW_SUBJECT_HELPER = "window_subject_helper"
    DIRECT_COHORT_EXACT_SUBJECT = "direct_cohort_exact_subject"
    BAYES_PHASE1_WINDOW = "bayes_phase1_window"
    BAYES_PHASE2_COHORT = "bayes_phase2_cohort"


class SourceKind(str, Enum):
    SNAPSHOT = "snapshot"
    FILE = "file"
    RECONSTRUCTED = "reconstructed"


class SliceFamily(str, Enum):
    WINDOW = "window"
    COHORT = "cohort"
    CONTEXT = "context"
    UNKNOWN = "unknown"


class TemporalBasis(str, Enum):
    WINDOW_DAY = "window_day"
    ANCHOR_DAY = "anchor_day"
    UNKNOWN = "unknown"


_WINDOW_ROLES = frozenset(
    {EvidenceRole.WINDOW_SUBJECT_HELPER, EvidenceRole.BAYES_PHASE1_WINDOW}
)
_COHORT_ROLES = frozenset(
    {EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT, EvidenceRole.BAYES_PHASE2_COHORT}
)


def _role_family(role: EvidenceRole) -> SliceFamily:
    if role in _WINDOW_ROLES:
        return SliceFamily.WINDOW
    if role in _COHORT_ROLES:
        return SliceFamily.COHORT
    raise ValueError(f"unknown evidence role: {role!r}")


# ─── Skip reasons (canonical set; documented for adapter parity) ──────


SKIP_REASONS = frozenset(
    {
        "subject_mismatch",
        "out_of_date_bounds",
        "invalid_counts",
        "non_positive_n",
        "unsupported_context",
        "context_mismatch",
        "regime_mismatch",
        "wrong_role",
        "wrong_cohort_anchor",
        "wrong_population_identity",
        "missing_retrieved_at",
        "after_as_at",
        "after_retrieved_at",
        "covered_by_snapshot",
        "superseded_by_later_retrieval",
    }
)

PROVENANCE_SCHEMA_VERSION = "evidence_provenance.v1"


# ─── Core typed objects ────────────────────────────────────────────────


@dataclass(frozen=True)
class EvidenceIdentity:
    """The summability identity for compatible rows.

    Two candidates may be summed only if their identities are equal.
    `observed_date` and `retrieved_at` are NOT part of identity — they
    live on `ObservationCoordinate`.
    """

    role: EvidenceRole
    subject_from: str
    subject_to: str
    anchor: Optional[str]
    slice_family: SliceFamily
    context_key: Optional[str]
    regime_key: Optional[str]
    population_identity: Optional[str]


@dataclass(frozen=True)
class ObservationCoordinate:
    observed_date: str
    retrieved_at: Optional[str]
    temporal_basis: TemporalBasis = TemporalBasis.UNKNOWN
    asat_materialised: bool = False


@dataclass(frozen=True)
class EvidenceCandidate:
    source: SourceKind
    identity: EvidenceIdentity
    coordinate: ObservationCoordinate
    n: int
    k: int
    provenance: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EvidenceScope:
    role: EvidenceRole
    subject_from: str
    subject_to: str
    date_from: str
    date_to: str
    as_at: Optional[str] = None
    scenario_id: Optional[str] = None
    anchor: Optional[str] = None
    context_key: Optional[str] = None
    regime_key: Optional[str] = None
    population_universe_key: Optional[str] = None
    selected_anchor_days: Sequence[str] = ()
    scope_population_identity: Optional[str] = None


@dataclass(frozen=True)
class EvidencePoint:
    candidate: EvidenceCandidate

    @property
    def n(self) -> int:
        return self.candidate.n

    @property
    def k(self) -> int:
        return self.candidate.k

    @property
    def source(self) -> SourceKind:
        return self.candidate.source


@dataclass(frozen=True)
class SkippedCandidate:
    candidate: EvidenceCandidate
    reason: str


@dataclass(frozen=True)
class EvidenceTotals:
    n: int = 0
    k: int = 0

    @property
    def mean(self) -> float:
        return (self.k / self.n) if self.n > 0 else 0.0


@dataclass(frozen=True)
class EvidenceProvenance:
    schema_version: str
    role: EvidenceRole
    scope_key: str
    scenario_id: Optional[str]
    as_at: Optional[str]
    selected_slice_families: tuple[SliceFamily, ...]
    selected_snapshot_families: tuple[SliceFamily, ...]
    skipped_counts_by_reason: Mapping[str, int]
    included_counts_by_source: Mapping[SourceKind, int]
    asat_materialised_present: bool


@dataclass(frozen=True)
class EvidenceSet:
    scope: EvidenceScope
    points: tuple[EvidencePoint, ...]
    skipped: tuple[SkippedCandidate, ...]
    totals: EvidenceTotals
    totals_by_source: Mapping[SourceKind, EvidenceTotals]
    provenance: EvidenceProvenance


def evidence_set_to_response_provenance(
    evidence_set: "EvidenceSet",
) -> dict[str, Any]:
    """Serialise an `EvidenceSet` to the CF response `evidence_provenance` block.

    Per 73h §CF Response Provenance Contract: dedicated block name, stable
    schema version, scope key, role, raw E totals, totals by source kind,
    included counts by source, selected families, skipped counts, as-at
    boundary, and as-at-materialised marker.

    Returns a JSON-friendly dict suitable for inclusion in HTTP responses.
    """
    prov = evidence_set.provenance
    totals = evidence_set.totals
    totals_by_source = {
        src.value: {"n": t.n, "k": t.k}
        for src, t in evidence_set.totals_by_source.items()
        if t.n > 0 or t.k > 0
    }
    included_counts = {
        src.value: count
        for src, count in prov.included_counts_by_source.items()
        if count > 0
    }
    return {
        "schema_version": prov.schema_version,
        "role": prov.role.value,
        "scope_key": prov.scope_key,
        "scenario_id": prov.scenario_id,
        "as_at": prov.as_at,
        "totals": {"n": totals.n, "k": totals.k, "mean": totals.mean},
        "totals_by_source": totals_by_source,
        "included_counts_by_source": included_counts,
        "selected_slice_families": [f.value for f in prov.selected_slice_families],
        "selected_snapshot_families": [
            f.value for f in prov.selected_snapshot_families
        ],
        "skipped_counts_by_reason": dict(prov.skipped_counts_by_reason),
        "asat_materialised_present": prov.asat_materialised_present,
    }


# ─── Population identity helper ────────────────────────────────────────


_DDMMMYY_RE = re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{2,4}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalise_iso_date(raw: Any) -> Optional[str]:
    """Normalise common date forms to ISO yyyy-mm-dd, or return None.

    Public utility for adapters. Accepts ISO strings (with optional time
    suffix), `d-MMM-yy`, and `d-MMM-yyyy`. Returns None for empty/invalid.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    head = text[:10]
    try:
        return _date.fromisoformat(head).isoformat()
    except ValueError:
        pass
    for fmt in ("%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_cohort_anchor_from_slice(slice_dsl: str) -> Optional[str]:
    """Parse the anchor argument from a `cohort(<anchor>, ...)` slice DSL.

    Returns None when the cohort() form has no explicit anchor (e.g.
    `cohort(1-Apr-26:4-Apr-26)`), or when the slice is not a cohort form.
    """
    if not isinstance(slice_dsl, str):
        return None
    match = re.match(r"^\s*cohort\(\s*([^,)]+)\s*[,)]", slice_dsl)
    if not match:
        return None
    candidate = match.group(1).strip()
    # If the captured token looks like a date (no anchor, just a date range
    # like "1-Apr-26:4-Apr-26"), there is no anchor.
    head = candidate.split(":", 1)[0]
    if _DDMMMYY_RE.match(head) or _ISO_DATE_RE.match(head):
        return None
    return candidate


def derive_population_identity(
    *,
    role: EvidenceRole,
    anchor: Optional[str],
    subject_from: str,
    subject_to: str,
    date_from: str,
    date_to: str,
    selected_anchor_days: Optional[Sequence[str]] = None,
    context_key: Optional[str] = None,
    regime_key: Optional[str] = None,
    as_at: Optional[str] = None,
    population_universe_key: Optional[str] = None,
) -> str:
    """Derive a deterministic population identity for a direct-cohort scope.

    For window-family roles the population is not load-bearing for
    admission; this helper still returns a stable marker so adapters can
    set it uniformly without branching on role.

    For cohort-family roles the key is derived from the canonical
    selector (anchor + subject + date bounds + sorted selected anchor
    days + context/regime + as-at + universe). It proves only that the
    same selector was used; matching member-level populations remains a
    separate concern.
    """
    if role in _WINDOW_ROLES:
        return "window_subject:not_population_scoped"
    parts = [
        ("role", role.value),
        ("anchor", anchor or ""),
        ("subject_from", subject_from),
        ("subject_to", subject_to),
        ("date_from", date_from),
        ("date_to", date_to),
        ("anchor_days", "|".join(sorted(selected_anchor_days or ()))),
        ("context_key", context_key or ""),
        ("regime_key", regime_key or ""),
        ("as_at", as_at or ""),
        ("universe", population_universe_key or ""),
    ]
    digest = hashlib.sha256(
        "\x1f".join(f"{k}={v}" for k, v in parts).encode("utf-8")
    ).hexdigest()[:16]
    return f"cohort:{role.value}:{anchor or '-'}:{digest}"


# ─── Internal helpers ──────────────────────────────────────────────────


def _scope_key(scope: EvidenceScope) -> str:
    parts = [
        ("role", scope.role.value),
        ("subject", f"{scope.subject_from}->{scope.subject_to}"),
        ("anchor", scope.anchor or ""),
        ("date_from", scope.date_from),
        ("date_to", scope.date_to),
        ("as_at", scope.as_at or ""),
        ("scenario_id", scope.scenario_id or ""),
        ("context_key", scope.context_key or ""),
        ("regime_key", scope.regime_key or ""),
        ("pop_universe", scope.population_universe_key or ""),
        ("anchor_days", "|".join(sorted(scope.selected_anchor_days or ()))),
        ("scope_pop", scope.scope_population_identity or ""),
    ]
    digest = hashlib.sha256(
        "\x1f".join(f"{k}={v}" for k, v in parts).encode("utf-8")
    ).hexdigest()[:16]
    return f"scope:{digest}"


def evidence_dedupe_key(identity: EvidenceIdentity) -> tuple:
    """Public dedupe key for an `EvidenceIdentity`.

    Callers using `snapshot_covered_observations` must compute keys with
    this helper so they match the merge library's internal grouping.

    Per 73h §"Identity And Observation Coordinates Before Counts", role
    is part of the summability identity. Two candidates with the same
    family but different roles (e.g. `WINDOW_SUBJECT_HELPER` and
    `BAYES_PHASE1_WINDOW`) are NOT summable — they belong to different
    consumers' E. Including role here prevents cross-role dedupe
    collisions even when family/subject/anchor/context/regime/population
    coincide.
    """
    return (
        identity.role,
        identity.subject_from,
        identity.subject_to,
        identity.anchor,
        identity.slice_family,
        identity.context_key,
        identity.regime_key,
        identity.population_identity,
    )


# Internal alias retained for readability inside the module.
_dedupe_key = evidence_dedupe_key


def _retrieval_sort_key(c: EvidenceCandidate) -> tuple:
    """Higher tuple = more recent. asat_materialised acts as the upper bound."""
    if c.coordinate.asat_materialised:
        return (1, "")
    return (0, c.coordinate.retrieved_at or "")


def _validate_candidate(
    c: EvidenceCandidate, scope: EvidenceScope
) -> Optional[str]:
    """Return a skip reason if the candidate is inadmissible, else None.

    Order of checks is significant: reasons are mutually exclusive and
    earlier checks shadow later ones. The order below matches the
    skip-reason taxonomy in 73h §Step 5.
    """
    # Subject identity
    if (
        c.identity.subject_from != scope.subject_from
        or c.identity.subject_to != scope.subject_to
    ):
        return "subject_mismatch"

    # Date bounds
    if (
        c.coordinate.observed_date < scope.date_from
        or c.coordinate.observed_date > scope.date_to
    ):
        return "out_of_date_bounds"

    # Counts validity
    if not isinstance(c.n, int) or not isinstance(c.k, int):
        return "invalid_counts"
    if c.n <= 0:
        return "non_positive_n"

    # Context: a context() slice family is unsupported under any Stage 1
    # role; otherwise context_key on candidate must equal scope context_key.
    if c.identity.slice_family == SliceFamily.CONTEXT:
        return "unsupported_context"
    if c.identity.context_key != scope.context_key:
        return "context_mismatch"

    # Regime
    if c.identity.regime_key != scope.regime_key:
        return "regime_mismatch"

    # Role/family compatibility — exact role match is required.
    # 73h §"Identity And Observation Coordinates Before Counts" + #7
    # established that role is part of the summability identity:
    # `WINDOW_SUBJECT_HELPER` and `BAYES_PHASE1_WINDOW` share a family
    # but belong to different consumers' E and are not summable.
    # Family-only admission (the pre-fix behaviour) admits cross-role
    # candidates that the dedupe key now (correctly) rejects, so they
    # commingle in scope but don't merge — wrong shape. Tighten to
    # exact role.
    expected_family = _role_family(scope.role)
    if c.identity.slice_family != expected_family:
        return "wrong_role"
    if c.identity.role != scope.role:
        return "wrong_role"

    # Direct cohort: anchor + population identity
    if scope.role == EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT:
        if c.identity.anchor != scope.anchor:
            return "wrong_cohort_anchor"
        if (
            scope.scope_population_identity is not None
            and c.identity.population_identity != scope.scope_population_identity
        ):
            return "wrong_population_identity"

    # As-at admission
    if scope.as_at is not None:
        if not c.coordinate.asat_materialised:
            if c.coordinate.retrieved_at is None:
                return "missing_retrieved_at"
            if c.coordinate.retrieved_at > scope.as_at:
                return "after_as_at"

    # Observation cannot post-date its own retrieval
    if not c.coordinate.asat_materialised and c.coordinate.retrieved_at is not None:
        if c.coordinate.observed_date > c.coordinate.retrieved_at:
            return "after_retrieved_at"

    return None


# ─── Public entry point ────────────────────────────────────────────────


def merge_evidence_candidates(
    scope: EvidenceScope,
    candidates: Sequence[EvidenceCandidate],
    *,
    snapshot_covered_observations: Optional[set] = None,
) -> EvidenceSet:
    """Merge typed candidates into a single canonical EvidenceSet for the scope.

    The merge is pure. It performs no I/O. Implements 73h §Merge Algorithm
    Steps 1-6.

    `snapshot_covered_observations` is an optional supplement-mode shortcut
    used by Stages 2-3 callers that have not yet adapted their snapshot
    rows into typed `EvidenceCandidate`s. When provided, any non-snapshot
    candidate whose (dedupe_key, observed_date) pair is in the set is
    skipped as `covered_by_snapshot` before the dedupe step. The set's
    elements must be `(dedupe_key, observed_date)` tuples where
    `dedupe_key` is computed by `evidence_dedupe_key(identity)`.

    Stage 4+ callers that pass real snapshot candidates do not need this
    parameter; the natural snapshot-beats-file dedupe in Step 5 handles it.
    """

    skipped: list[SkippedCandidate] = []
    eligible: list[EvidenceCandidate] = []

    covered = snapshot_covered_observations or set()

    # Step 1: scope-level admission
    for c in candidates:
        reason = _validate_candidate(c, scope)
        if reason is not None:
            skipped.append(SkippedCandidate(c, reason))
            continue
        if c.source != SourceKind.SNAPSHOT and (
            (_dedupe_key(c.identity), c.coordinate.observed_date) in covered
        ):
            skipped.append(SkippedCandidate(c, "covered_by_snapshot"))
            continue
        eligible.append(c)

    # Steps 2-5: dedupe by (identity, observed_date); snapshot beats
    # non-snapshot; within same source kind, latest retrieval wins.
    grouped: dict[tuple, list[EvidenceCandidate]] = defaultdict(list)
    for c in eligible:
        grouped[(_dedupe_key(c.identity), c.coordinate.observed_date)].append(c)

    points: list[EvidencePoint] = []
    for _key, group in grouped.items():
        snapshots = [c for c in group if c.source == SourceKind.SNAPSHOT]
        non_snapshots = [c for c in group if c.source != SourceKind.SNAPSHOT]

        if snapshots:
            snapshots.sort(key=_retrieval_sort_key, reverse=True)
            winner = snapshots[0]
            for loser in snapshots[1:]:
                skipped.append(SkippedCandidate(loser, "superseded_by_later_retrieval"))
            for ns in non_snapshots:
                skipped.append(SkippedCandidate(ns, "covered_by_snapshot"))
            points.append(EvidencePoint(winner))
        else:
            non_snapshots.sort(key=_retrieval_sort_key, reverse=True)
            winner = non_snapshots[0]
            for loser in non_snapshots[1:]:
                skipped.append(SkippedCandidate(loser, "superseded_by_later_retrieval"))
            points.append(EvidencePoint(winner))

    # Step 6: totals + provenance
    totals = EvidenceTotals(
        n=sum(p.n for p in points),
        k=sum(p.k for p in points),
    )

    by_source_n: dict[SourceKind, int] = defaultdict(int)
    by_source_k: dict[SourceKind, int] = defaultdict(int)
    by_source_count: dict[SourceKind, int] = defaultdict(int)
    for p in points:
        by_source_n[p.source] += p.n
        by_source_k[p.source] += p.k
        by_source_count[p.source] += 1
    totals_by_source = {
        src: EvidenceTotals(n=by_source_n[src], k=by_source_k[src])
        for src in SourceKind
    }

    skipped_counts: dict[str, int] = defaultdict(int)
    for s in skipped:
        skipped_counts[s.reason] += 1

    selected_families = tuple(
        sorted({p.candidate.identity.slice_family for p in points}, key=lambda f: f.value)
    )
    selected_snapshot_families = tuple(
        sorted(
            {p.candidate.identity.slice_family for p in points if p.source == SourceKind.SNAPSHOT},
            key=lambda f: f.value,
        )
    )
    asat_materialised_present = any(
        p.candidate.coordinate.asat_materialised for p in points
    )

    provenance = EvidenceProvenance(
        schema_version=PROVENANCE_SCHEMA_VERSION,
        role=scope.role,
        scope_key=_scope_key(scope),
        scenario_id=scope.scenario_id,
        as_at=scope.as_at,
        selected_slice_families=selected_families,
        selected_snapshot_families=selected_snapshot_families,
        skipped_counts_by_reason=dict(skipped_counts),
        included_counts_by_source={src: by_source_count[src] for src in SourceKind},
        asat_materialised_present=asat_materialised_present,
    )

    return EvidenceSet(
        scope=scope,
        points=tuple(points),
        skipped=tuple(skipped),
        totals=totals,
        totals_by_source=totals_by_source,
        provenance=provenance,
    )
