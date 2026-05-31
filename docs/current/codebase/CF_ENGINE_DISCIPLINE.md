# CF Engine: Coding Discipline

**Status**: Active rule, 12-May-26. Read this before adding any code under `graph-editor/lib/runner/` or `bayes/compiler/`.

This doc captures *how to write engine code*. It is approach, not inventory. For the live list of known violations currently being retired see [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) (tracker).

---

## STOP — read this before adding any code in the CF engine

**Defensive coding inside the engine is dangerous and must be avoided.** Specifically:

- No `or 0.0`, `or []`, `or None` fallback chains.
- No `np.clip` to "keep `log()` finite" or "stay in `[0,1]`".
- No `try/except: pass` swallows — assignment to a Python attribute cannot raise; if it can, that's the bug.
- No `if x is None: return <sentinel>` early-returns inside math.
- No `getattr(x, 'p', 0.0) or 0.0` cascades — define a strict type and require it.
- No schema case-forks (`y` vs `Y`, `str` vs `date`). Schema normalisation is the perimeter's job.
- No `max(0.0, residual)` clamps. Negative residuals are diagnostic gold.
- No "branch on `is_identity_carrier`" or "branch on `is_window`" near the centre of a function. Identity and window are **data-driven degeneracies of one path**, not different paths.

The maintainer constantly polices these patterns and **will revert any new instances**. Existing violations in the engine are debt being retired — they are not precedent.

If you encounter existing code that seems to justify a new fallback ("look, this is everywhere already"), that code is exactly the debt the tracker records. Do not extend the pattern.

---

## The principle

> "No fallbacks within the engine — all defence, if any needed, should be at the perimeter. The engine is a mathematical object and should degenerate algebraically."

User-stated 12-May-26. Codified as [INVARIANTS.md](INVARIANTS.md) I-47. The structural pattern behind most violations is captured as [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58 ("forking by case instead of degenerating one path") and as I-46 ("one resolution chain, one runtime object").

In practice: **missing values propagate as `NaN`, missing keys raise, out-of-shape inputs refuse at the perimeter**. The engine never repairs upstream defects; it surfaces them.

---

## What to do instead

When you feel the urge to add defensive code in the engine, that urge usually means one of three things:

1. **The perimeter isn't doing its job.** Fix the perimeter (`forecast_preparation.py`, `request_envelope.py`, `evidence_adapters.py`, `forecast_runtime.py`, `api_handlers.py`) so the engine only sees well-typed inputs. Engine code does not repair upstream defects.
2. **The type contract is too loose.** Replace `dict` / `Optional` / `Any` with a strict dataclass that names exactly what is required. Then `getattr` becomes attribute access and `or 0.0` becomes impossible.
3. **You haven't yet identified the algebraic degenerate for this case.** Window vs cohort, identity vs active, single-hop vs multi-hop, latency vs non-latency are degeneracies of one runtime object (AP58, I-46). Build the degenerate as data fed through the active path; do not branch.

Concrete substitutions for the patterns most often reached for:

| If you're tempted to write | The reason it's wrong | Do this instead |
|---|---|---|
| `val = d.get(k) or 0.0` | Missing key collapses to a real numeric zero, indistinguishable from a measured zero | `val = d[k]` — let `KeyError` raise. If absence is legitimate, model it explicitly upstream as `NaN` |
| `getattr(prim, 'p', 0.0) or 0.0` | None / missing attribute become 0; "no information" becomes "no flow" | Define a strict dataclass with non-Optional fields; the perimeter coerces |
| `np.clip(cdf, 0.0, 1.0)` | Hides numerical drift that should surface in provenance | Leave bare. If drift is large enough to worry about (e.g. > 1e-9 outside the algebraic range), raise via a provenance assertion |
| `try: ...; except Exception: pass` on an assignment | Assignment to a Python attribute cannot raise; the try/except is cargo-cult | Delete it. If the assignment can actually fail, that failure is the bug to investigate |
| `if x is None: return <sentinel>` inside math | Silently switches mode based on data presence | At the perimeter, refuse with a typed error. Inside the engine, the variable is non-Optional by contract |
| `max(0.0, residual)` | Negative residual is diagnostic gold — model and evidence disagree | Let it through. Surface the sign in the response provenance |
| `if is_identity_carrier: <branch>` | Identity is data, not a route | Build an identity primitive (`reach = 1`, `CDF = Dirac(0)`) and feed it through the active path |
| `isinstance(anchor, str)` schema fork | Schema-shape branching inside the engine | Normalise once at the perimeter; the engine sees one shape |
| `rows = rows or []` for evidence | Missing rows become an empty iterable, indistinguishable from "no rows matched" | Refuse at the perimeter; absence inside the engine is a bug |

The same shape generalises: where the data is wrong, NaN-propagate or raise. Where the schema is wrong, normalise upstream. Where the case feels different, look for the degenerate that makes it the same path.

---

## Self-check before writing defensive code in the engine

If you are about to add any guard, fallback, clip, or `try/except` inside `graph-editor/lib/runner/` or `bayes/compiler/`, answer all three questions first:

1. **Where is the perimeter for this input?** Name the file and function that should have coerced or refused this value. If you cannot, the engine is not where to fix this.
2. **What is the strict type contract?** Name the dataclass field (or write one) that should make this guard impossible. "It might be None" is a contract bug, not a runtime bug.
3. **What does the algebraic degenerate look like here?** For probabilities, missing → `NaN`. For counts, missing → `KeyError` at the perimeter, never zero substitution. For carrier-arrival, identity is `reach = 1, CDF = Dirac(0)` fed through the same path. If you cannot state the degenerate, you have not yet understood the case you are about to branch on.

Without crisp answers to all three, you have either a perimeter bug, a type-contract bug, or a refactoring opportunity — not a defensive-coding requirement.

---

## Where the perimeter lives

These modules are where defence belongs. New validation, coercion, schema normalisation, and refusal should land here, not inside the engine:

- [`forecast_preparation.py`](../../graph-editor/lib/runner/forecast_preparation.py) — DSL parsing, envelope construction, typed refusal on bad input.
- [`request_envelope.py`](../../graph-editor/lib/runner/request_envelope.py) — candidate pool construction, explicit identity translation.
- [`evidence_adapters.py`](../../graph-editor/lib/runner/evidence_adapters.py) — schema normalisation for evidence rows.
- [`forecast_runtime.py`](../../graph-editor/lib/runner/forecast_runtime.py) — entry-point validation, role resolution.
- [`api_handlers.py`](../../graph-editor/lib/api_handlers.py) — request-shape validation and response framing.
- [`analysis_subject_resolution.py`](../../graph-editor/lib/analysis_subject_resolution.py) — analysis dispatch type rules (`ANALYSIS_TYPE_SCOPE_RULES`).
- [`primitive_residual_guard.py`](../../graph-editor/lib/runner/primitive_residual_guard.py) — explicit marking of unsupported residual / complement edges; the model the engine core should aspire to. See [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md).

Inside `cohort_forecast_v3.py`, `primitive_*.py`, `*_span.py`, `funnel_engine.py`, `daily_conversions_derivation.py`, `cohort_maturity_derivation.py`, `epistemic_bands.py`, and the Bayes compiler — **no defence, no fallback, no clip, no swallow**.

---

## Cross-references

- [INVARIANTS.md](INVARIANTS.md) I-47 — engine fallbacks are perimeter-only (canonical rule).
- [INVARIANTS.md](INVARIANTS.md) I-46 — one resolution chain, one runtime object.
- [INVARIANTS.md](INVARIANTS.md) I-48 — single conditioning locus.
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58 — forking by case instead of degenerating one path.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — live tracker of known violations being retired. **Not precedent for new code.**
- [`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md) — original 21-finding audit (12-May-26) with per-finding detail.
