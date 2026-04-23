## 65 — GM Rebuild `window()` vs `cohort()` CLI Investigation

**Date**: 23-Apr-26  
**Status**: Open investigation  
**Graph**: `bayes-test-gm-rebuild`  
**Subject**: `from(switch-registered).to(switch-success)`  
**Primary surfaces**: `cohort_maturity` (v3), `cohort_maturity_v2` (v2), `graph-ops/scripts/analyse.sh`

## 1. Purpose

This note records the outside-in CLI evidence for the live single-hop
downstream `cohort()` defect on the GM rebuild graph after the conditioned
forecast refactor workstream.

It is written as a pick-up note for a fresh agent. The goal is to capture:

- the exact public-tooling commands that were run
- the chart-level results they produced
- the current problem statement and semantic context
- the present suspect set, without overstating root cause certainty

The intended investigation loop is larger than this one production repro:

1. identify the defect clearly on a production-shaped graph
2. reproduce the **same** defect on the appropriate synth fixture using the
   public CLI tooling
3. use that synth reproduction as the main diagnostic and later regression
   harness
4. fix the shared conditioned-forecast machinery rather than treating
   `cohort_maturity` v3 as an isolated chart bug

That through-line is important. The goal is not merely to document that GM
rebuild looks wrong. The goal is to turn the production symptom into a
stable, tool-driven reproduction that can support precise diagnosis and
future assurance.

This note complements `46-v3-cohort-midpoint-inflation.md`. Doc 46 records
an earlier absolute-date reproduction on the same edge. This note refreshes
the evidence using the public CLI path and the relative-window comparison the
user explicitly requested: `window(-1d:)` versus `cohort(-1d:)`.

## 2. Problem statement

The live user-visible problem is that single-hop downstream `cohort()` in
the v3 conditioned-forecast/chart machinery rises far too quickly and
nearly coincides with `window()` on a case where upstream latency should
make `cohort()` materially slower.

For this query, the expected external behaviour is:

- `window()` should reflect the edge-rooted `X -> Y` progression
- `cohort()` should lag because the selected population is anchor-rooted and
  the downstream rate remains `y/x`, not `y/a`
- single-hop should degenerate naturally from the general factorised
  template rather than taking a different semantic shortcut

The defect is therefore not "cohort is a bit noisy". The defect is that the
v3 single-hop `cohort()` curve visually behaves too much like `window()`.

## 3. Refactor context

This work sits inside the conditioned-forecast refactor recorded in
`60-forecast-adaptation-programme.md`.

That workstream was meant to move the live CF/chart stack onto one explicit
runtime contract:

- `carrier_to_x`
- `subject_span`
- `numerator_representation`
- `admission_policy`
- `p_conditioning_evidence`

The important background for this investigation is that the refactor was
supposed to remove ad hoc semantic forks between chart and CF, and to make
single-hop behave as a natural degeneration of the same template used for
multi-hop.

The superordinate goal is broader than fixing one chart line. We are trying
to end up with robust, general-purpose conditioned-forecast machinery whose
semantics come from
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
and whose implementation reuses one well-engineered codepath across:

- `cohort_maturity` v3
- the BE conditioned-forecast pass
- other forecast-consuming analysis surfaces in the app

On that view, `cohort_maturity` v3 is primarily a diagnostic window into the
correct operation of the shared CF machinery. It is not the final objective
in its own right.

The user has repeatedly framed this as a conditioned-forecast machinery
problem, not a Bayes compiler problem. The CLI evidence below supports that
framing: the failure is on the FE-facing analysis path, not on a bespoke
forensic script.

## 4. Semantic backbone

Two documents are the main semantic backbone for this investigation:

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/project-bayes/60-forecast-adaptation-programme.md`

The key semantic rules from that backbone are:

- The displayed rate is always `y/x`, not `y/a`.
- In `cohort()` mode, the denominator side is the carrier question
  `A -> X`.
- In both single-hop and multi-hop, the numerator side is the subject
  progression question `X -> end`.
- Single-hop `cohort(A, X-Y)` is still an `X -> Y` subject question. It is
  not a licence to widen the subject operator into an anchor-rooted whole
  query object by default.
- The direct-`cohort()` rate-conditioning seam is narrow. It may move the
  rate side in exact single-hop cohort cases, but it must not silently
  retarget carrier semantics, latency semantics, or numerator
  representation.

That last point matters here because the tested query is exactly the kind of
single-hop cohort case where the narrow direct-`cohort()` rate-conditioning
path is admitted.

## 5. Why the CLI and synth tooling matter

The public CLI tooling should be the primary oracle for this defect.

`graph-ops/scripts/analyse.sh` exercises the same FE-facing preparation path
the browser uses:

- FE subject resolution
- regime selection
- snapshot reads
- analysis preparation
- BE analysis execution
- FE-style result normalisation

For a chart defect, this is the right level of evidence. Direct Python
handler calls may still be useful for secondary forensics, but they should
not be treated as the primary proof of what the user actually sees.

For this graph, the CLI diagnostics also confirmed that the target edge
already carried Bayesian model vars (`model_vars=true`), so this comparison
did not depend on an auxiliary sidecar-injection experiment.

The next intended use of this tooling is not another production-only probe.
Having identified the defect clearly on GM rebuild, the next step is to
reproduce the **same** single-hop `cohort()` collapse on a synth graph so
that:

- the reproduction is fast, stable, and disposable
- subsequent forensics do not depend on repeated production-graph probing
- the eventual fix can be locked down with a durable regression harness

This should be close to trivial with the current CLI/tooling stack. The
intended workflow is to point `analyse.sh` at the appropriate synth graph,
run with `--diag`, and inject the relevant Bayesian state from cached synth
truth or sidecar data rather than re-fitting from scratch.

`synth-mirror-4step` is the obvious first candidate because it is already
used as the project's main linear upstream-lag / mixed-class fixture and is
the closest existing synth analogue to this GM rebuild shape. That said, the
next agent should still verify the exact fixture and truth-file pairing
instead of assuming it blindly.

## 6. Exact CLI commands run

All commands were run from the dagnet repo root.

### V3 `window(-1d:)`

```bash
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).window(-1d:)" \
  --type cohort_maturity \
  --topo-pass \
  --no-cache \
  --no-snapshot-cache \
  --diag \
  --format json
```

### V3 `cohort(-1d:)`

```bash
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(-1d:)" \
  --type cohort_maturity \
  --topo-pass \
  --no-cache \
  --no-snapshot-cache \
  --diag \
  --format json
```

### V2 `window(-1d:)`

```bash
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).window(-1d:)" \
  --type cohort_maturity_v2 \
  --topo-pass \
  --no-cache \
  --no-snapshot-cache \
  --diag \
  --format json
```

### V2 `cohort(-1d:)`

```bash
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(-1d:)" \
  --type cohort_maturity_v2 \
  --topo-pass \
  --no-cache \
  --no-snapshot-cache \
  --diag \
  --format json
```

## 7. What the CLI proved before looking at curves

The diagnostics show that the CLI really did select different regimes for
the two runs.

For `window(-1d:)`:

- `effective_query_dsl="window(-1d:)"`
- `subject_is_window=true`
- surviving hash: `VTgXES1p_XdQoHMZ`
- `pre_rows=7`, `post_rows=4`

For `cohort(-1d:)`:

- `effective_query_dsl="cohort(-1d:)"`
- `subject_is_window=false`
- surviving hash: `XiDhZpbnp535eBHi`
- `pre_rows=7`, `post_rows=3`

So the near-collapse observed in v3 is not explained by the CLI accidentally
running the same window regime twice.

## 8. Headline chart results

### 8.1 Per-run chart headlines

| Surface | Query | First non-zero tau | Midpoint at tau 10 | Midpoint at tau 26 | Headline plot |
|---|---|---:|---:|---:|---|
| v2 | `window(-1d:)` | 5 | 0.5882 | 0.8235 | Fast normal rise; this is the expected window curve |
| v2 | `cohort(-1d:)` | 6 | 0.0590 | 0.4354 | Clear delayed take-off and persistent lag; this is the expected cohort separation |
| v3 | `window(-1d:)` | 5 | 0.5882 | 0.8235 | Same fast window curve as v2 |
| v3 | `cohort(-1d:)` | 5 | 0.5829 | 0.8264 | Almost complete overlap with `window(-1d:)`; this is the defect signal |

### 8.2 Window-versus-cohort separation inside each version

| Surface | `cohort - window` at tau 10 | `cohort - window` at tau 26 | Interpretation |
|---|---:|---:|---|
| v2 midpoint | -0.5292 | -0.3881 | `cohort()` is materially below `window()` |
| v3 midpoint | -0.0053 | +0.0029 | `cohort()` has almost collapsed onto `window()` |

The same pattern is visible on `model_midpoint` as well:

- v2 preserves a large `window()` versus `cohort()` gap
- v3 almost completely removes that gap

### 8.3 Key midpoint values

| Tau | v2 `window` | v2 `cohort` | v3 `window` | v3 `cohort` |
|---:|---:|---:|---:|---:|
| 5 | 0.0294 | 0.0000 | 0.0294 | 0.0566 |
| 6 | 0.2059 | 0.0005 | 0.2059 | 0.2121 |
| 8 | 0.4412 | 0.0107 | 0.4412 | 0.4467 |
| 10 | 0.5882 | 0.0590 | 0.5882 | 0.5829 |
| 14 | 0.7059 | 0.1585 | 0.7059 | 0.7149 |
| 20 | 0.7941 | 0.3135 | 0.7941 | 0.7913 |
| 26 | 0.8235 | 0.4354 | 0.8235 | 0.8264 |

This is the cleanest outside-in summary:

- window is stable across v2 and v3
- cohort is not
- v2 gives the expected delayed cohort shape
- v3 does not

## 9. Interpretation

The CLI evidence points to a narrow problem statement:

1. The public FE-facing tooling reproduces the defect.
2. The defect is specific to the v3 single-hop cohort path.
3. The defect is not explained by the CLI selecting the wrong regime.
4. The defect is not a general window-path failure, because v2 and v3
   `window(-1d:)` agree at the key taus above.

This reinforces the user's framing that the problem is in the conditioned
forecast machinery, especially on the single-hop downstream cohort path.

The chart shapes are also consistent with the user's semantic intuition that
the problem is primarily on the **y side**. The v3 cohort curve is not just
"a bit off". It rises as if the downstream numerator were being moved too
aggressively toward the window curve.

## 10. Current candidate cause set

Root cause is not yet proven, but the present suspect set is now narrower.

### 10.1 Residual single-hop special handling

A possible candidate has already been partially identified in the special
handling of single-hop.

One dedicated single-hop subject-helper fork has already been removed from
the live v3/CF path, because it violated the "single generalised path with
natural degeneracies" goal from docs 59 and 60.

However, the GM rebuild CLI evidence shows that removing that one fork did
not fully remove the defect on the real graph. That means either:

- more single-hop-specific behaviour still survives elsewhere, or
- the wrong semantic effect is being recreated through another seam

### 10.2 Narrow direct-`cohort()` rate-conditioning seam

The current live design admits direct `cohort()` evidence only in a narrow
case: exact single-hop cohort subjects.

That matters here because this GM rebuild query is exactly such a case.

This does **not** prove that the narrow direct-`cohort()` rate-conditioning
path is the root cause, but it makes it a live suspect. If that seam is
moving the downstream rate side too strongly, it would present exactly as a
single-hop `cohort()` curve that rises too fast while nominal carrier
semantics still exist.

This is the main reason not to treat "single-hop special handling removed"
as equivalent to "single-hop problem solved".

## 11. What is known and what is still unknown

### Known

- The CLI `analyse.sh` path reproduces the defect.
- The tested edge already has Bayesian model vars on the graph.
- The CLI selected different window and cohort regimes for the two runs.
- V2 shows a large downstream cohort lag on this exact subject.
- V3 almost removes that lag on this exact subject.
- The external behaviour is therefore still wrong after the CF refactor work
  already landed.

### Unknown

- Which exact v3 runtime object or branch is flattening the cohort delay.
- Whether the remaining fault is entirely inside the narrow
  `p_conditioning_evidence` seam, or whether another single-hop-specific
  semantic collapse still survives elsewhere.
- Whether the remaining failure happens at subject-span construction,
  rate-conditioning, or later forecast-state aggregation.

## 12. Recommended next steps for the next agent

1. Treat the GM rebuild CLI comparison above as the authoritative external
   defect statement for now. Do not replace it with a looser or merely
   "similar" repro before the synth path is proven.
2. Select the appropriate synth analogue, with `synth-mirror-4step` as the
   first candidate unless a closer truth-backed fixture is identified.
3. Build a dedicated CLI synth repro script that runs the same
   `window()` versus `cohort()` comparison through `analyse.sh`, with
   `--diag` enabled and Bayesian state injected from the synth truth / sidecar
   data rather than via a fresh fit.
4. Use that harness to confirm that the synth tooling reproduces the same
   production-shaped collapse reliably, rather than merely producing some
   generic v2/v3 difference.
5. Once synth-versus-production equivalence is established, trace the v3
   single-hop cohort path through the prepared runtime objects:
   `carrier_to_x`, `subject_span`, `numerator_representation`, and
   `p_conditioning_evidence`.
6. Pay particular attention to branches admitted only for exact single-hop
   `cohort()` subjects, especially anything that could recreate a
   window-like downstream rate update or a gross whole-query numerator effect
   by stealth.
7. When the cause is identified, keep the resulting regression guard focused
   on the shared conditioned-forecast machinery, not just on one
   `cohort_maturity` v3 presentation surface.

## 13. Main references

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md`
- `docs/current/project-bayes/60-forecast-adaptation-programme.md`
- `docs/current/project-bayes/62-direct-cohort-rate-conditioning-flag.md`
- `docs/current/project-bayes/46-v3-cohort-midpoint-inflation.md`

## 14. Pick-up log — 23-Apr-26 synth attempt

This section records the first pick-up attempt on this investigation. It
complements §1–§12 with concrete evidence from the synth side, records
defects discovered in passing, and documents the diagnostic gap that
has to be closed before doc 65 can be treated as regression-covered.

### 14.1 Synth reproduction attempt: `synth-mirror-4step`

`synth-mirror-4step` was selected as the first-pass analogue per §5 and
§12. It is a four-edge linear chain (`landing → created → delegated →
registered → success`) with substantial upstream latency on
`delegated → registered` (onset 5.5, mu 1.5, sigma 0.57) and a terminal
edge (`registered → success`, onset 3.2, mu 1.3, sigma 0.19) that is the
direct structural analogue of GM rebuild's `switch-registered →
switch-success`. Anchor is `m4-landing`, four hops upstream.

Two synth probes were run with the same four shapes as §6 (`v3 window`,
`v3 cohort`, `v2 window`, `v2 cohort`). `-1d:` is resolved against
wall-clock now and synth snapshot data does not reach today, so the
probes used absolute-date frontier queries instead:
`window(1-Mar-26:).asat(22-Mar-26)` and `cohort(1-Mar-26:).asat(22-Mar-26)`.

**Probe A — analytic model vars only**, using the graph's existing
`analytic` `model_vars` (no sidecar). §8.3 row for `tau=10`:

| tau | v2 win | v2 coh | v3 win | v3 coh | v2 Δ | v3 Δ |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 0.6366 | 0.0000 | 0.5012 | 0.0000 | −0.637 | −0.501 |
| 26 | 0.6366 | 0.2308 | 0.5012 | 0.2330 | −0.406 | −0.268 |

**Probe B — Bayesian model vars injected** via a freshly-fit sidecar
(`bayes/fixtures/synth-mirror-4step.bayes-vars.json`, generated by
`bayes/test_harness.py --graph synth-mirror-4step --enrich --sidecar-out
… --no-webhook`; 74s MCMC, rhat=1.002, ESS=9641, 100% converged; clean
ground-truth recovery on every edge). §8.3 row for `tau=10`:

| tau | v2 win | v2 coh | v3 win | v3 coh | v2 Δ | v3 Δ |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 0.6917 | 0.0000 | 0.6942 | 0.1202 | −0.692 | −0.574 |
| 26 | 0.6967 | 0.2308 | 0.6967 | 0.2903 | −0.466 | −0.407 |

Neither probe reproduces the GM rebuild signature that §8.2 names. The
headline failure — v3 cohort collapsing onto v3 window while v2
preserves a large gap — is **absent** on `synth-mirror-4step` at this
query shape, at both model-var tiers.

### 14.2 Separate anomaly: v3 cohort reads zero then plateaus well below truth

On `synth-mirror-4step` with the terminal edge (truth `p=0.7`),
`cohort(1-Mar-26:).asat(22-Mar-26)` produces `midpoint = 0` from tau 5
to tau ~14 on v3 and then plateaus around 0.29 by tau 26 with Bayesian
vars injected (0.23 with analytic vars). The underlying posterior
recovers `p=0.7101` cleanly. The v3 cohort midpoint on this query does
not approach truth across the plotted range.

This is a different failure class from the v3-cohort-onto-v3-window
collapse this note was written for. Candidate explanations, none yet
confirmed:

- path-level completeness gating cohort rows to zero until upstream
  arrivals mature (plausible for early tau; the low plateau at late
  tau is still suspicious);
- single-cohort evidence set too thin to drive the conditioned forecast;
- `asat()` interaction with `retrieved_at` windows on synth data
  specifically (synth retrievals stop at 22-Mar-26; prod has
  continuous retrievals).

The next agent should **not** assume this is the same defect doc 65
primarily tracks. It should be isolated on its own fixture and its own
reproduction.

### 14.3 Reliance on `asat()` is itself a risk

`-1d:` resolves against wall-clock now; synth data on disk does not
reach today, so `-1d:` probes on synth bind no rows and cannot
reproduce anything. The synth probes therefore had to use absolute
frontier dates plus `asat()` to emulate "from the frontier". That
introduces a second diagnostic axis we cannot fully control: any
`asat()`-related defect on the same path would be indistinguishable
from the defect this note tracks.

A synth reproduction that does not depend on `asat()` would be
materially easier to trust. Options for the next agent:

- refresh the synth data generation window so the most recent
  `retrieved_at` values cover "today", allowing `-1d:` to bind
  directly (preferred if the synth generator supports it);
- accept the `asat()` path but first isolate and close the
  `asat()`-specific defects separately.

### 14.4 Inability to reproduce the prod defect on synth is itself a devtooling failure

Even if `synth-mirror-4step` is ultimately ruled out as an inadequate
analogue, the broader project objective stated in §3 (one well-engineered
codepath reusable across `cohort_maturity` v3, the BE conditioned-forecast
pass, and other forecast-consuming surfaces) is not well served if no
synth fixture can be made to reproduce a defect visible in production.

The next agent should therefore treat "no synth reproduces this" as a
first-class devtooling issue to be closed, not as a neutral observation:

- enumerate the structural and data-shape differences between GM rebuild
  and `synth-mirror-4step` that could plausibly cause the defect to fire
  on one but not the other (branching topology, outcome-node density,
  retrieval density, Bayesian posterior separation between `window()`
  and `cohort()` modes);
- consider whether a new synth fixture with branching closer to GM
  rebuild would hit the defect;
- if the defect cannot be reproduced on any synth, that is a gap in the
  fixture library and a blocker on durable regression coverage for this
  class of bug.

### 14.5 GM rebuild defect confirmed still current on 23-Apr-26

The four commands in §6 were re-run verbatim today. Every v3 midpoint
value listed in §8.3 reproduces to four decimal places. `v3 cohort(-1d:)`
at `tau=10` returns `0.5829`, tracking `v3 window(-1d:)` at `0.5882`;
the v3 `cohort - window` separation at `tau=10` is `−0.0053` against a
v2 separation of `−0.5292`. The primary defect has not moved since
doc 65 was written and is still the correct target for a fix.

### 14.6 Invariant violation: v3 does not degenerate to unconditioned model vars

Locally important finding from the `-1d:` unconditioned probe on synth.
With zero post-frontier evidence the v3 invariant should be: "degenerate
naturally to the unconditioned model curve". For the factorised
cohort contract in
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
that means `window()` should render `p × CDF_{X -> Y}(tau)` and
`cohort(A != X)` should render `p × carrier_{A -> X}(tau) *
CDF_residual_{X -> Y}(tau)` — the carrier collapses to identity in
window mode, not in cohort mode. Both should be curves, not flat lines
at `p.mean`.

Today, on `synth-mirror-4step` with the Bayesian sidecar and
`window(-1d:)` / `cohort(-1d:)`, v3 returns exactly **two rows**
(`tau = 0, 1`), both with `midpoint = model_midpoint = 0.7101 = p.mean`
from the Bayesian posterior, `completeness = 0`, and
`_conditioning: {applied: false, skip_reason: n_effective_missing}`.
The two mode responses are byte-identical under the four diagnostic
fields `{midpoint, model_midpoint, completeness, _conditioning}`. This
is against the contract on two counts:

- the unconditioned subject-span `CDF_{X -> Y}(tau)` is not applied, so
  the v3 curve does not rise from 0 toward `p` as latency matures;
- `carrier_{A -> X}(tau)` is not applied, so cohort mode produces the
  same trajectory as window mode even though the synth has strong
  upstream latency (`m4-delegated -> m4-registered`: onset 5.5,
  mu 1.5, sigma 0.57).

The code path responsible is the zero-evidence shortcut inside
`compute_cohort_maturity_rows_v3`. The relevant comment already
acknowledges what is happening:

> "No cohort evidence to condition on. Zero-evidence Beta-Binomial
> update degenerates to the prior — use the closed-form path with
> `fe=None` to produce prior-only rows. Works for any σ because the
> prior is just a Beta distribution regardless of latency."

That comment treats the zero-evidence case as a flat Beta prior over
`p`, but the v3 trajectory is supposed to be `p × CDF_subject(tau)` in
window mode and the factorised product in cohort mode, not `p` alone.
The current call routes through `_non_latency_rows(fe=None, ...)`
regardless of latency flag, which drops both the subject-span kernel
and any carrier distinction.

This is a distinct failure from §8 / §14.5: the primary GM rebuild
defect is on the evidence-present path, where `pre_rows=7, post_rows=3`
for cohort and `pre_rows=7, post_rows=4` for window. The zero-evidence
shortcut documented in §14.6 is a different branch. It is plausible
that both failures share a common pattern — loss of mode distinction
on a v3 codepath that should still respect `carrier_to_x` and
`subject_span` — but they are reached by different routes and must not
be conflated.

### 14.7 Reliance on `asat()` is itself a risk for diagnosis

`-1d:` resolves against wall-clock now
(`graph-editor/src/lib/dateFormat.ts::resolveRelativeDate`, not against
the `asat()` frontier), and synth snapshot data on disk does not reach
today, so `-1d:` probes on synth do not bind rows. Reproducing the
evidence-present GM rebuild behaviour on synth therefore requires an
absolute frontier date plus `asat()`. That introduces a second
diagnostic axis: any `asat()`-related defect on the same path would be
indistinguishable from the primary defect this note tracks.

Options for the next agent:

- refresh the synth data generation window so the most recent
  `retrieved_at` values cover "today", allowing `-1d:` to bind evidence
  directly (preferred if the generator supports it);
- accept the `asat()` path, but first isolate and close any
  `asat()`-specific defects separately so they are not contributing
  noise to the primary investigation.

### 14.8 Synth non-reproducibility of the primary defect is itself a devtooling gap

Even after adding the Bayesian sidecar and using absolute-date frontier
queries on `synth-mirror-4step`, the headline v3 cohort-onto-v3-window
collapse from §8.2–§8.3 does not reproduce. §14.1 shows the two synth
probes produce large, real v3 `cohort - window` separation in both
directions (for example `-0.57` at `tau = 10` with Bayesian vars),
unlike GM rebuild's `-0.005` today.

Given doc 60's guidance that `synth-mirror-4step` is the canonical
primary fixture for multi-hop / mixed-class outside-in work (doc 60 §9
table and §"Rationale for the designated graphs"), the inability to
reproduce a real production-shaped defect on this fixture is itself a
first-class devtooling problem:

- enumerate structural and data-shape differences between GM rebuild
  and `synth-mirror-4step` that could plausibly cause the v3 collapse
  to fire on one but not the other (branching topology, outcome-node
  density, retrieval density, Bayesian posterior separation between
  `window()` and `cohort()` modes, `model_vars` population state);
- consider whether a new or adjusted synth fixture with branching
  closer to GM rebuild would hit the defect; or isolate the v3 branch
  that is firing on GM rebuild so a fixture can be engineered against
  it deliberately;
- if no synth fixture reproduces the evidence-present collapse, treat
  that gap as a blocker on durable regression coverage for this class
  of bug.

The goal stated in §5 of this note — "public CLI tooling should be the
primary oracle for this defect" — is not met until synth reproduces
the evidence-present failure.

### 14.9 Multiple possibly-unrelated defects

Observed on this pick-up. Each should be investigated on its own
terms, not conflated with the primary doc-65 defect:

- **D1 (primary)**: v3 single-hop `cohort()` collapses onto `window()`
  on GM rebuild with post-frontier evidence present. Confirmed current
  today (§14.5). Not yet reproduced on any synth fixture.
- **D2**: v3 does not degenerate to the unconditioned model curve on
  the zero-evidence path; produces a flat `midpoint = p.mean` across
  all tau and drops mode distinction entirely. Located in the
  `fe is None` branch of
  `graph-editor/lib/runner/cohort_forecast_v3.py::compute_cohort_maturity_rows_v3`
  (§14.6). Directly contradicts the "natural degeneracy" invariant
  from doc 60 §8–§9 and the factorised contract in
  `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`.
- **D3**: v3 cohort reads zero then plateaus well below truth on
  `synth-mirror-4step` with the evidence-present `cohort(1-Mar-26:).asat(22-Mar-26)`
  probe even after Bayesian vars are injected (§14.2). May or may not
  share a root cause with D1; must be isolated.
- **Devtooling gap**: no synth fixture has been shown to reproduce D1;
  the current synth library does not cover this class of defect (§14.8).

This list is almost certainly incomplete. Future diagnostic passes
should keep looking for more, not close on the first plausible root.

### 14.10 Reusable artefacts produced on this pick-up

- `bayes/fixtures/synth-mirror-4step.bayes-vars.json` — Bayesian
  posteriors for the four success-line edges of `synth-mirror-4step`.
  Regenerable via
  `PYTHONPATH=. python bayes/test_harness.py --graph synth-mirror-4step
  --enrich --sidecar-out bayes/fixtures/synth-mirror-4step.bayes-vars.json
  --no-webhook`. The terminal edge carries separate `window()` and
  `cohort()` posteriors with materially different latency (`window():
  mu=1.33, sigma=0.19, onset=3.1`; `cohort(): mu=2.40, sigma=0.49,
  onset=11.2`). Reusable by any CLI command that accepts
  `--bayes-vars`.

- `graph-editor/lib/tests/test_v3_degeneracy_invariants.py` — pytest
  suite asserting the v3 semantic contract from
  `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
  by driving `graph-ops/scripts/analyse.sh` as a subprocess. Five
  invariants, nine test methods:
  - I1 — zero-evidence window must rise as a subject-span CDF
  - I2 — zero-evidence cohort must lag window when upstream latency is non-trivial
  - I3 — `A = X` cohort must equal window
  - I4 — window asymptote must equal posterior `p.mean`
  - I5 — cohort must never exceed window at any tau

  Fixtures: `synth-mirror-4step` (primary, with Bayes-vars sidecar
  auto-generated via `@requires_synth(bayesian=True)`) and
  `synth-lat4` (analytic only). Skips cleanly if DB, data repo, or
  Python BE are unavailable.

  **Baseline on 23-Apr-26** (6 pass, 3 fail, 61s):
  - ✗ `TestI1ZeroEvidenceWindowShape::test_m4_terminal_edge` — v3
    returns only 2 rows (both midpoint = 0); no trajectory.
  - ✗ `TestI2ZeroEvidenceCohortLagsWindow::test_m4_terminal_edge` —
    same 2-row output; cannot assess lag.
  - ✗ `TestI2ZeroEvidenceCohortLagsWindow::test_lat4_bc_edge` — v3
    window and cohort produce **byte-identical curves across 22
    taus**; direct demonstration that mode distinction is lost on
    the zero-evidence path.

  A shell-script companion (`graph-ops/scripts/v3-degeneracy-invariants.sh`)
  drives the same invariants outside pytest. The pytest suite is the
  authoritative one for CI; the shell script is a quick ad-hoc runner.
