"""
Candidate adapters for the typed shared evidence merge library.

Adapters convert existing project-specific row shapes into typed
`EvidenceCandidate`s consumable by `evidence_merge.merge_evidence_candidates`.

Currently provided:

- `bayes_file_evidence_to_candidates` (Stage 2): converts the engorged
  `_bayes_evidence` dict on an edge (shape `{"window": [...], "cohort": [...]}`)
  into FILE candidates. Used by BE CF runtime preparation and by
  cohort_maturity_v3 when both consume one shared E.
- `bayes_parameter_file_evidence_to_candidates` (Stage 5): converts the flat
  `values[]` list from a Bayes parameter file into FILE candidates with
  Phase-2 provenance. Used by `bayes/compiler/evidence.py` to replace the
  legacy `merge_file_evidence_for_role` supplement.
- `reconstructed_asat_to_candidates` (Stage 6): converts virtual-snapshot
  rows from `snapshot_service.query_virtual_snapshot` into RECONSTRUCTED
  candidates with `asat_materialised=True`. Forward-looking integration
  surface for future as-at evidence routing through one shared E.

All adapters are pure: no I/O, no DB, no file reads. They consume already-
materialised dict/row shapes that callers obtain via their own paths.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
    normalise_iso_date,
    parse_cohort_anchor_from_slice,
)


def _entry_retrieved_at(entry: Mapping[str, Any]) -> Optional[str]:
    """Extract `retrieved_at` from an evidence entry.

    Mirrors the legacy `file_evidence_supplement._entry_retrieved_at` so
    Stage 7 can retire that helper without losing the convention.
    """
    direct = normalise_iso_date(entry.get("retrieved_at"))
    if direct:
        return direct
    ds = entry.get("data_source")
    if isinstance(ds, Mapping):
        return normalise_iso_date(ds.get("retrieved_at"))
    return None


def _classify_slice(
    section: str, slice_dsl: str
) -> tuple[SliceFamily, Optional[str]]:
    """Determine slice family and (cohort) anchor from section + DSL.

    Returns `(slice_family, cohort_anchor_or_None)`.

    A `.context(...)` qualifier on the DSL forces `SliceFamily.CONTEXT`
    so the merge skips it as `unsupported_context` for Stage 1 roles.
    The legacy helper used `"context(" in slice_dsl` for the same intent.
    """
    if isinstance(slice_dsl, str) and "context(" in slice_dsl:
        return SliceFamily.CONTEXT, None
    if section == "window":
        return SliceFamily.WINDOW, None
    if section == "cohort":
        return SliceFamily.COHORT, parse_cohort_anchor_from_slice(slice_dsl)
    return SliceFamily.UNKNOWN, None


def _classify_slice_from_dsl(
    slice_dsl: str,
) -> tuple[SliceFamily, Optional[str]]:
    """Classify a parameter-file `values[]` entry purely from its sliceDSL.

    Mirrors the legacy `_slice_matches_role` precedence in
    `file_evidence_supplement.py`: context() qualification dominates,
    then window(), then cohort().
    """
    if not isinstance(slice_dsl, str):
        return SliceFamily.UNKNOWN, None
    if "context(" in slice_dsl:
        return SliceFamily.CONTEXT, None
    if "window(" in slice_dsl:
        return SliceFamily.WINDOW, None
    if "cohort(" in slice_dsl:
        return SliceFamily.COHORT, parse_cohort_anchor_from_slice(slice_dsl)
    return SliceFamily.UNKNOWN, None


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return None


def _entry_is_asat_reconstructed(entry: Mapping[str, Any]) -> bool:
    """Detect tier-1 FE asat-reconstruction markers on an engorged values[] entry.

    `fileToGraphSync.ts` writes asat markers in two tiers:

    - Tier 1 (DB-reconstructed): `_asat` + `_asat_retrieved_at` set, no
      `_asat_truncated`. Daily arrays come from the snapshot DB and are
      a true as-at materialisation. These bypass `retrieved_at`
      admission in the merge because the reconstruction IS the as-at
      point.
    - Tier 2 (approximation): `_asat` + `_asat_truncated=true`, no
      `_asat_retrieved_at`. Daily arrays are raw file rows date-truncated
      to <= as-at; cohorts appear too mature because Y values are the
      latest observation. These must NOT bypass admission — they are
      raw file evidence and should be subject to the merge's standard
      `retrieved_at`/`as_at` gates.

    Returns True only for the tier-1 case. Tier-2 entries fall through
    to the `SourceKind.FILE` path; if the scope has an `as_at` and the
    tier-2 entry lacks `retrieved_at`, the merge will skip it as
    `missing_retrieved_at` — the correct fail-closed behaviour for an
    approximation that cannot be admitted historically.
    """
    if entry.get("_asat_truncated"):
        return False
    return bool(entry.get("_asat_retrieved_at"))


def _entry_asat_retrieved_at(entry: Mapping[str, Any]) -> Optional[str]:
    """ISO-normalise the FE-provided `_asat_retrieved_at` marker if present."""
    return normalise_iso_date(entry.get("_asat_retrieved_at"))


def bayes_file_evidence_to_candidates(
    bayes_evidence: Optional[Mapping[str, Any]],
    *,
    scope: EvidenceScope,
    temporal_basis_window: TemporalBasis = TemporalBasis.WINDOW_DAY,
    temporal_basis_cohort: TemporalBasis = TemporalBasis.ANCHOR_DAY,
) -> list[EvidenceCandidate]:
    """Convert engorged bayes_evidence dict into typed FILE candidates.

    Input shape (matches `_bayes_evidence` on graph edges):
        {
            "window": [
                {
                    "sliceDSL": "window(...)",
                    "dates": ["yyyy-mm-dd", ...],
                    "n_daily": [int, ...],
                    "k_daily": [int, ...],
                    "retrieved_at": "...",                      # optional
                    "data_source": {"retrieved_at": "..."},     # alt location
                },
                ...
            ],
            "cohort": [...],
        }

    Output: a flat list of `EvidenceCandidate(source=FILE, ...)`.

    The adapter does NOT pre-filter by date bounds, role, or coverage —
    that is the merge library's job. Malformed entries (mismatched array
    lengths, missing dates, non-numeric counts) are silently dropped at
    the per-row level; the merge library reports its own skip reasons
    for everything else.
    """
    candidates: list[EvidenceCandidate] = []
    if not isinstance(bayes_evidence, Mapping):
        return candidates

    for section in ("window", "cohort"):
        entries = bayes_evidence.get(section)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            slice_dsl = str(entry.get("sliceDSL") or "")
            slice_family, cohort_anchor = _classify_slice(section, slice_dsl)
            n_daily = entry.get("n_daily") or []
            k_daily = entry.get("k_daily") or []
            dates = entry.get("dates") or []
            if not (
                isinstance(n_daily, list)
                and isinstance(k_daily, list)
                and isinstance(dates, list)
                and len(n_daily) == len(k_daily) == len(dates)
            ):
                continue
            asat_reconstructed = _entry_is_asat_reconstructed(entry)
            retrieved_iso = (
                _entry_asat_retrieved_at(entry)
                if asat_reconstructed
                else _entry_retrieved_at(entry)
            )
            temporal_basis = (
                temporal_basis_cohort
                if slice_family == SliceFamily.COHORT
                else temporal_basis_window
            )
            entry_provenance = {
                "section": section,
                "sliceDSL": slice_dsl,
                "asat_reconstructed": asat_reconstructed,
            }
            if asat_reconstructed:
                entry_provenance["asat"] = entry.get("_asat")
                entry_provenance["asat_retrieved_at"] = retrieved_iso
            source_kind = (
                SourceKind.RECONSTRUCTED if asat_reconstructed else SourceKind.FILE
            )
            for idx, raw_date in enumerate(dates):
                date_iso = normalise_iso_date(raw_date)
                if not date_iso:
                    continue
                n_val = _coerce_int(n_daily[idx])
                k_val = _coerce_int(k_daily[idx])
                if n_val is None or k_val is None:
                    continue
                identity = EvidenceIdentity(
                    role=scope.role,
                    subject_from=scope.subject_from,
                    subject_to=scope.subject_to,
                    anchor=cohort_anchor if slice_family == SliceFamily.COHORT else None,
                    slice_family=slice_family,
                    context_key=scope.context_key,
                    regime_key=scope.regime_key,
                    population_identity=scope.scope_population_identity,
                )
                coordinate = ObservationCoordinate(
                    observed_date=date_iso,
                    retrieved_at=retrieved_iso,
                    temporal_basis=temporal_basis,
                    asat_materialised=asat_reconstructed,
                )
                candidates.append(
                    EvidenceCandidate(
                        source=source_kind,
                        identity=identity,
                        coordinate=coordinate,
                        n=max(n_val, 0),
                        k=max(k_val, 0),
                        provenance=entry_provenance,
                    )
                )
    return candidates


def bayes_parameter_file_evidence_to_candidates(
    values: Optional[Sequence[Mapping[str, Any]]],
    *,
    scope: EvidenceScope,
    edge_topology: Optional[Any] = None,
    anchor_node: Optional[str] = None,
    temporal_basis_window: TemporalBasis = TemporalBasis.WINDOW_DAY,
    temporal_basis_cohort: TemporalBasis = TemporalBasis.ANCHOR_DAY,
) -> list[EvidenceCandidate]:
    """Convert a Bayes parameter file's `values[]` list into typed FILE candidates.

    Input shape (matches a `.yaml` parameter file's `values[]` list):
        [
            {
                "sliceDSL": "window(...)" | "cohort(<anchor>, ...)" | "...context(...)",
                "dates": ["yyyy-mm-dd" | "d-MMM-yy", ...],
                "n_daily": [int, ...],
                "k_daily": [int, ...],
                "retrieved_at": "...",                      # optional
                "data_source": {"retrieved_at": "..."},     # alt location
                # aggregate (n, k) keys also possible — ignored here; the
                # daily-arrays path is the only one that produces dated
                # candidates. Aggregate-only entries are bound elsewhere.
            },
            ...
        ]

    Output: a flat list of `EvidenceCandidate(source=FILE, ...)`.

    Phase-2 provenance attached on each candidate's `provenance` field
    per 73h §`bayes_phase2_cohort`: cohort anchor, cohort selector
    (sliceDSL), subject edge id and span, edge depth from anchor with the
    first-edge case unambiguously marked, path prefix from anchor to the
    subject edge, observation temporal basis, and population identity
    (carried via `EvidenceIdentity`). `model.py` already routes Phase-2
    observations using `len(et.path_edge_ids) <= 1` and the literal
    "window"/"cohort" tokens in `slice_dsl`; the provenance here mirrors
    those signals into typed form for future routing refactors.

    The adapter does NOT pre-filter by date bounds, role, or coverage —
    that is the merge library's job. Malformed entries (mismatched array
    lengths, missing dates, non-numeric counts) are silently dropped at
    the per-row level.
    """
    candidates: list[EvidenceCandidate] = []
    if not isinstance(values, (list, tuple)):
        return candidates

    edge_id = getattr(edge_topology, "edge_id", "") if edge_topology else ""
    path_edge_ids = list(getattr(edge_topology, "path_edge_ids", ()) or ())
    edge_depth = len(path_edge_ids)
    is_first_edge = edge_depth <= 1
    et_from = getattr(edge_topology, "from_node", "") if edge_topology else ""
    et_to = getattr(edge_topology, "to_node", "") if edge_topology else ""

    for entry in values:
        if not isinstance(entry, Mapping):
            continue
        slice_dsl = str(entry.get("sliceDSL") or "")
        slice_family, cohort_anchor = _classify_slice_from_dsl(slice_dsl)
        if slice_family == SliceFamily.UNKNOWN:
            continue
        n_daily = entry.get("n_daily") or []
        k_daily = entry.get("k_daily") or []
        dates = entry.get("dates") or []
        if not (
            isinstance(n_daily, list)
            and isinstance(k_daily, list)
            and isinstance(dates, list)
            and len(n_daily) == len(k_daily) == len(dates)
        ):
            continue
        asat_reconstructed = _entry_is_asat_reconstructed(entry)
        retrieved_iso = (
            _entry_asat_retrieved_at(entry)
            if asat_reconstructed
            else _entry_retrieved_at(entry)
        )
        temporal_basis = (
            temporal_basis_cohort
            if slice_family == SliceFamily.COHORT
            else temporal_basis_window
        )
        entry_provenance: dict[str, Any] = {
            "sliceDSL": slice_dsl,
            "subject_edge_id": edge_id,
            "subject_edge_from": et_from,
            "subject_edge_to": et_to,
            "anchor_node": anchor_node or "",
            "edge_depth_from_anchor": edge_depth,
            "is_first_edge": is_first_edge,
            "path_edge_ids": tuple(path_edge_ids),
            "temporal_basis": temporal_basis.value,
            "cohort_selector": (
                slice_dsl if slice_family == SliceFamily.COHORT else None
            ),
            "cohort_anchor": cohort_anchor,
            "asat_reconstructed": asat_reconstructed,
        }
        if asat_reconstructed:
            entry_provenance["asat"] = entry.get("_asat")
            entry_provenance["asat_retrieved_at"] = retrieved_iso
        source_kind = (
            SourceKind.RECONSTRUCTED if asat_reconstructed else SourceKind.FILE
        )
        for idx, raw_date in enumerate(dates):
            date_iso = normalise_iso_date(raw_date)
            if not date_iso:
                continue
            n_val = _coerce_int(n_daily[idx])
            k_val = _coerce_int(k_daily[idx])
            if n_val is None or k_val is None:
                continue
            identity = EvidenceIdentity(
                role=scope.role,
                subject_from=scope.subject_from,
                subject_to=scope.subject_to,
                anchor=cohort_anchor if slice_family == SliceFamily.COHORT else None,
                slice_family=slice_family,
                context_key=scope.context_key,
                regime_key=scope.regime_key,
                population_identity=scope.scope_population_identity,
            )
            coordinate = ObservationCoordinate(
                observed_date=date_iso,
                retrieved_at=retrieved_iso,
                temporal_basis=temporal_basis,
                asat_materialised=asat_reconstructed,
            )
            candidates.append(
                EvidenceCandidate(
                    source=source_kind,
                    identity=identity,
                    coordinate=coordinate,
                    n=max(n_val, 0),
                    k=max(k_val, 0),
                    provenance=entry_provenance,
                )
            )
    return candidates


def _classify_slice_key(slice_key: str) -> tuple[SliceFamily, Optional[str]]:
    """Classify a snapshot row's `slice_key` string.

    `slice_key` is the snapshot DB's normalised slice carrier — e.g.
    `"window(-90d:)"` or `"cohort(simple-a, 1-Apr-26:5-Apr-26)"`, with
    optional `.context(...)` qualification for context-tagged rows.
    """
    if not isinstance(slice_key, str):
        return SliceFamily.UNKNOWN, None
    if "context(" in slice_key:
        return SliceFamily.CONTEXT, None
    if "window(" in slice_key:
        return SliceFamily.WINDOW, None
    if "cohort(" in slice_key:
        return SliceFamily.COHORT, parse_cohort_anchor_from_slice(slice_key)
    return SliceFamily.UNKNOWN, None


def _row_retrieved_at(row: Mapping[str, Any]) -> Optional[str]:
    """Extract retrieved_at from a virtual-snapshot row, ISO-normalised."""
    raw = row.get("retrieved_at")
    if raw is None:
        return None
    # query_virtual_snapshot returns datetime in JSON form; accept str|datetime.
    if hasattr(raw, "isoformat"):
        try:
            return raw.date().isoformat() if hasattr(raw, "date") else raw.isoformat()
        except (AttributeError, ValueError):
            return None
    return normalise_iso_date(raw)


def reconstructed_asat_to_candidates(
    rows: Optional[Sequence[Mapping[str, Any]]],
    *,
    scope: EvidenceScope,
    is_window: Optional[bool] = None,
    asat_materialised: bool = True,
    temporal_basis_window: TemporalBasis = TemporalBasis.WINDOW_DAY,
    temporal_basis_cohort: TemporalBasis = TemporalBasis.ANCHOR_DAY,
) -> list[EvidenceCandidate]:
    """Convert virtual-snapshot rows into typed RECONSTRUCTED candidates.

    Input shape (matches `snapshot_service.query_virtual_snapshot` output rows):
        [
            {
                "anchor_day": "yyyy-mm-dd" | date,
                "slice_key": "window(...)" | "cohort(<anchor>, ...)",
                "core_hash": str,
                "retrieved_at": datetime | str,
                "a": int,   # anchor entrants
                "x": int,   # from-node arrivals
                "y": int,   # to-node conversions
                # latency / lag fields ignored by the merge
            },
            ...
        ]

    Output: typed `EvidenceCandidate(source=RECONSTRUCTED)`s.

    The denominator-numerator mapping defaults to **edge-local rate
    evidence**: `n=x, k=y` for both window and cohort slices. For
    `cohort(A, X→Y)` the displayed and conditioned edge rate is Y/X,
    not Y/A — Y/A is a path-product, not an edge rate. The anchor
    entrants count `a` is preserved separately on the candidate's
    provenance under `anchor_entrants` for callers that need carrier-side
    counts (e.g. WP8 direct-cohort rate evidence in the first-edge
    identity case where A==X, so a==x).

    `is_window` is an explicit override:
      - `is_window=True` → force n=x regardless of slice family
      - `is_window=False` → force n=a (anchor-as-denominator); only
        appropriate in the WP8 first-edge identity case where the rate
        is genuinely Y/A
      - `None` (default) → n=x always (edge rate)

    `asat_materialised` (default True) controls whether the merge bypasses
    `retrieved_at` / `as_at` admission for these rows:
      - `True`: rows are FE-asat-reconstructed materialisations — the
        retrieval-vs-as-at gate is by definition met because the
        reconstruction IS the as-at point.
      - `False`: rows are plain BE-direct snapshot reads. They are still
        observations subject to normal `retrieved_at` / `as_at`
        admission. Callers who pass `query_virtual_snapshot` rows into
        the typed merge for the live CF path (#1 wiring) MUST pass
        `False` — otherwise plain snapshots silently bypass the as-at
        gate and the response provenance lies about
        `asat_materialised_present`.

    Adapter purity: no DB calls, no SQL. Callers obtain rows via
    `query_virtual_snapshot` and pass them in directly.
    """
    candidates: list[EvidenceCandidate] = []
    if not isinstance(rows, (list, tuple)):
        return candidates

    for row in rows:
        if not isinstance(row, Mapping):
            continue
        slice_key = str(row.get("slice_key") or "")
        slice_family, cohort_anchor = _classify_slice_key(slice_key)
        if slice_family == SliceFamily.UNKNOWN:
            continue
        observed = normalise_iso_date(row.get("anchor_day"))
        if not observed:
            continue
        retrieved_iso = _row_retrieved_at(row)

        # Default to edge rate evidence (n=x, k=y) for both families.
        # `a` is preserved as separate provenance for carrier-side use.
        # `is_window=False` is the explicit WP8 first-edge identity case
        # where the rate is genuinely Y/A.
        if is_window is False:
            n_val = _coerce_int(row.get("a"))
        else:
            n_val = _coerce_int(row.get("x"))
        k_val = _coerce_int(row.get("y"))
        if n_val is None or k_val is None:
            continue
        anchor_entrants = _coerce_int(row.get("a"))

        temporal_basis = (
            temporal_basis_cohort
            if slice_family == SliceFamily.COHORT
            else temporal_basis_window
        )
        identity = EvidenceIdentity(
            role=scope.role,
            subject_from=scope.subject_from,
            subject_to=scope.subject_to,
            anchor=cohort_anchor if slice_family == SliceFamily.COHORT else None,
            slice_family=slice_family,
            context_key=scope.context_key,
            regime_key=scope.regime_key,
            population_identity=scope.scope_population_identity,
        )
        coordinate = ObservationCoordinate(
            observed_date=observed,
            retrieved_at=retrieved_iso,
            temporal_basis=temporal_basis,
            asat_materialised=asat_materialised,
        )
        provenance = {
            "slice_key": slice_key,
            "core_hash": row.get("core_hash") or "",
            "anchor_day": observed,
            "as_at": scope.as_at,
            "anchor_entrants": anchor_entrants,
        }
        candidates.append(
            EvidenceCandidate(
                source=SourceKind.RECONSTRUCTED,
                identity=identity,
                coordinate=coordinate,
                n=max(n_val, 0),
                k=max(k_val, 0),
                provenance=provenance,
            )
        )
    return candidates
