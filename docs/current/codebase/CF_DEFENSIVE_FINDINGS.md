# CF Defensive-Code Findings

**Status**: Active reference, 12-May-26
**Source**: [`docs/current/cf-defensive-coding-audit.md`](../cf-defensive-coding-audit.md) (full audit, 12-May-26, branch `feature/snapshot-db-phase0`).
**Scope**: executive summary of the 21 defensive-code findings in the CF engine, organised by impact, with code pointers and remediation owners. Bridges the audit to the runtime architecture docs ([FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md), [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md), [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md)) and the canonical invariants ([INVARIANTS.md](INVARIANTS.md) I-47, I-48).

The full audit is the source of truth for severity, category breakdown, and per-finding remediation detail. This doc is the actionable summary an agent reads to understand **what the engine still gets wrong and where**.

---

## ⚠️ STOP — read this before adding any code in the CF engine

The 21 findings below are **debt being retired**, not precedent. The maintainer constantly polices these patterns and **will revert any new instances**.

**Defensive coding inside the engine is dangerous and must be avoided.** Specifically:

- No `or 0.0`, `or []`, `or None` fallback chains.
- No `np.clip` to "keep `log()` finite" or "stay in `[0,1]`".
- No `try/except: pass` swallows — assignment to a Python attribute cannot raise; if it can, that's the bug.
- No `if x is None: return <sentinel>` early-returns inside math.
- No `getattr(x, 'p', 0.0) or 0.0` cascades — define a strict type and require it.
- No schema case-forks (`y` vs `Y`, `str` vs `date`). Schema normalisation is the perimeter's job.
- No `max(0.0, residual)` clamps. Negative residuals are diagnostic gold.
- No "branch on `is_identity_carrier`" or "branch on `is_window`" near the centre of a function. Identity and window are **data-driven degeneracies of one path**, not different paths.

**The rule, stated once**: the engine is a mathematical object that must degenerate algebraically ([INVARIANTS.md](INVARIANTS.md) I-47). Missing values propagate as NaN. Missing keys raise. Out-of-shape inputs refuse at the perimeter. The engine never repairs upstream defects — it surfaces them.

If you encounter existing code that seems to justify adding a new fallback ("look, this is everywhere already"), that code is exactly the debt this doc tracks. **Do not extend the pattern; if anything, this is the time to retire one of the listed findings.**

---

## The principle

> "No fallbacks within the engine — all defence, if any needed, should be at the perimeter. The engine is a mathematical object and should degenerate algebraically."

User-stated 12-May-26. Codified as [INVARIANTS.md](INVARIANTS.md) I-47.

The audit found 21 violations across `graph-editor/lib/runner/` and `bayes/compiler/`. None are blocking the current v3 rollout — they don't change answers under well-formed inputs. They all **block fail-fast diagnosis** when defective inputs arrive, and they all violate the principle. Several silently corrupt math (HIGH severity).

---

## The seven HIGH-severity findings

These defeat the "algebraic degenerate" contract: they corrupt math, hide bugs, or silently switch mode.

| ID | Where | What | Why it corrupts |
|---|---|---|---|
| **H-1** | [`cohort_forecast_v3.py:3587`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3587) | `rate = min(1.0, max(prev_rate, max(0.0, float(rate))))` inside the rate-attributed Y_prefix integration | Monotone-repair clamp. Substitutes `prev_rate` whenever `rate < prev_rate`, hiding upstream non-monotonicity. Architecture explicitly forbids this (FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE §A.8). A real downstream rate dip is a diagnostic signal of an upstream defect (out-of-order window-mode evidence row); the clamp buries it. |
| **H-2** | [`funnel_engine.py:243, 254-255, 176-178`](../../graph-editor/lib/runner/funnel_engine.py#L243) | `p_means = np.array([float(e.get('p_mean') or 0.0) for e in cf_per_edge])` and `if resolved is None: p_means[j] = 0.0` | `0.0` substitutes for missing CF scalars in `np.cumprod(p_means)` — a single missing edge truncates the entire funnel path to zero, masquerading as a real "no conversion" outcome. Missing `p_mean` is **unknown**, not zero; algebraically the cumprod should be NaN. User-flagged hold-out. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md). |
| **H-3** | [`daily_conversions_derivation.py:65, 81-82`](../../graph-editor/lib/runner/daily_conversions_derivation.py#L65) | `current_Y = snap.get('y') or snap.get('Y') or 0` | Two defects in one expression: case-fork `y`/`Y` (schema-shape branch the perimeter should have normalised) plus zero-substitution for missing values. Collapses `delta_Y = current_Y − prev_Y` to `−prev_Y` (a negative daily count that the next line filters out via `if delta_Y > 0`, again silently swallowing). User-flagged hold-out. |
| **H-4** | [`cohort_forecast_v3.py:5347-5353`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5347) | `forecast_y_tau = max(0.0, float(forecast_y_tau) - float(evidence_y_tau))` | Floors the future-only residual at zero. If `evidence_y_tau > forecast_y_tau`, the projection and the evidence disagree — that is diagnostic gold. `max(0, ...)` buries it. The architecture's own §A.8 says "`evidence_y == 0` with positive `evidence_x` is a real zero rate"; by symmetry, negative residuals are real signals. |
| **H-5** | `cohort_forecast_v3.py` — 20+ sites, e.g. `:4161, 4229, 4486, 4695-4999, 5196, 5340`; plus `_synthesize_identity_carrier_observed_surface:4006-4109` | Pervasive `if is_identity_carrier:` branching in the selected-Cohort reducer and row projection | The architecture is explicit ([FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) §4): "identity carrier is data, not a route. `window()` and `cohort(A = X)` are degeneracies of the same runtime object." The semantic pseudocode describes identity as the algebraic case `composed_carrier = identity ⇒ Pop C = 0`. In code this is implemented as 20+ branches plus a parallel synthesis helper that duplicates active-path logic. **The single largest unification opportunity.** Build an identity `ComposedPrimitiveSpan` once (reach=1, CDF=Dirac(0)), feed through the active path, delete every `is_identity_carrier` branch and the synthesis helper. AP58, I-45. |
| **H-6** | [`bayes/compiler/calibration.py:218, 292`](../../bayes/compiler/calibration.py#L218); [`bayes/compiler/inference.py:578, 779, 787, 799, 821`](../../bayes/compiler/inference.py#L578) | `np.clip(p_draws * compl, 1e-6, 1.0 - 1e-6)`, `np.clip(p_implied, 0.001, 0.999)` | Six clip sites in the Bayes likelihood, none mathematically motivated. They exist to keep `log(p)` finite. `p_eff = 0` should be a real signal that an edge cannot fire under this completeness; clamping to `1e-6` adds artificial log-likelihood mass that biases the posterior. The principled fix is log-space-aware likelihood: where `q == 0`, the term is `log(L) = 0` if `k == 0` else `−∞`; the model should refuse rather than clip. |
| **H-7** | [`timing_span.py:256-281, 353-375`](../../graph-editor/lib/runner/timing_span.py#L256) | `p = float(getattr(primitive, 'p', 0.0) or 0.0)` for `p`, `mu`, `sigma`, `onset` | Double fallback (`getattr` default plus `or 0.0`) treats `None`, missing attribute, and zero as equivalent. A primitive with `p = None` from a legitimate prior-only refusal becomes `p = 0`, producing a span timing that integrates to zero — the engine silently emits "no flow possible" when the truth is "no information". Fix: strict dataclass for the primitive shape; non-Optional fields; perimeter coerces. |

---

## The nine MEDIUM-severity findings

These mask invalid inputs without changing answers when inputs are clean, but block fail-fast diagnosis.

| ID | Where | Pattern |
|---|---|---|
| M-1 | `cohort_forecast_v3.py:4147-4154, 4527-4530, 5659, 5895, 5899`; `forecast_state.py:1794` | `try: ...; except Exception: pass` on diagnostic / provenance writes. Assignment to a Python attribute cannot raise — the try/except is cargo-cult. Turns sharp invariant violations into slow silent drifts. |
| M-2 | `cohort_forecast_v3.py:1603`; `primitive_conditioning.py:1318`; `prefix_arrival.py:354` | `np.clip(cdf, 0.0, 1.0)` and `np.clip(pmf, 0.0, None)` on convolution outputs. CDFs algebraically in [0,1]; clip masks numerical drift that should surface in provenance. |
| M-3 | `cohort_forecast_v3.py:3293, 3338, 3355, 5421` | `max(0.0, min(1.0, k_val / n_val))` rate cap. `k > n` is a real data error (duplicate counting, slice overlap); clamping hides it forever. |
| M-4 | `confidence_bands.py:97, 110-111`; `span_kernel.py:404, 410` | Sample-edge clipping (`p ∈ [1e-6, 1-1e-6]`, `sigma ∈ [0.01, 20.0]`). Same log-space hygiene problem as H-6. |
| M-5 | `forecast_runtime.py:1339-1344` | `_resolve_evidence_role` swallows both import failure (deployment defect) and date parse failure (DSL defect). Conflates two distinct error classes. |
| M-6 | `cohort_forecast_v3.py:2867-2870` | `_weighted_evidence_provenance` swallows `to_provenance_dict()` exception, collapsing "real primitive bug" with "primitive absent" into a single None signal. |
| M-7 | `cohort_forecast_v3.py` (~15 sites); `daily_conversions_derivation.py:45, 157-159`; `cohort_maturity_derivation.py:72-73, 107-108, 283, 287`; `span_evidence.py` (6 sites) | `isinstance(anchor, str)` dispatch on schema shape. Every engine entry coerces `str`-vs-`date`. Schema should be normalised once at the perimeter. |
| M-8 | `funnel_engine.py:125-131` | `if not isinstance(n_0, (int, float)) or n_0 <= 0: return all-zero bars`. Missing `n_0` becomes a "zero conversions" funnel, indistinguishable from a real zero. Should be NaN. |
| M-9 | `epistemic_bands.py:55-73, 147-150, 154, 242-243` | `fit_history = stashed.get('fit_history') or []`. Missing fit history returns an empty ribbon — visually indistinguishable from "no edge ever fit". Should refuse with `EpistemicBandsUnavailable`. |

---

## The five LOW-severity findings

Diagnostic / observability paths; cosmetic but worth removing.

| ID | Where | Pattern |
|---|---|---|
| L-1 | `cohort_forecast_v3.py:2814-2817, 5643-5660, 1373`; `forecast_state.py:1790-1795` | Broad try/except around DIAG file writes to `/tmp` and conditional imports. Acceptable but should be diagnostic-mode gated and use specific exception types. |
| L-2 | `cohort_forecast_v3.py:939-940` | `int(getattr(candidate, 'n', 0) or 0)` in candidate translation. Malformed candidate (`n=None`) silently becomes zero. |
| L-3 | `funnel_engine.py:64-65` | Wilson CI at `n=0` returns `(0.0, 0.0)` — "we know with certainty it's zero." Should be `(NaN, NaN)` or raise. |
| L-4 | `cohort_forecast_v3.py:4060-4064` | Identity-backmap fallback synthesises `{observed: 1.0}` when `root_day_shares` is empty AND `observed in anchor_set`. Implicit mode inference; should be set explicitly by the carrier composer. |
| L-5 | `statisticalEnhancementService.ts` (100+ sites, e.g. `:1492-1493, 1508-1509, 1715, 1733, 1737, 2254, 2264-2265, 2295, 2301, 2306, 2345-2357`) | TS perimeter `?? 0` substitutions in the FE topo Step 1/Step 2 surface. Defensible at the perimeter (FE must render something on a partially-fetched graph) but the volume indicates the input schema is not type-disciplined. |

---

## Parallel code paths (F-1 through F-5)

Beyond H-5 (identity vs active), the engine carries five known parallel code paths for what could be one:

| ID | Parallel paths | What they all compute | Unification opportunity |
|---|---|---|---|
| F-1 | `daily_conversions_derivation`, `funnel_engine`, `cohort_maturity_derivation`, `cohort_forecast_v3._selected_cohort_group_rate_draws` | Variations of `ΣY / ΣX` | Extract one mass-first reducer interface. All four feed it with appropriate evidence shapes. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md). |
| F-2 | `build_cohort_evidence_from_frames` forks on identity vs active several times internally | Identity-carrier observed prefixes vs active-mode placeholder frames | Split into two functions or return absence instead of zeros. |
| F-3 | `_composed_pair_per_tau_rate_draws` vs `_selected_cohort_group_rate_draws` | Two reducers (model overlay vs E+F mass) | Principled split (model-only vs evidence-aware), but inner loops have accumulated similar shapes — worth documenting shared subroutines. |
| F-4 | `primitive_readout.py:919, 951, 1114` — three call sites of `compose_primitive_span` with role-specific lookups | Carrier vs subject role dispatch | Consolidate into a single composition helper returning a role-tagged result. |
| F-5 | Engine-internal `engine_cohorts.obs_x/obs_y` vs `SelectedAClockEvidence` fork | Active observed evidence path vs identity-carrier / window evidence path | The seam invariant (§A.4) controls this today via "when `selected_a_clock_evidence` exists, it is authoritative; legacy fallback refused." The mere fact that the implementation note exists is a smell. Atom 2 design unifies. |

---

## Priority remediation order (from the audit §7)

1. **H-5 — Identity carrier as data.** Single largest unification (20+ branches collapse to one), enables architecture-principle-consistent code. Substantial PR. [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) invariant 6 is the canonical statement.
2. **H-2 — Funnel zero-substitution.** User-flagged hold-out, highest false-positive risk (silent zero funnels rendered to users). Perimeter validates CF response shape before invoking.
3. **H-1 — Monotone-repair clamp.** Architecture forbids in writing (§A.8). Replace with non-monotonicity provenance.
4. **H-7 — Timing-span strict typing.** Single file; opens the door to dropping `or 0.0` cascades wherever `getattr` is currently the contract.
5. **H-6 — Bayes likelihood log-space.** Six clip sites; single largest source of silent posterior bias.

After these: F-1 unification (one mass-first reducer); strict-type `evidence_superset_rows` so the engine doesn't decode raw dicts; resolve "absent vs zero" everywhere (L-3, M-9, H-4).

---

## Where the perimeter is already strong

The audit also records what's working — useful negative space:

- `forecast_preparation.py` does substantial DSL parsing and envelope construction; raises typed errors on bad input.
- `request_envelope.py` builds candidate pools with explicit identity translation.
- `analysis_subject_resolution.py` enforces type rules for analysis dispatch via `ANALYSIS_TYPE_SCOPE_RULES`.
- `primitive_residual_guard.py` explicitly marks unsupported residual / complement edges rather than silently emitting zero — the model the engine should aspire to. See [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md).

The work is closing the gap between these perimeter modules and the engine core.

---

## Cross-references

- [`docs/current/cf-defensive-coding-audit.md`](../cf-defensive-coding-audit.md) — full audit, per-finding detail, category breakdown.
- [INVARIANTS.md](INVARIANTS.md) I-47 — "engine fallbacks are perimeter-only" (the rule violated by every finding above).
- [INVARIANTS.md](INVARIANTS.md) I-48 — "single conditioning locus" (the rule that H-5 fixes structurally).
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58 — "forking by case instead of degenerating one path" (the structural pattern behind H-5 and F-1 through F-5).
- [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md) — F-1 in detail.
- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3 — the load-bearing invariants the audit measures against.
