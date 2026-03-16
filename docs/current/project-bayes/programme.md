# Project Bayes: Programme

**Status**: Draft
**Date**: 16-Mar-26
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

**Context**: `../codebase/APP_ARCHITECTURE.md` (app architecture),
`../project-db/` (snapshot DB)

---

## Structure

Two independent workstreams converge when both are complete.

```
Semantic foundation
  Evaluator unification → Python model ownership → FE stats deletion
                                                                  ↘
                                                                   Bayesian inference → Posterior consumption
                                                                  ↗
Async infrastructure
  Async roundtrip ───────────────────────────────────────────────
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

## Convergence

These depend on both workstreams being complete.

### Bayesian inference

**Depends on**: Semantic foundation complete (Python owns fitting, FE stats
deleted) AND Async infrastructure complete (roundtrip proven).

Real Bayesian inference running on the proven infrastructure, writing real
posteriors to graph/parameter YAML files.

**Scope**:
- Graph-to-hierarchy compiler: canonicalise graph, identify branch groups,
  build probability and latency hierarchies, encode coupling, bind evidence
- PyMC model materialisation from compiler IR
- Inference execution (MCMC sampling via compute vendor)
- Posterior summarisation and quality gates (r-hat, ESS, HDI)
- Artefact persistence: real posterior values replace placeholders in YAML

**Exit criterion**: at least one real graph fitted end-to-end with Bayesian
posteriors committed to git. Quality metrics within acceptable bounds. FE reads
real posterior values after pull.

**Design detail**: Logical blocks (compiler, hierarchy, IR), Reference impl
(PyMC patterns).

### Posterior consumption

**Depends on**: Bayesian inference (real posterior data in YAML files).

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
- **Vendor selection timing**: should compute vendor prototyping happen before
  or after the schema and webhook handler are built? The Async infra doc
  sequences schema first, but vendor DX evaluation could start earlier as a
  spike.
- **Bayesian inference scope**: Logical blocks is comprehensive (full
  hierarchical Dirichlet, slice pooling, latency coupling). Is there a useful
  first slice that fits simpler models (e.g. independent Beta per edge, no
  hierarchy) to prove the pipeline before tackling compiler complexity?
