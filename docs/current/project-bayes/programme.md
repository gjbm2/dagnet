# Project Bayes: Programme

**Status**: Draft
**Date**: 17-Mar-26
**Purpose**: Phased delivery plan for Project Bayes. This doc owns sequencing;
design docs contain the detail.

---

## Design docs

| Short name | File | Scope |
|---|---|---|
| **Logical blocks** | `0-high-level-logical-blocks.md` | Graph-to-hierarchy compiler, model structure, inference pipeline |
| **Model contract** | `1-cohort-completeness-model-contract.md` | Cohort semantics, model ownership, evaluator unification |
| **Reference impl** | `2-reference-implementation-notes.md` | PyMC patterns, prior art review |
| **Compute arch** | `3-compute-and-deployment-architecture.md` | Compute vendor, deployment topology, shared code, DB access |
| **Async infra** | `4-async-roundtrip-infrastructure.md` | Async roundtrip: submission, webhook, git commit, schema |
| **Local dev setup** | `5-local-dev-setup.md` | Local dev environment, tunnel, deployment |
| **Compiler + worker** | `6-compiler-and-worker-pipeline.md` | Compiler IR, model materialisation, worker orchestration, evidence assembly |

**Context**: `../codebase/APP_ARCHITECTURE.md` (app architecture),
`../project-db/` (snapshot DB)

---

## Structure

Three workstreams. Bayesian inference can start as soon as async infrastructure
is done — it reads evidence directly from graph + parameter files + snapshot DB,
all of which are already populated by the existing system. Semantic foundation
improves *consumption* of posteriors but is not a prerequisite for *production*.

```
Semantic foundation
  Evaluator unification → Python model ownership → FE stats deletion
                                                                  ↘
                                                                   Posterior consumption
                                                                  ↗
Bayesian inference (compiler + worker)
  Compiler IR → model materialisation → MCMC → webhook commit
  Depends on: Async infrastructure (webhook + atomic commit)
  Evidence sources: graph topology (inline), param files (git),
                    snapshot DB (PostgreSQL)

Async infrastructure
  Async roundtrip (Steps 1–3 done) → vendor setup → submission → FE integration
```

---

## Semantic foundation (workstream)

Fix cohort completeness semantics, move model ownership to Python, delete FE
fitting code. Statistical/semantic work on the existing codebase. No dependency
on remote compute infrastructure.

### Evaluator unification

Make the existing system internally consistent. Analysis logic and cohort
maturity charts use the same evaluator with the same parameters.

**Scope**:
- BE annotation and BE chart CDF share one parameter resolution helper
- Onset handling fixed for path params (use edge onset, not `0.0`)
- Explicit `query_mode` field on analysis requests
- Provenance metadata in analysis responses

**Not in scope**: moving FE completeness to Python, new fitting infrastructure,
join handling, chains > 2 hops.

**Exit criterion**: for every `cohort_maturity` analysis response,
`completeness_model.mode == model_curve_params.mode` and
`completeness_model.onset_delta_days == model_curve_params.onset_delta_days`.

**Design detail**: Model contract, sections 11 and 14.

### Python model ownership

Move path-model derivation and fitting into Python. FE becomes a pure applier.

**Scope**:
- Python computes A→Y path model from snapshot evidence + X→Y edge models
- Correct onset composition, mixture-based join handling
- Python publishes `(path_mu, path_sigma, path_delta)` and model-source grade
- MVP topology invalidation (stale-marking on write)
- Port tail-constraint logic and `approximateLogNormalSumFit` to Python

**Not in scope**: full Bayes fitting, topology signatures.

**Exit criterion**: FE LAG pass completeness computation removed. All consumers
use BE-published A→Y model with consistent semantics.

**Design detail**: Model contract, sections 11, 14, 21–22.

### FE stats deletion

Delete ~4000+ lines of FE statistical fitting code. Python becomes the sole
fitting owner.

**Scope**:
- Complete parallel-run soak, confirm parity
- Disable FE topo/LAG fitting pass
- Delete FE fitting codepaths: `statisticalEnhancementService.ts`,
  `lagDistributionUtils.ts`, `forecastingParityService.ts`, and related modules
- Update or remove associated test files

**Not in scope**: changing the BE fitting implementation.

**Exit criterion**: no FE code path calls `fitLagDistribution`,
`computeEdgeLatencyStats`, `approximateLogNormalSumFit`, or any other fitting
function. Build and lint confirm zero references.

**Design detail**: Model contract, section 14.3. Detailed plan in
`../project-db/analysis-forecasting-implementation-plan.md`.

---

## Async infrastructure (workstream)

Build the plumbing for submitting jobs to a remote compute vendor, receiving
results via webhook, and committing them to git. Integration/DevOps work. No
dependency on cohort semantics or model ownership.

### Async roundtrip

A working end-to-end roundtrip — FE submission → remote worker execution →
webhook → atomic git commit → FE pull — with correct posterior schema fields
but placeholder values.

**Steps**:
1. ~~Schema additions~~: `posterior` sub-objects on `ProbabilityParam` and
   `LatencyConfig` in TS types, Python Pydantic models, YAML schemas.
   **Done 16-Mar-26.**
2. ~~Isomorphic verification gate~~: confirm UpdateManager extracted modules
   are platform-agnostic. **Done 16-Mar-26.**
3. ~~Webhook handler~~: `/api/bayes-webhook.ts` with atomic multi-file commit
   via Git Data API (`api/_lib/git-commit.ts`). Writes posteriors to param
   files + `_bayes` metadata to graph. No cascade — scalar derivation
   deferred to FE post-pull (see §23 in doc 1). **Done 16-Mar-26.**
4. Compute vendor setup: Modal, DB connectivity, webhook delivery
5. Submission route: `/api/bayes/fit`, FE trigger
6. FE integration: job tracking, session log

**Exit criteria**:
- FE can submit and receive a job_id
- Worker executes, connects to DB, fires webhook
- Webhook commits atomically with correct posterior fields
- FE reads back posterior fields after pull
- Existing graphs without posteriors continue to load
- Idempotency holds (duplicate webhook = no duplicate commit)

**Not required**: real inference, FE display of posterior data, real-time
progress, nightly scheduling.

**Design detail**: Async infra (implementation), Compute arch (rationale).

---

## Bayesian inference (workstream)

**Depends on**: Async infrastructure Steps 1–3 (webhook + atomic commit).
Does NOT depend on Semantic foundation.

**Why no Semantic foundation dependency**: The compiler reads evidence directly
from three sources that already exist and are already populated:

1. **Graph topology** — sent inline by FE (same as existing
   `/api/runner/analyze` pattern)
2. **Parameter files** — sent inline by FE in the submit request. Richer than
   graph edges: daily arrays (n_daily, k_daily, dates), multiple values[]
   windows, per-slice latency histograms, cohort bounds, onset data.
3. **Snapshot DB** — queried via PostgreSQL (same as existing analysis runners).
   Time-series evidence rows with full granularity.

The compiler produces posteriors. It doesn't need the FE fitting code deleted
or the evaluator unified — those concern *consumption*, not *production*.

### Compiler + worker pipeline

**Scope**:
- Graph-to-hierarchy compiler: canonicalise graph, identify branch groups,
  build probability and latency hierarchies, encode coupling, bind evidence
- Evidence assembly from parameter files (git) and snapshot DB
- PyMC model materialisation from compiler IR
- Inference execution (MCMC sampling via compute vendor)
- Posterior summarisation and quality gates (r-hat, ESS, HDI)
- Webhook callback with posterior payload → atomic git commit

**Phased delivery** (see `6-compiler-and-worker-pipeline.md`):
- Phase A: independent Beta per edge (no hierarchy, no Dirichlet, no slice
  pooling). Proves full pipeline end-to-end with real posteriors.
- Phase B: Dirichlet branch groups (sibling coupling at branching nodes).
- Phase C: slice pooling + hierarchical Dirichlet.
- Phase D: probability–latency coupling through completeness.
- Phase E (optional): per-chain fan-out across workers. The serialisable IR
  boundary enables a compile-once, sample-many pattern — dispatch N workers
  each running `build_model` → `pm.sample` independently, merge traces via
  `az.concat`. Not required for initial delivery: PyMC parallelises chains
  across cores on a single machine, and wall-clock time is not a binding
  constraint.

**Exit criterion (Phase A)**: at least one real graph fitted end-to-end with
independent Beta posteriors committed to git. Quality metrics within acceptable
bounds. FE reads real posterior values after pull.

**Exit criterion (Phase D)**: full hierarchical model with joint
probability–latency coupling, per-slice Dirichlet, and completeness-adjusted
likelihoods.

**Design detail**: Logical blocks (compiler, hierarchy, IR), Reference impl
(PyMC patterns), Compiler + worker (implementation).

---

## Posterior consumption

**Depends on**: Bayesian inference Phase A (real posterior data in YAML files).
Benefits from Semantic foundation (cleaner FE derivation) but can start without
it.

The FE uses posterior distributions for richer analysis and display.

**Scope** (not yet designed in detail):
- Confidence bands on graph edges from Beta posterior quantiles (replacing
  current standard-error approximation)
- Fan charts in cohort analysis consuming posterior interval data
- Posterior-powered queries ("is this conversion rate within the 90% HDI?")
- Nightly scheduling (cron trigger for automated fits)

**Design detail**: to be written when Bayesian inference is near completion.

---

## Open questions (programme-level)

- **Parallelism within Semantic foundation**: can Python model ownership start
  before Evaluator unification is fully complete? The Model contract implies
  sequential but the codepaths may be separable.
- ~~**Evidence assembly strategy**~~: **Resolved.** FE sends parameter file
  contents in the submit request (long-established pattern). Worker receives
  graph + param files + snapshot DB coordinates in a single payload.
- ~~**Bayesian inference scope**~~: **Resolved 17-Mar-26.** Phased delivery
  starting with independent Beta (Phase A) before hierarchical Dirichlet
  (Phases B–D). See `6-compiler-and-worker-pipeline.md`.
- ~~**Vendor selection timing**~~: no longer blocked — async infra Steps 1–3
  are done, vendor setup can proceed immediately.
- ~~**Bayesian inference dependency on Semantic foundation**~~: **Resolved
  17-Mar-26.** No hard dependency. Compiler reads evidence from graph + param
  files + snapshot DB, all already populated. Semantic foundation improves
  consumption, not production.
