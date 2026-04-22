# Doc 49 — Epistemic/Predictive Separation and Conversion Rate Analysis

**Status**: Design — partially superseded by doc 61 (22-Apr-26)
**Date**: 18-Apr-26
**Purpose**: (1) Separate epistemic and predictive uncertainty exports
throughout the compiler, worker, and FE projection pipeline. (2) Define
a new "Conversion Rate" analysis type that consumes the epistemic export
to show population-rate uncertainty bands.

---

**Supersession note (22-Apr-26)**: [doc 61](61-dispersion-naming-symmetry.md)
supersedes two decisions in this document:

1. **§A.6 Invariant 9** — the asymmetric naming convention ("bare name is
   epistemic for probability, predictive for latency `mu_sd`") is retired.
   Under doc 61 the bare field name is epistemic everywhere and the
   `_pred` suffix denotes the predictive variant. `mu_sd_epist` is
   renamed to `mu_sd_pred` with its value flipping from "always-epistemic
   copy" to "predictive when kappa_lat fitted".

2. **§A.9 Invariant 5** — the model card displaying predictive ± values
   with an epistemic footnote for σ/onset is retired. Reporting surfaces
   (posterior card, ModelRateChart, cohort_maturity_v3 overlap curves)
   now display epistemic bands uniformly. Forecast surfaces continue to
   use predictive bands.

The underlying Bayesian separation and all other invariants in this doc
remain in force. The changes above are naming and consumer-wiring only;
the MCMC model is unchanged.

**Related**: Doc 27 (fit_history fidelity and as-at posterior), doc 48
(Bayes remediation — esp. Fix 3), doc 21 (unified posterior schema),
doc 34 (latency dispersion), doc 13 (quality gating)

---

## Part A — Epistemic/Predictive Separation

### A.1 The problem

Every alpha/beta pair currently exported from the Bayes compiler is
**predictive**, not **epistemic**. The two quantities answer different
questions:

- **Epistemic** (parameter uncertainty): "Where does the true
  conversion rate lie?" Shrinks with more data.
- **Predictive** (observation uncertainty): "What range of daily rates
  would I expect to see on a new day?" Has an irreducible floor from
  overdispersion (kappa). Does not shrink to zero.

The current export conflates them. `_predictive_alpha_beta()` in
`inference.py` (line 1045) takes raw MCMC trace samples and inflates
them through kappa before moment-matching to alpha/beta. The raw trace
samples — which *are* the epistemic posterior — are discarded.

Every downstream consumer inherits this conflation: `worker.py` packs
the predictive alpha/beta into slices, `bayesPatchService.ts` projects
them onto graph edges, `model_resolver.py` feeds them to the forecast
engine, and `ModelVarsCards.tsx` displays them as if they were the
posterior.

The same pattern occurs with latency: `mu_sd` starts as the epistemic
posterior SD of the MCMC mu samples (line 1308), but is silently
overwritten with a predictive value from `_predictive_mu_sd()` when
kappa_lat exists (line 1426). Meanwhile `sigma_sd` (line 1310) is
*not* overwritten — so the exported latency posterior has `mu_sd`
predictive and `sigma_sd` epistemic, side by side, with nothing to
distinguish them.

### A.2 Why separation matters now

The conversion rate analysis (Part B) needs epistemic bands to show
confidence narrowing over time. But every existing forecast consumer
correctly wants predictive alpha/beta — it draws future observations,
so it needs the wider distribution.

Without separation, we cannot serve both consumers. Widening all
exports to predictive (as today) makes epistemic bands useless.
Narrowing all exports to epistemic breaks forecasts.

### A.3 Scope: no model changes

The MCMC model is unchanged. No priors, likelihoods, sampling, or
model structure changes. The fitted trace is identical before and
after this work.

The entire separation lives in the **summarisation and export layer**:
how `inference.py` moment-matches trace samples into alpha/beta, how
`worker.py` packs those into slices, how the FE projects and consumes
them. The raw trace already contains both quantities — the
summarisation step currently discards the epistemic one when producing
the predictive one. The fix is to stop discarding it.

### A.4 Current state: what is produced where

#### A.4.1 Probability

| Quantity | Producer | Line | Semantics |
|----------|----------|------|-----------|
| `alpha`, `beta` (top-level) | `_fit_beta_to_samples(samples)` then overwritten by loop | inference.py ~977 | Epistemic (from raw p trace) — but never exported per-slice |
| `window_alpha`, `window_beta` | `_predictive_alpha_beta(w_samples, kp_samples)` | inference.py 1074 | **Predictive** — kappa-inflated |
| `window_hdi_lower`, `window_hdi_upper` | same call | inference.py 1074 | **Predictive** HDI |
| `cohort_alpha`, `cohort_beta` | `_predictive_alpha_beta(c_samples, kappa_arr)` | inference.py 1091 | **Predictive** — empirical kappa-inflated |
| `cohort_hdi_lower`, `cohort_hdi_upper` | same call | inference.py 1091 | **Predictive** HDI |
| `slice_posteriors[ctx]` | `_predictive_alpha_beta(_ps_samples, _ks_samples)` | inference.py 1177 | **Predictive** — kappa-inflated per-context |
| `p.stdev` on model_vars | computed from predictive alpha/beta | bayesPatchService.ts ~390 | **Predictive** (inherits) |

When kappa is absent, `_predictive_alpha_beta` falls back to plain
moment-matching (line 1056) — which IS epistemic. So edges without
kappa accidentally export the right thing, but nothing in the contract
says so.

#### A.4.2 Latency

| Quantity | Producer | Line | Semantics |
|----------|----------|------|-----------|
| `mu_sd` | `np.std(mu_samples)` | inference.py 1308 | Epistemic (posterior SD) |
| `mu_sd` (overwritten) | `_predictive_mu_sd()` when kappa_lat exists | inference.py 1426 | **Predictive** — replaces epistemic |
| `sigma_sd` | `np.std(sigma_samples)` | inference.py 1310 | Epistemic (posterior SD) — NOT overwritten |
| `onset_sd` | `np.std(onset_samples)` | inference.py ~1330 | Epistemic |
| `path_mu_sd` | `np.std(mu_c_samples)` | inference.py 1570 | Epistemic |
| `path_sigma_sd` | `np.std(sigma_c_samples)` | inference.py 1572 | Epistemic |

The inconsistency: after the kappa_lat overwrite, `mu_sd` is
predictive while `sigma_sd` is epistemic. Both are exported as
`LatencyPosteriorSummary` fields with no label to distinguish them.

### A.5 Current state: what consumers need

| Consumer | File | Field(s) consumed | Needs |
|----------|------|--------------------|-------|
| **Forecast MC draws (sweep)** | `forecast_state.py` 1112–1120 | `alpha`, `beta` → `rng.beta(alpha, beta, S)` | **Predictive** — drawing future observations |
| **Conditioned forecast IS** | `forecast_state.py` 493–504 | `alpha`, `beta` → `rng.beta(alpha, beta, S)` | **Predictive** — drawing future observations |
| **Completeness uncertainty** | `forecast_state.py` 114–171 | `mu_sd`, `sigma_sd`, `onset_sd` | **Predictive** — fan width for future CDF |
| **Fan bands on charts** | `api_handlers.py` 2514, `cohortComparisonBuilders.ts` | `p_stdev`, `mu_sd`, `sigma_sd` → `compute_confidence_band()` | **Predictive** — forecast fan width |
| **Model vars display** | `ModelVarsCards.tsx` | `alpha`, `beta`, `stdev`, `hdi_lower/upper`, `mu_sd`, `sigma_sd` | **Mixed** — see §A.9 |
| **Quality gating** | `bayesQualityTier.ts` | `rhat`, `ess`, `divergences` only | Neither — uses convergence diagnostics |
| **Conversion rate analysis** (new) | Part B of this doc | `alpha`, `beta`, `hdi_lower/upper` from fit_history | **Epistemic** — population-rate credible interval |
| **Model resolver** | `model_resolver.py` 186–226 | `alpha`, `beta`, `mu_sd`, `sigma_sd` | **Predictive** — feeds forecast engine |

### A.6 Proposed separation: probability

#### A.6.1 Compiler: produce both quantities

`_predictive_alpha_beta()` already has two code paths:
- `kappa_samples is not None` → predictive
- `kappa_samples is None` → epistemic (plain moment-match)

Change: for every slice, **always produce both**. Call
`_fit_beta_to_samples(p_samples)` for epistemic, and
`_predictive_alpha_beta(p_samples, kp_samples)` for predictive (when
kappa exists).

New fields on `PosteriorSummary`. Naming convention: the **suffix**
`_pred` or `_epist` qualifies any field. Bare names (no suffix) are
epistemic by default for probability, predictive by default for
latency `mu_sd` (matching current semantics to minimise churn).

```
# Existing fields become explicitly epistemic:
window_alpha, window_beta, window_hdi_lower, window_hdi_upper
cohort_alpha, cohort_beta, cohort_hdi_lower, cohort_hdi_upper
slice_posteriors[ctx] → {alpha, beta, hdi_lower, hdi_upper, ...}

# New predictive fields (None when kappa absent):
window_alpha_pred, window_beta_pred, window_hdi_lower_pred, window_hdi_upper_pred
cohort_alpha_pred, cohort_beta_pred, cohort_hdi_lower_pred, cohort_hdi_upper_pred
slice_posteriors[ctx] → adds {alpha_pred, beta_pred, hdi_lower_pred, hdi_upper_pred}
```

The top-level `alpha`, `beta`, `mean`, `stdev` remain epistemic (they
already are — they come from the raw trace before the per-slice
predictive step).

When kappa is absent, `*_pred` fields are `None`. Consumers that need
predictive values fall back to the bare (epistemic) values — which is
correct, because without kappa there is no overdispersion and the two
quantities are identical.

#### A.6.2 Compiler: latency separation

New fields on `LatencyPosteriorSummary`:

```
# Existing fields — semantics clarified:
mu_sd      → predictive when kappa_lat exists (from _predictive_mu_sd),
             epistemic otherwise. STAYS AS TODAY for display/fan consumers.
sigma_sd   → epistemic (posterior SD). No predictive mechanism today.
onset_sd   → epistemic (posterior SD). No predictive mechanism today.

# New epistemic field:
mu_sd_epist → always from np.std(mu_samples). Exported alongside mu_sd.
```

The overwrite at line 1426 is **kept** — `mu_sd` remains the
predictive value (when kappa_lat exists) because fan bands and model
cards need it. The change is to **also** export the epistemic value
as `mu_sd_epist` so that consumers needing parameter precision (e.g.
future latency-uncertainty analysis) have access to it.

`sigma_sd` and `onset_sd` are already epistemic and stay that way.
No predictive variant exists for them — sigma is constrained by curve
shape, onset by earliest conversions. If predictive variants are
needed in future, they follow the same `_pred` / `_epist` suffix
convention.

#### A.6.3 Worker: export both into slices

Each slice in the patch payload gains paired fields:

```yaml
slices:
  "window()":
    # Epistemic (posterior on the true rate):
    alpha: 12.3
    beta: 15.7
    p_hdi_lower: 0.33
    p_hdi_upper: 0.52
    # Predictive (expected range of future observations):
    alpha_pred: 8.1        # null when kappa absent
    beta_pred: 10.4
    hdi_lower_pred: 0.28
    hdi_upper_pred: 0.57
    # Latency:
    mu_sd: 0.19            # predictive (from _predictive_mu_sd) when kappa_lat
    mu_sd_epist: 0.12      # epistemic (posterior SD of mu trace)
    sigma_sd: 0.08         # epistemic (no predictive mechanism)
    onset_sd: 0.5          # epistemic (no predictive mechanism)
```

This applies to current `posterior.slices`, to `fit_history` entries
(full-fidelity per doc 27), and to the `SlicePosteriorEntry` /
`FitHistorySlice` TS types.

#### A.6.4 FE types: extend slice and posterior types

`SlicePosteriorEntry` gains:

```typescript
alpha_pred?: number;
beta_pred?: number;
hdi_lower_pred?: number;
hdi_upper_pred?: number;
mu_sd_epist?: number;
```

`FitHistorySlice` gains the same (all optional for backward compat).

`ProbabilityPosterior` (graph-edge level) gains:

```typescript
alpha_pred?: number;
beta_pred?: number;
hdi_lower_pred?: number;
hdi_upper_pred?: number;
// and path-level:
path_alpha_pred?: number;
path_beta_pred?: number;
path_hdi_lower_pred?: number;
path_hdi_upper_pred?: number;
```

`LatencyPosterior` gains:

```typescript
mu_sd_epist?: number;       // epistemic posterior SD of mu
// path-level:
path_mu_sd_epist?: number;
```

(`mu_sd` remains the predictive value as today. `sigma_sd` and
`onset_sd` are already epistemic and unchanged.)

#### A.6.5 FE patch projection: project both

`bayesPatchService.ts` projects both epistemic and predictive fields
from the patch slices onto the graph edge posteriors.

For `model_vars` entries, `probability.stdev` is computed from the
**epistemic** alpha/beta (the posterior SD). A new
`probability.stdev_pred` is computed from the predictive alpha/beta
when present.

### A.7 Consumer rewiring

| Consumer | Currently reads | Should read | Change |
|----------|----------------|-------------|--------|
| **forecast_state.py** (MC draws) | `alpha`, `beta` | `alpha_pred`, `beta_pred` (fall back to `alpha`, `beta` when None) | model_resolver returns predictive pair for forecast use |
| **compute_confidence_band()** | `p_stdev`, `mu_sd`, `sigma_sd` | `stdev_pred` (or `p_stdev`), `mu_sd` (already predictive), `sigma_sd` | api_handlers passes predictive p_stdev |
| **Fan bands** | `bayes_mu_sd`, `bayes_sigma_sd` | `bayes_mu_sd` (already predictive), `bayes_sigma_sd` | No change — mu_sd stays predictive |
| **ModelVarsCards** | `alpha`, `beta`, `stdev`, `hdi_*`, `mu_sd` | See §A.9 | Model card labelling change |
| **Model resolver** | `alpha`, `beta` | `alpha_pred`, `beta_pred` for forecast; `alpha`, `beta` for display | Return both pairs |
| **Conversion rate analysis** (new) | — | epistemic `alpha`, `beta`, `p_hdi_lower`, `p_hdi_upper` from fit_history | Consumes epistemic pair |

### A.8 Model resolver contract change

`model_resolver.py` currently returns one `ResolvedModelParams` with
one alpha/beta pair. After separation, it needs to return both:

```python
@dataclass
class ResolvedModelParams:
    # Epistemic (posterior on the true rate):
    alpha: float
    beta: float
    # Predictive (expected observation range; = epistemic when no kappa):
    alpha_pred: float
    beta_pred: float
    latency: ResolvedLatency  # with mu_sd (predictive), mu_sd_epist
```

Forecast consumers use `alpha_pred` / `beta_pred`. Display consumers
use `alpha` / `beta`. When `alpha_pred` is None (no kappa), fall back
to `alpha`.

### A.9 Model card dispersion labelling

After separation, the model card displays ± values with **different
semantics** side by side:

| Field | Display | Semantics | Why |
|-------|---------|-----------|-----|
| `p.mean ± stdev` | `5% ± 3%` | **Predictive** | "How noisy are daily observations?" — the useful at-a-glance number |
| `mu ± mu_sd` | `2.1 ± 0.19` | **Predictive** | From `_predictive_mu_sd()` — "how much does apparent mu vary across cohorts?" Drives fan bands on charts |
| `sigma ± sigma_sd` | `0.8 ± 0.08*` | **Epistemic** | Posterior SD — no predictive mechanism exists for sigma today |
| `onset ± onset_sd` | `3.0 ± 0.5*` | **Epistemic** | Posterior SD — no predictive mechanism exists for onset today |

**Principle**: displayed ± values should be **predictive** wherever a
predictive variant exists, because the model card answers "what should
I expect to see in practice?" `p.stdev` and `mu_sd` both have
predictive variants (from kappa and kappa_lat respectively). `sigma_sd`
and `onset_sd` do not — sigma is constrained by curve shape (stable
across cohorts) and onset by earliest conversions (a min-like
statistic less sensitive to count noise). If predictive variants for
these are built in future, the display follows suit.

**What changes**: `mu_sd` on the model card **stays predictive** (no
change to displayed value — the kappa_lat-inflated number is correct
for this context). The separation ensures the epistemic value is
*also* exported and available, but the card shows the predictive one.

**Surface treatment for the inconsistency**: `sigma_sd` and `onset_sd`
are epistemic while `p.stdev` and `mu_sd` are predictive. This needs
to be surfaced honestly. The epistemic ± values carry a footnote
marker (e.g. `0.8 ± 0.08*`). The footnote text:

> \* Epistemic — precision of the model's estimate.

An ⓘ icon offers a tooltip:

> This ± reflects how precisely the model knows this parameter given
> the data it has seen. It does not include day-to-day variation
> (overdispersion). The probability and mu lines above include
> observation-level variation.

### A.10 Relationship to doc 48

This separation **supersedes doc 48 Fix 3** ("Make cohort() uncertainty
export truthful"). Fix 3 identified the symptom: cohort alpha/beta are
not a clean Bayesian posterior. The root cause is the lack of
epistemic/predictive separation throughout the pipeline. Once
separation lands:

- Fix 3's "immediate truthfulness step" is achieved: epistemic
  alpha/beta are the direct posterior, clearly named.
- Fix 3's "preferred end state" is achieved: predictive alpha/beta are
  clearly named and explicitly kappa-derived.
- The `window-copy` fallback in `worker.py` (lines 2254–2277) becomes
  a question of which epistemic posterior to use for the cohort slice
  when no Phase 2 cohort variable exists — still a valid design
  question, but no longer a truthfulness problem because the fields
  are honestly labelled.

### A.11 Migration strategy

This is a semantic correction, not a feature toggle. The approach:

1. **Add new fields** to `PosteriorSummary`, `LatencyPosteriorSummary`,
   `SlicePosteriorEntry`, `FitHistorySlice`, and graph-edge posterior
   types. All optional / nullable for backward compatibility.

2. **Compiler change** (`inference.py`): always produce epistemic
   alpha/beta from raw trace samples. Produce predictive alpha/beta
   separately when kappa exists. Also export `mu_sd_epist` alongside
   the existing (predictive) `mu_sd`. Store both in the summary
   dataclasses.

3. **Worker change** (`worker.py`): export both sets into patch slices.

4. **FE projection** (`bayesPatchService.ts`): project both sets onto
   graph edges and model_vars entries.

5. **Consumer rewiring**: update each consumer to read the correct
   field for its purpose (§A.7 table).

6. **Backward compat**: when reading old patch files or fit_history
   entries that lack `*_pred` fields, treat the existing alpha/beta as
   "ambiguous" — consumers that need predictive values can still use
   them (they're predictive today), and epistemic consumers should
   flag them as "pre-separation, may include overdispersion."

7. **Model card surface change**: add footnote markers and ⓘ tooltips
   for epistemic ± values (§A.9).

---

## Part B — Conversion Rate Analysis Type

### B.1 Motivation

A new analysis type for watching conversion rates emerge over time
with epistemic uncertainty bands. Distinct from Daily Conversions
(which shows absolute ΔY counts per calendar date).

Primary use case: A/B testing. User creates two scenarios with
different context qualifiers and watches the rates and their
confidence intervals converge or diverge day by day.

### B.2 Scope: non-latency edges only

This analysis type is scoped to **non-latency edges** (edges where
the latency model is absent or has zero effect — completeness is
always 1). For these edges, every cohort's k/n is final the moment
it is observed: blobs don't move, the as-at fit_history walk gives
consistent epistemic bands, and no forecast engine is needed.

For **latency edges**, immature cohorts have incomplete k/n that
changes as late conversions land. This creates a three-way mismatch:
the blob uses current evidence (moves), the as-at fit_history
posterior is frozen, and a forecast would use current model params.
Overlaying epistemic bands on a latency-aware chart requires separate
design — the cohort maturity chart's tau-indexed framing may be a
better device for that case. Deferred to a future doc.

The handler should check whether the target edge has latency and
either suppress the analysis type from the picker or show a clear
"not available for edges with latency" message.

### B.3 Analysis type registration

New entry in `analysis_types.yaml`:

- **id**: `conversion_rate`
- **name**: "Conversion Rate"
- **when**: `node_count: 2, has_from: true, has_to: true`
- **runner**: `path_runner`

Both `window()` and `cohort()` mode supported. Slice selection follows
the temporal mode of the query.

### B.4 Chart specification

#### B.4.1 Axes

- **x-axis**: time bins (day/week/month, user-selectable chart
  setting, default day). Range is min/max across all visible
  scenarios.
- **y-axis**: conversion rate (0–1 or percentage).

#### B.4.2 Per scenario, per bin

Three visual layers, all in the scenario's colour:

1. **Observed rate scatter**: a circle at the raw k/n. Area scales
   with n (sensibly normalised across the visible range). Gives "daily
   raw observations" and a visual sense of their weight.

2. **Model midpoint line**: connects the epistemic posterior mean
   (`alpha / (alpha + beta)`) from the as-at fit_history entry for
   each bin date. Dashed line.

3. **Epistemic 90% HDI bands**: `p_hdi_lower` / `p_hdi_upper` from
   the same as-at fit_history entry. Non-striated solid fill at low
   opacity (0.10–0.15).

Multi-scenario: each scenario uses its own colour per the existing
scenario-colour convention.

#### B.4.3 Visual treatment

This chart type always renders as **lines + bands + sized scatter**.
No hi/lo bar option. Epistemic bands are **never striated** —
striation is reserved for forecast (predictive) uncertainty.

### B.5 Data source: fit_history as-at resolution

#### B.5.1 Per-bin posterior lookup

For a given bin date, select the **latest** `fit_history` entry with
`fitted_at` on or before that date. Same "on or before" semantics as
`resolveAsatPosterior` (doc 27 §5).

As the sweep moves through time, successive nightly fits contribute
progressively tighter posteriors. Early bins → wide bands (few fits,
weak prior). Later bins → narrow bands (many fits, strong posterior).
This is the "reverse trumpet."

No fit_history entry on or before a bin date → no bands or model line
for that bin. Strict, no fallback (doc 27 §2.1).

#### B.5.2 Slice selection

Follows the temporal mode of the query:
- `window()` mode → `window()` slice (or context-qualified)
- `cohort()` mode → `cohort()` slice (or context-qualified)

**Reads the epistemic fields** (`alpha`, `beta`, `p_hdi_lower`,
`p_hdi_upper`) — not the `*_pred` fields. This is the whole point.

When `p_hdi_lower`/`p_hdi_upper` are absent (legacy or slim entries),
compute from Beta(α, β) at the configured `hdi_level`.

#### B.5.3 Gating by evidence_grade

- Grade 0 (cold start): no bands or model line.
- Grade 1 (weak): bands de-emphasised (lower opacity or dashed).
- Grade 2+ (mature): full weight.

### B.6 BE integration

#### B.6.1 Shared function: `runner/epistemic_bands.py`

A pure function that resolves rate bands per bin date. Reusable by any
analysis type that needs per-date uncertainty on an edge's conversion
rate. **Revised 18-Apr-26** (see B.6.5 revision note below): the
resolver now walks the promoted-model fallback chain rather than
strict-matching Bayes slice keys. The bands are always populated
whenever the edge has any probability parameter.

Inputs:
- `edge`: full graph edge dict (the `{uuid, from, to, p: {...}}` block).
  The resolver pulls posterior, fit_history, and promoted model params
  from the edge; the raw `posterior.slices` dict is accessed through
  `p._posteriorSlices` when present.
- `dates`: list of bin dates (iso or UK format)
- `temporal_mode`: `window` or `cohort` — selects which slice is preferred
  when fit_history entries are available.
- `hdi_level`: default from posterior or 0.90

Output per date:
- `hdi_lower`, `hdi_upper`
- `posterior_mean`
- `evidence_grade`
- `hdi_level`
- `fitted_at` (provenance)
- `source_slice` (which slice key matched — empty when resolved from the
  current promoted alpha/beta rather than a fit_history entry)
- `source_model` (`bayesian` / `analytic_be` / `analytic` / `unknown`)

Resolution hierarchy per bin:
1. If the edge's promoted source is `bayesian` AND `fit_history` has an
   entry on-or-before the bin date, use that entry's alpha/beta. Within
   each entry, if the target slice (`cohort()` / `window()`) is absent,
   fall back to the sibling slice — justified because absence of a
   distinct slice means the compiler's evidence layer never
   distinguished cohort from window for this edge (top-of-graph case,
   or any edge with no latency ancestor). See B.6.4.
2. Otherwise fall back to the edge's current promoted alpha/beta via
   `resolve_model_params(edge, scope='edge', temporal_mode)`. This
   walks bayesian → analytic_be → analytic → evidence k/n →
   p.mean-with-kappa_fallback, so a band exists whenever the edge has
   any probability parameter at all.

Walk strategy: sort fit_history timeline ascending, sort input dates
ascending, merge-join walk O(n + m). For bins with no on-or-before
entry, fall back to step 2.

#### B.6.4 Cohort / window equivalence for non-latency edges

The Bayes compiler (see `bayes/compiler/model.py`, `_emit_edge_likelihoods`)
creates a separate `p_cohort_{eid}` latent only in Case A, when the edge
has BOTH window and cohort evidence. For non-latency edges at the top of
the graph (or anywhere without a latency ancestor), cohort framing does
not differ from window framing — upstream anchoring is a no-op. The
worker therefore emits `slices["cohort()"]` only when a distinct cohort
fit exists.

The absence of a `cohort()` slice on the edge is the compiler's
structural signal that cohort equals window for that edge. The resolver
treats that signal as authoritative: if the target slice key is missing
from either the current posterior or a fit_history entry, the sibling
slice is used. No topology lookup at query time — the compiler already
encoded the answer. The fallback is NOT applied blindly across all
edges; it is only applied per-entry based on what is actually missing.

#### B.6.5 Revision note (18-Apr-26)

The original B.6.1 described a strict slice-key matcher that returned
`None` for any bin without an exact fit_history entry match. This
produced empty bands in common scenarios (no fit_history, or the
chart's temporal_mode didn't align with the fit's slice key). The
revised resolver:

- Uses `resolve_model_params` to get the current promoted alpha/beta
  whenever fit_history lookup misses, so bands always populate.
- Accepts sibling-slice fallback within each fit_history entry for
  non-latency-ancestor edges, using compiler-emitted slice presence as
  the topology signal.
- Does not require the edge to have run Bayes at all — analytic_be and
  analytic promoted models also yield a band via the resolver's
  fallback chain.

Original functionality (strict match, single-source) is preserved as
the degenerate case of the new logic. Back-compat aliases
(`resolve_epistemic_bands`, `epistemic_band_to_dict`) still work; new
callers should use `resolve_rate_bands` / `rate_band_to_dict`.

#### B.6.2 Transport

The parameter file carries the full `posterior` including
`fit_history`. The projected graph-edge posterior does not carry
fit_history (intentionally slimmed). The BE handler loads parameter
files when resolving model params — fit_history is accessible there.

#### B.6.3 Response payload

Each bin entry in the response:

```json
{
  "bin_start": "2026-03-10",
  "bin_end": "2026-03-16",
  "x": 1400,
  "y": 630,
  "rate": 0.45,
  "epistemic": {
    "hdi_lower": 0.40,
    "hdi_upper": 0.50,
    "posterior_mean": 0.44,
    "hdi_level": 0.90,
    "evidence_grade": 2,
    "fitted_at": "9-Mar-26",
    "source_slice": "window()"
  }
}
```

`epistemic` is optional. Chart builders degrade gracefully when absent.

### B.7 Chart settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Bin size | day / week / month | day | Aggregation period |
| Show epistemic bands | boolean | true | Toggle HDI bands |
| Show model midpoint | boolean | true | Toggle posterior mean line |

### B.8 Tooltip

On hover: observed rate (k/n with values), model 90% HDI [lower,
upper], posterior mean, "model as of" fitted_at date, source slice.

### B.9 Worked example

Two scenarios on a non-latency edge (e.g. a real-time event-driven
conversion where completeness is always 1):

- **Control**: `from(Landing).to(Signup).cohort(1-Feb-26, 31-Mar-26).context(variant:control)`
- **Treatment**: same, `.context(variant:treatment)`

Chart settings: bin = day, epistemic bands on.

Each day shows a scatter point (area ~ n) at the observed k/n. The
rate is final — no late conversions will arrive. A dashed line traces
the posterior mean from the as-at fit_history. A band shows the 90%
HDI.

Early February: both bands wide (few fits, weak prior). As nightly
fits accumulate through March, bands narrow. If treatment genuinely
outperforms control, the bands separate. When they no longer overlap,
the user can conclude with 90% confidence that treatment > control.

---

## Part C — Scope and Phasing

### Phase 0: Epistemic/predictive separation in compiler + export

1. Add `*_pred` and `mu_sd_epist` fields to `PosteriorSummary`,
   `LatencyPosteriorSummary`.
2. Change `inference.py`: always produce epistemic alpha/beta from raw
   trace; produce predictive separately when kappa exists. Also export
   `mu_sd_epist` alongside the existing (predictive) `mu_sd`.
3. Change `worker.py`: export both sets into patch slices.
4. Extend `SlicePosteriorEntry`, `FitHistorySlice`, graph-edge
   posterior types in TS.
5. Update `bayesPatchService.ts` projection.
6. Rewire forecast consumers to use `*_pred` fields (with epistemic
   fallback when `*_pred` is None).
7. Add footnote markers and ⓘ tooltips to `ModelVarsCards` for
   epistemic ± values (§A.9).

### Phase 1: Conversion rate analysis type

1. Register `conversion_rate` in `analysis_types.yaml`.
2. Implement `runner/epistemic_bands.py`.
3. Implement BE handler (bin aggregation + epistemic band resolution).
4. Implement FE chart builder (sized scatter + model midpoint line +
   non-striated HDI bands, multi-scenario colour).

### Future phases (each requires separate design)

Two further building phases are identified. Each involves non-trivial
reasoning and will need its own design doc.

**Latency-edge conversion rate analysis.** For latency edges, immature
cohorts have incomplete k/n that changes as late conversions land.
This creates a three-way mismatch: current evidence (moves),
historical model (frozen), and current forecast (different model
params). The epistemic and predictive components interact in ways
that the non-latency design does not address. The cohort maturity
chart's tau-indexed framing may be a better device — it already
handles the "evidence then prediction" split and has as-at model vars
at each tau point. Needs fresh reasoning.

**Funnel and bridge charts (hi/lo bars).** These show bars, not lines.
The semantics of "epistemic uncertainty on a funnel stage" differ from
"epistemic uncertainty on a daily rate" — funnel stages aggregate
across time and cohorts, so the epistemic interval is not a simple
per-bin HDI lookup. Bridge charts decompose differences between
scenarios, adding further compositional complexity.

**Update (20-Apr-26)**: funnel hi/lo bars reasoning resolved in [52-funnel-hi-lo-bars-design.md](52-funnel-hi-lo-bars-design.md) — Level 2 design routing funnel computation through the MC forecast engine with per-regime semantics (e / f / e+f), stacked-bar visualisation with striated residual, and IS conditioning for the e+f case. Implementation pending approval. Bridge charts are discussed there as a derived view, to be scoped separately.

---

## Invariants

1. **Epistemic alpha/beta** are always the direct moment-match of raw
   MCMC trace samples, never kappa-inflated.

2. **Predictive alpha/beta** are always produced through kappa
   inflation (or are None when kappa is absent).

3. **When kappa is absent**, predictive fields are None. Consumers
   fall back to epistemic values, which is correct — without
   overdispersion the two are identical.

4. **mu_sd stays predictive** (kappa_lat-inflated when available) for
   display and fan-band consumers. The epistemic value is *also*
   exported as `mu_sd_epist`. Both are clearly named. The silent
   overwrite becomes an explicit "primary is predictive, epistemic
   exported alongside."

5. **Forecast consumers use predictive.** Model cards show predictive
   for `p.stdev` and `mu_sd`, epistemic for `sigma_sd` and `onset_sd`
   (with footnote). Conversion rate analysis uses epistemic.

6. **Epistemic bands are never striated.** Visual distinction from
   forecast bands maintained.

7. **fit_history entries carry both** (when the fit that produced them
   had kappa). The conversion rate analysis reads the epistemic pair.

8. **Backward compat**: old entries without `*_pred` fields are
   treated as ambiguous. Consumers that need predictive values can
   still use the bare alpha/beta (they are predictive in old data).
   Epistemic consumers should flag old entries as pre-separation.

9. **Naming convention**: `_pred` and `_epist` are always suffixes,
   never prefixes. Bare field names keep their current semantics to
   minimise churn.

---

## Dependencies

- **Nightly fit pipeline**: epistemic band value scales with
  fit_history density.
- **Doc 27 full-fidelity fit_history**: epistemic bands need alpha/
  beta per fit_history entry (already required by doc 27).
- **This doc supersedes doc 48 Fix 3**: the separation achieves the
  truthfulness that Fix 3 calls for, more cleanly.
