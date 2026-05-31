# CF Residual Guard

**Status**: Active reference, 12-May-26
**Scope**: the residual / complement / unparameterised-edge refusal surface in `primitive_residual_guard.py`. The first guardrail for edge requirements that primitive conditioning cannot serve.

This is a 390-line module whose entire content is a refusal taxonomy plus a single constructor for `STRUCTURALLY_DETERMINISTIC` primitives. Designed to fail loud rather than silently derive missing probabilities.

---

## What the guard enforces

> "The first implementation deliberately does NOT derive residual probabilities. It may pass through explicit deterministic graph semantics, but otherwise marks unparameterised residual / complement edges UNSUPPORTED_RESIDUAL or DEGRADED for live CF composition."

Three rules:

1. **No adjacency-`1−p` derivation.** CF composition contains no `1 − p`, residual-sibling, or branch-complement code. A request for adjacency complement is refused (`forward_to_conditioning = False`) with a `rejection_reason` and `residual_policy.branch_complement_required` set, rather than being computed.
2. **No silent inference of determinism from missing evidence.** If `kind = STRUCTURALLY_DETERMINISTIC`, the caller must supply an explicit `deterministic_p`. Missing `deterministic_p` raises `ValueError`.
3. **No turning supported doc 29b topology into a residual problem.** Splits, joins, fan-in, fan-out, and side-exit leakage edges that lie inside the carrier or subject closure and have parameterised primitives remain normal DAG-composition cases. The guard MUST NOT misclassify these.

Graph-output sibling rebalancing remains owned by `UpdateManager.applyBatchLAGValues` after CF writeback. The guard does not move sibling rebalancing into CF.

---

## The five `EdgeRequirementKind` values

The composer (Layer 5 in [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md)) walks the carrier or subject closure, classifies each edge it needs, and presents an `EdgeRequirement` to the guard.

```python
class EdgeRequirementKind(str, Enum):
    PARAMETERISED = "parameterised"
    STRUCTURALLY_DETERMINISTIC = "structurally_deterministic"
    UNPARAMETERISED_RESIDUAL = "unparameterised_residual"
    UNPARAMETERISED_COMPLEMENT = "unparameterised_complement"
    PREPARED_SPAN_REJECTED = "prepared_span_rejected"
```

| Kind | What it means | Guard decision |
|---|---|---|
| `PARAMETERISED` (no adjacency-complement requested) | The composer needs a posterior on this edge and the edge has its own parameterisation. Forward to Stage 3 conditioning. | `forward_to_conditioning = True`. Stage 3 conditions; if its evidence is empty, Stage 3 emits `PRIOR_ONLY`. The guard never returns `UNSUPPORTED_RESIDUAL` for PARAMETERISED. |
| `PARAMETERISED` + `requires_adjacency_one_minus_p` | Composer would need to derive this edge's probability from a sibling's `1 − p`. | Refuse: `forward_to_conditioning = False`, `residual_policy.branch_complement_required` set. No primitive is built. CF composition does not perform `1 − p` sibling derivation. |
| `STRUCTURALLY_DETERMINISTIC` (with explicit `deterministic_p`) | Graph semantics fix `p` (e.g. boolean wiring). | Set `decision.deterministic_p`; the caller wires it into `make_structurally_deterministic_primitive`. No evidence consulted. |
| `STRUCTURALLY_DETERMINISTIC` without `deterministic_p` | Composer didn't supply the constant. | `ValueError`. Determinism is never inferred from missing evidence. |
| `UNPARAMETERISED_RESIDUAL` | Closure required a residual edge that has no parameterisation. | Refuse: `forward_to_conditioning = False`, `residual_policy.residual_closure_required` set. No primitive is built. |
| `UNPARAMETERISED_COMPLEMENT` | Branch complement needed (sibling `1 − p`) with no parameterisation. | Refuse: `forward_to_conditioning = False`, `residual_policy.branch_complement_required` set. No primitive is built. |
| `PREPARED_SPAN_REJECTED` | Stage 2's `validate_span_primitive` rejected a prepared span primitive (crosses X boundary, mixes incompatible metadata). | Refuse: `forward_to_conditioning = False`, `rejection_reason` carries the Stage 2 reason. No primitive is built. |

---

## The single primitive constructor

The guard exposes one factory that produces a `ConditionedTransitionPrimitive` in a non-conditioned state. Refusals no longer build a primitive: a refused `EdgeRequirement` propagates as a `ResidualGuardDecision` with `forward_to_conditioning = False` plus an explicit `rejection_reason` and (for residual/complement cases) a `residual_policy`. No primitive is constructed for a refused edge — the absence of a primitive plus the diagnostic IS the refusal. (The earlier `make_unsupported_residual_primitive` factory and the `UNSUPPORTED_RESIDUAL` status were removed; refusal is now signalled on the decision itself.)

### `make_structurally_deterministic_primitive`

Constructs a `status = STRUCTURALLY_DETERMINISTIC` primitive:

- `probability_posterior` is a constant draw family at `deterministic_p`; SD is zero; every draw is `deterministic_p` so composers can compose with other primitives without special-casing this status.
- `timing_posterior` is a Dirac at `deterministic_shift_days`: `cdf = 0.0` before the shift, `1.0` from the shift onward.
- `structural_identity_compat` carries any `μ` / `σ` / `onset` / `completeness` fields for legacy migration consumers — provenance only, never evidence-conditioned.
- `subset_policy = None`, `compatibility_blend = None`, `residual_policy = None` — no evidence, no blend, no residual.
- `draw_family_mode = KEYED_PRIOR`; `is_draw_coherent` is True.

The status is `STRUCTURALLY_DETERMINISTIC`, not `CONDITIONED` — no evidence shaped this posterior. Composers see a draw-coherent primitive whose draws happen to be constant.

---

## How to use the guard from a composer

Stage 5+ composers (the runtime's edge walks) follow this pattern:

```python
for edge in closure.edges:
    requirement = composer.classify_edge(edge)         # build an EdgeRequirement
    decision = classify_edge_requirement(requirement)  # ask the guard
    if decision.forward_to_conditioning:
        primitive = condition_primitive(...)           # Stage 3 owns the posterior
    elif decision.deterministic_p is not None:
        primitive = make_structurally_deterministic_primitive(
            ..., deterministic_p=decision.deterministic_p,
        )
        registry.register(primitive)
    else:
        # Refused: no primitive is built. The absence of a primitive
        # plus decision.rejection_reason / decision.residual_policy IS
        # the refusal — surface it as degraded provenance to the caller.
        report_refusal(decision.rejection_reason, decision.residual_policy)
```

The composer never embeds the refusal logic itself — `classify_edge_requirement` is the single decision point. No production composer consumes the guard yet: the v3 substrate's per-edge preparation step (`primitive_readout._prepare_conditioned_primitive`) binds evidence and calls `condition_primitive` directly, so the carrier and subject walks effectively treat every edge as `PARAMETERISED`. The guard remains shadow until residual-aware composition lands.

The guard is **Stage 4 in the plan choreography** — currently shadow per the plan's migration discipline. Stage 5+ composers will consume it directly when residual-aware composition lands.

---

## Why this surface exists at all

Pre-73n CF composition variously:

- Computed `1 − p` from sibling probabilities (silent adjacency derivation).
- Inferred determinism from "all evidence rows had `k == 0`" (silent maturity-mode confusion).
- Silently emitted zero-posterior primitives for unparameterised residual edges.

Each of these is a quiet semantic shift. A residual edge missing a parameterisation is a graph defect; treating it as `p = 0` (or worse, computing `1 − sibling_p`) silently produces results that look reasonable until they don't. The guard's refusal-first design surfaces the defect at the perimeter.

The pattern lines up with [INVARIANTS.md](INVARIANTS.md) I-47 (no fallbacks in the engine) and AP58 (forking by case instead of degenerating one path) — the guard refuses to fork by case ("this is the residual case so derive `1 − p`") and instead reports the gap.

---

## What the guard is NOT

- **Not the conditioner.** Conditioning is in `primitive_conditioning.condition_primitive`. The guard decides whether to forward to conditioning at all.
- **Not the place to add adjacency-complement support.** That work belongs in the composer + a new residual policy, not by relaxing the guard.
- **Not where sibling rebalancing lives.** Graph-output sibling rebalancing is owned by `UpdateManager.applyBatchLAGValues` after CF writeback. The guard refuses to take it on.
- **Not where prepared-span boundary validation lives.** `validate_span_primitive` in `primitive_evidence.py` is the validator. The guard consumes the rejection signal and emits `UNSUPPORTED_RESIDUAL`.

---

## Cross-references

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3 — the substrate invariants (including the role of the guard in the five-layer pipeline).
- [INVARIANTS.md](INVARIANTS.md) I-47 — "engine fallbacks are perimeter-only".
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58 — forking by case; the structural pattern the guard refuses to participate in.
- `primitive_residual_guard.py` — the implementation; module docstring records the rule lineage.
