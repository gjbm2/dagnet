"""Per-primitive-edge binding descriptors and superset-row candidate builder.

Plan: docs/current/project-bayes/73r-generalised-primitive-evidence-acquisition-plan.md

A `PrimitiveEdgeBindingDescriptor` names one parameterised graph edge in a
CF request along with the metadata needed to translate already-fetched
evidence-superset rows into typed candidates. The descriptor does not fetch,
dedupe, or read graph-side evidence fields. Source-family complexity stays
behind the evidence-superset interface; this layer only supplies primitive
identity and role metadata for downstream binding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Sequence

from evidence_merge import (
    EvidenceCandidate,
    EvidenceRole,
    EvidenceScope,
)


@dataclass(frozen=True)
class PrimitiveEdgeBindingDescriptor:
    """One parameterised edge plus the metadata needed to build its
    candidate feed.

    `is_target` marks the request's target subject edge (single-hop
    target, or the terminal edge of a multi-hop subject). `is_carrier`
    marks edges in the active-Cohort `A -> X` carrier topology. A subject
    primitive edge in a multi-hop request is `is_target=False,
    is_carrier=False`.

    `date_from` / `date_to` are the EvidenceScope date bounds used by
    primitive binding. Superset fetching owns the actual evidence envelope.

    `edge_dict` is retained for topology metadata only; candidate construction
    must not read evidence from it.
    """

    edge_id: str
    edge_uuid: str
    source_node: str
    target_node: str
    role: EvidenceRole
    is_target: bool
    is_carrier: bool
    date_from: str
    date_to: str
    as_at: Optional[str]
    scenario_id: Optional[str]
    anchor_node_id: Optional[str]
    edge_dict: Mapping[str, Any]
    context_key: Optional[str] = None
    context_selector: Optional[str] = None
    mece_dimensions: Sequence[str] = ()


def _evidence_scope_for(d: PrimitiveEdgeBindingDescriptor) -> EvidenceScope:
    return EvidenceScope(
        role=d.role,
        subject_from=d.source_node,
        subject_to=d.target_node,
        date_from=d.date_from,
        date_to=d.date_to,
        as_at=d.as_at,
        scenario_id=d.scenario_id,
        anchor=d.anchor_node_id,
        context_key=d.context_key,
        context_selector=d.context_selector,
        mece_dimensions=tuple(d.mece_dimensions or ()),
    )


def build_candidates_for_descriptor(
    descriptor: PrimitiveEdgeBindingDescriptor,
    *,
    superset_rows: Optional[Sequence[Mapping[str, Any]]] = None,
) -> List[EvidenceCandidate]:
    """Translate superset rows into typed candidates for one primitive edge.

    The rows must already have been fetched and deduped by the evidence
    superset/envelope interface. This function performs no I/O and no
    graph-side evidence reads.

    Returns an empty list if no superset row is supplied; the caller is
    responsible for the prior-only degeneracy.
    """
    from runner.evidence_adapters import (
        reconstructed_asat_to_candidates,
    )

    candidates: List[EvidenceCandidate] = []
    scope = _evidence_scope_for(descriptor)

    if superset_rows:
        candidates.extend(reconstructed_asat_to_candidates(
            list(superset_rows),
            scope=scope,
            asat_materialised=False,
        ))

    return candidates


def enumerate_per_edge_descriptors(
    *,
    graph: Mapping[str, Any],
    from_node: str,
    to_node: str,
    is_carrier: bool,
    target_edge_uuid: Optional[str],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: Optional[str],
    anchor_node_id: Optional[str],
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
    role: EvidenceRole = EvidenceRole.WINDOW_SUBJECT_HELPER,
) -> List[PrimitiveEdgeBindingDescriptor]:
    """Walk a single span topology (subject `X -> end` or carrier
    `A -> X`) and emit one descriptor per parameterised edge.

    Edges absent from the topology are skipped. Edges whose path role
    cannot be classified (no path from from_node to to_node) yield an
    empty list.

    Per-edge descriptors use `(anchor_from, sweep_to)` as the scope
    date bounds, matching the existing per-edge fetch envelope.
    """
    from runner.span_kernel import _build_span_topology

    if not from_node or not to_node or from_node == to_node:
        return []

    topo = _build_span_topology(
        dict(graph),
        x_node_id=str(from_node),
        y_node_id=str(to_node),
    )
    if topo is None or not topo.edge_list:
        return []

    descriptors: List[PrimitiveEdgeBindingDescriptor] = []
    for from_id, to_id, edge_dict in topo.edge_list:
        edge_id = (
            edge_dict.get('edge_id')
            or edge_dict.get('id')
            or f"{from_id}->{to_id}"
        )
        edge_uuid = str(edge_dict.get('uuid') or edge_id)
        is_target = bool(target_edge_uuid) and edge_uuid == str(target_edge_uuid)
        descriptors.append(
            PrimitiveEdgeBindingDescriptor(
                edge_id=str(edge_id),
                edge_uuid=edge_uuid,
                source_node=str(from_id),
                target_node=str(to_id),
                role=role,
                is_target=is_target,
                is_carrier=is_carrier,
                date_from=anchor_from,
                date_to=sweep_to,
                as_at=as_at,
                scenario_id=scenario_id,
                anchor_node_id=anchor_node_id,
                context_key=context_key,
                context_selector=context_selector,
                mece_dimensions=tuple(mece_dimensions or ()),
                edge_dict=edge_dict,
            )
        )
    return descriptors


__all__ = [
    'PrimitiveEdgeBindingDescriptor',
    'build_candidates_for_descriptor',
    'enumerate_per_edge_descriptors',
]
