# Project Bayes: Compute and Deployment Architecture

**Status**: Draft
**Date**: 14-Mar-26
**Purpose**: Document the compute provider decision and deployment topology for
nightly Bayesian inference, and its relationship to the existing Python backend.

**Related**: `programme.md` (programme),
`4-async-roundtrip-infrastructure.md` (Async infra),
`0-high-level-logical-blocks.md` (Logical blocks), `../project-db/` (snapshot DB),
`../codebase/APP_ARCHITECTURE.md` (app architecture)

---

## 1. Two distinct workloads

The Python backend serves two fundamentally different workload profiles after
Project Bayes ships:

### Existing API backend (Vercel)

- Short-lived request/response (query parsing, MSMDC generation, analysis
  runner, snapshot CRUD, stats enhancement, lag model fitting)
- I/O-bound (PostgreSQL queries, JSON serialisation)
- Scales horizontally via serverless; cold starts managed by Fluid Compute
- ~20 endpoints, stable, working today

### MCMC inference (new)

- Long-running, CPU-bound (MCMC sampling with NUTS/HMC)
- Memory-intensive (large posterior traces, hierarchical models with many
  latent variables)
- Runtime measured in minutes to hours per graph, not milliseconds
- Nightly batch cadence, job-queue pattern (submit -> sample -> persist)

---

## 2. Why Vercel cannot host MCMC inference

| Resource | Vercel Pro | MCMC need |
|---|---|---|
| Max execution duration | 800s | Minutes to hours |
| Memory | 2-4 GB | 8-32+ GB |
| CPU | 1-2 vCPU | 4-16 cores (parallel chains) |
| Python bundle size | 500 MB | PyMC + PyTensor + SciPy pushes this |
| Background jobs | Not supported | Essential |
| GPU | None | Useful for JAX/NumPyro |

The 800s hard limit is the dealbreaker. Complex models with many edges, slices,
and the probability-latency coupling (Logical blocks, step 5) can exceed this
comfortably. A hard timeout mid-sampling wastes all compute and produces no
usable output.

Google Cloud Run (60-min cap) and AWS Lambda (15-min cap) carry the same risk
at different thresholds. For a workload where "runtime budget is generous (hours
available overnight, compute is cheap)" (Logical blocks, first practical implementation
slice), a hard ceiling of any kind is an unnecessary constraint.

---

## 3. Compute provider requirements

Must-have:

- **No hard time limit** on job execution
- **Python runtime** with full native library support (PyMC, PyTensor, SciPy,
  NumPy, ArviZ)
- **Configurable memory** (8-32+ GB per job)
- **Multi-core CPU** (4+ cores for parallel MCMC chains)
- **Network access** to Neon PostgreSQL (snapshot DB)
- **Job-queue semantics** (submit, poll/webhook for completion)
- **Pay-per-use** or auto-stop when idle (nightly batch, not always-on)

Nice-to-have:

- GPU support (enables JAX/NumPyro backend for faster sampling)
- Warm-start friendly (fast spin-up, persistent container images)
- Native Python DX (decorator-based, no Dockerfile required)

### Candidates evaluated

| Option | Time limit | Memory | CPU | GPU | Pay model | Notes |
|---|---|---|---|---|---|---|
| **Modal** | None | Up to 256 GB | Up to 64 vCPU | Yes (A100, H100) | Per-second | Built for scientific Python compute. Best DX. |
| **Fly.io Machines** | None | Up to 64 GB | Up to 16 vCPU | Limited | Per-second | Long-running containers, auto-stop. |
| **Railway** | None | Up to 32 GB | Up to 32 vCPU | No | Per-minute | Simple container deploy, background workers. |
| **Render Workers** | None | Up to 512 GB | Up to 64 vCPU | No | Always-on or job | Dedicated background worker type. |
| **Dedicated VM** | None | Configurable | Full | Varies | Hourly | Cheapest sustained CPU, most ops burden. |

**Leading candidate: Modal.** Native Python, no Dockerfiles, designed for
exactly this class of workload. Decision not yet final — requires hands-on
prototyping with a real PyMC model.

---

## 4. Deployment topology: split, not consolidated

**Decision**: keep the existing Python API on Vercel; deploy MCMC inference to
a separate compute provider. Do not migrate the existing backend.

### Why split

- **Zero migration risk** for 20+ working API endpoints.
- **Independent scaling**: API routes stay cheap/serverless; MCMC scales to
  beefy machines only when needed.
- **Independent lifecycles**: API routes change frequently; MCMC models change
  rarely. Decoupled deployment avoids coupling release cadences.
- **Cost-optimised**: Vercel is cheap for I/O-bound API routes. Compute vendor
  is pay-per-second for heavy CPU. Each platform handles what it's good at.
- **Cold starts irrelevant for MCMC**: the job-queue model already tolerates
  seconds of spin-up against minutes of sampling.

### Why not consolidate

- Moving the existing BE to a compute platform (e.g. Modal) would mean paying
  compute-platform pricing for lightweight I/O-bound API routes — overpaying
  for the wrong abstraction.
- Vercel's edge network, Fluid Compute, and zero-config deployment are genuine
  advantages for the API workload that would be lost.
- The shared-code concern is solved without consolidation (see section 5).

---

## 5. Shared code: one library, two deployment targets

The MCMC service needs access to the same data layer as the existing API:
snapshot queries, graph types, query DSL parsing. This does NOT require
duplicate implementations.

The `graph-editor/lib/` directory is already cleanly separated from the Vercel
entry point (`api/python-api.py`). Key shared modules:

- `snapshot_service.py` — PostgreSQL access (read evidence, write artefacts)
- `graph_types.py` — Pydantic models (Graph, Edge, Node, Evidence, etc.)
- `query_dsl.py` — DSL parsing
- `slice_key_normalisation.py` — canonical slice keys for DB matching
- `file_evidence_supplement.py` — uncovered-day file-evidence supplement used
  by both the API handlers and the Bayes compiler

**Approach**: the MCMC worker is a new entry point that imports from the same
`lib/`. The repo already has this pattern — `api/python-api.py` (Vercel) and
`dev-server.py` (local FastAPI) are two entry points sharing one library.

```
graph-editor/
  api/python-api.py          ← Vercel entry point
  dev-server.py              ← Local dev entry point
  lib/
    graph_types.py           ← shared
    snapshot_service.py      ← shared
    query_dsl.py             ← shared
    file_evidence_supplement.py ← shared
    runner/                  ← shared analysis runner code

bayes/
  app.py                     ← Modal image + deployment wiring
  worker.py                  ← MCMC worker entry point
  compiler/                  ← Bayes-only compiler, model builder, inference
```

No package extraction needed initially. Modal copies `graph-editor/lib/` into
the worker image and adds it to `PYTHONPATH`, so the worker imports the same
shared modules directly. If a future deployment target requires a separate
build context, the shared `lib/` can still be pip-installed from a local path
or published as an internal package later. Start simple.

---

## 6. DB access pattern

Both services connect to the same Neon PostgreSQL instance via
`DB_CONNECTION`. The DB exists for one purpose: time-series evidence that needs SQL
aggregation (multi-day ΔY, cohort histograms, signature lookup). Everything
else in the app is git/YAML files — that's the architecture, not a policy
choice. The MCMC worker reads evidence from the DB; results flow to
git/YAML via the webhook (section 8), same as every other output in the
system.

### MCMC worker's DB interactions

| Pipeline block | DB operation | Direction |
|---|---|---|
| Block 2 (subject discovery) | Query snapshot inventory: which `(param_id, core_hash, slice_key)` tuples exist, row counts, anchor day coverage | Read |
| Block 3 (compiler) | Evidence inventory shapes hierarchy: which slices exist, signal sufficiency per edge, fallback decisions | Read (via Block 2 output) |
| Block 4 (inference) | Fetch actual snapshot rows as observed data for likelihoods | Read |

All reads go through `snapshot_service.py` functions that already exist.
Block 6 (persistence) writes posterior summaries to git/YAML via the
webhook result flow — not to the DB.

### Why fat-payload doesn't work

The alternative to DB access would be serialising all inputs at job submission
time. This fails because:

- The compiler (Block 3) needs to interrogate evidence inventory to decide
  model structure (which slices to pool, which edges to fall back). This is
  a DB-dependent decision, not a static input.
- Evidence volume per graph can be substantial: many edges x many slices x
  many anchor days x multiple retrieval timestamps.

The MCMC worker needs a direct DB connection. This is standard — just a
connection string in an environment variable, same as the existing API.

---

## 7. Nightly orchestration sketch

```
Cron trigger (compute vendor scheduler or external)
  │
  ├─ Connect to Neon PostgreSQL
  ├─ Discover graphs configured for daily retrieval
  │
  ├─ For each graph (parallelisable):
  │   ├─ Block 2: Query evidence inventory from snapshots table
  │   ├─ Block 3: Compile graph + evidence → Hierarchy IR
  │   ├─ Block 3.5: Validate IR, apply fallbacks for thin-signal groups
  │   ├─ Block 4: Materialise PyMC model from IR, bind evidence, sample
  │   ├─ Block 5: Summarise posteriors, run quality gates (r-hat, ESS)
  │   └─ Block 6: Fire webhook with posterior payload → Vercel → git commit
  │
  └─ Emit run summary via commit message (graphs fitted, failures, quality)
```

The FE picks up results via its existing git pull path. No new API
endpoints needed for serving artefacts — they're in the YAML files.

---

## 8. Job completion and result flow

### How the existing app works (context for this section)

All orchestration today is **browser-side and Promise-driven**. The FE is
the orchestrator — it triggers data fetches, awaits results, and writes them
into files/IDB/GraphStore directly. There is no server-side job queue. Progress
is reported via callbacks (`onProgress?: (p) => void`), not polling.

The post-fetch write path is:
```
API result → mergeTimeSeriesIntoParameter() → IDB → FileRegistry → GraphStore
```

When the user pulls from git, the same IDB → FileRegistry → GraphStore sync
runs.

`gitService.ts` already wraps the GitHub Contents API with full CRUD:
`createOrUpdateFile()`, `getFile()`, `deleteFile()`, etc. This runs
browser-side today, but the same Octokit operations work server-side in a
Vercel TS route.

MCMC inference is the first case where the app must delegate a long-running
computation to a remote service and receive results asynchronously. This is
a new pattern with no existing precedent in the codebase.

### The two concerns

1. **Completion + result persistence**: how do MCMC results land in the repo
   so the FE can consume them? (Architecturally load-bearing.)
2. **Progress during execution**: how does the FE show intermediate status
   for on-demand runs? (UX polish — can be layered on later.)

This section addresses concern 1. Concern 2 is discussed at the end.

### Leading approach: webhook → Vercel TS route → git commit

**Feasibility validated.** The project already deploys mixed-runtime API
routes: `api/python-api.py` alongside `api/auth-callback.ts`,
`api/auth-status.ts`, `api/das-proxy.ts`, `api/graph.ts`, and
`api/init-credentials.ts`. Vercel auto-detects runtime by file extension —
a new `api/bayes-webhook.ts` slots in with zero configuration.

Key feasibility points confirmed:

- **Octokit already a dependency** (`@octokit/rest` v22.0.0,
  `@octokit/plugin-throttling` v11.0.2). Used today for branch/ref
  operations in `gitService.ts`.
- **GitHub Contents API** (`repos.createOrUpdateFileContents`) is the
  right call for committing file updates server-side. ~10 lines of code.
  Requires the current file SHA (fetched via `repos.getContent` first).
- **Execution time**: parsing JSON + GitHub API call is comfortably under
  60s. Pro plan with Fluid Compute allows up to 800s.
- **Payload size**: 4.5 MB limit per request. Posterior summaries will be
  a few KB to a few hundred KB. Not a concern.
- **`gitService.ts` is browser-only** (`btoa()`, `window`, `CustomEvent`).
  The webhook route cannot import it directly. But it doesn't need to —
  it only needs Octokit's `createOrUpdateFileContents`, which is a
  standalone server-side call using `Buffer.from().toString('base64')`
  instead of `btoa()`.
- **Auth precedent**: `api/auth-callback.ts` already exchanges OAuth tokens
  server-side and calls the GitHub API. The webhook route follows the same
  pattern, using `process.env.GITHUB_TOKEN` (or a dedicated service
  account token).

**One gap: webhook reliability.** Vercel has no built-in retry semantics.
If the handler returns 500, the compute vendor gets a 500 — no automatic
retry, no dead-letter queue. Mitigations:
- Handler must be **idempotent** (deduplicate on `run_id`).
- Compute vendor choice should factor in webhook retry support (most mature
  vendors retry with exponential backoff).
- Optionally, a webhook gateway (e.g. Hookdeck) can add reliability without
  changing the handler code.

---

The MCMC worker finishes and fires a **webhook** to a Vercel endpoint. The
Vercel endpoint (a TypeScript API route) receives the posterior payload,
formats it into YAML file updates, and commits them to the repo via the
GitHub Contents API.

```
Compute vendor                 Vercel TS route                    GitHub
    │                               │                               │
    ├─ MCMC complete ──────────────>│                               │
    │  POST /api/bayes/webhook      │                               │
    │  {posteriors, quality,        │                               │
    │   provenance, fingerprint}    │                               │
    │                               ├─ format into YAML updates     │
    │                               ├─ commit to repo ─────────────>│
    │                               │  (Octokit server-side)        │
    │                               │                               │
    │                               ├─ return 200 to compute vendor │
```

The FE then picks up changes via its existing pull path:
```
git pull → file changes → IDB update → FileRegistry → GraphStore → UI
```

**Why this fits the existing architecture:**

- **Git is already the persistence layer.** Parameter files live in the repo.
  Posterior updates are just parameter file updates — same data, better
  estimates. Committing them to git is the natural home.
- **The FE's pull path already handles external file changes.** Whether a
  human edited a file or a Vercel webhook committed it, the pull → sync
  path is the same.
- **The webhook is a proper callback.** The compute vendor fires it on
  completion; the Vercel route handles it in a single request/response
  (well within 800s — it's just formatting + a git API call). No polling,
  no long-held connections.
- **The DB stays a pure evidence store.** The MCMC pipeline reads evidence
  from the snapshot DB and writes results to git — the same directional
  flow as every other analysis path.
- **Nightly runs work with zero FE involvement.** The webhook fires, the
  commit lands. When the user opens the app, they pull and see updated
  posteriors. Audit trail is git history.

### Use cases

| Scenario | How results arrive | FE involvement |
|---|---|---|
| **Nightly batch** | Webhook → Vercel commits to git. Commit message carries run summary. | None during execution. User pulls on next session. |
| **On-demand fit** | Same webhook path. FE initiated the job, so it knows to check for completion. | FE triggers, then watches for the commit. Pulls when ready. |
| **Failure** | Webhook fires with error payload. Vercel commits no files but can log to compute vendor. | FE detects no new commit. Retry next night or on-demand. |

### What the Vercel TS webhook route does

1. **Authenticate** the webhook (shared secret or signed payload from compute
   vendor).
2. **Validate** the result payload (posteriors, quality gates, provenance).
3. **Format** posterior summaries into parameter YAML updates. For each edge:
   update `p.mean`, `p.stdev`, `p.distribution`, posterior summary fields,
   provenance flag (`bayesian` / `pooled-fallback` / `point-estimate`).
4. **Commit** updated files to the repo via GitHub Contents API. Use a
   dedicated commit message format that carries the run summary (e.g.
   `[bayes] Nightly fit: 14 edges, r-hat 1.02, fingerprint abc123`).
5. **Return 200** to the compute vendor.

This route is TypeScript (not Python) because git operations are already
handled in TS (`gitService.ts` patterns) and the webhook is pure
formatting + API calls — no statistical computation.

The commit message is the run-level audit record. Per-edge quality
metrics (`rhat`, `ess`, `provenance`, `fitted_at`) live in the YAML files
themselves. Git history provides the time-series of fits. No DB table
needed.

### Job submission flow

The FE triggers a fit via the existing Vercel API surface (same pattern as
all other API calls):

```
FE                         Vercel (Python or TS route)       Compute vendor
│                               │                               │
├─ POST /api/bayes/fit ────────>│                               │
│  {graph_id, workspace_id,     ├─ submit job ────────────────>│
│   graph_snapshot, policy}     │                               │
│                               │<── job_id ───────────────────┤
│<── {job_id} ─────────────────┤                               │
│                               │                               │
│  (FE records job_id locally)  │                               │
```

The FE stays on a single API surface. The compute vendor is an
implementation detail behind Vercel.

### Open questions on result flow

All items from the original list have been resolved or built:

- ~~**Conflict with dirty files**~~. **Accepted as known limitation.**
  Webhook commits directly to target branch; user resolves conflicts
  via existing merge flow. Revisit if problematic.
- ~~**Commit granularity**~~. **Built.** Per-batch atomic commit (all
  files in one commit) via Git Data API. See `api/_lib/git-commit.ts`.
- ~~**Which files get updated**~~. **Resolved in doc 4.** Full field
  mapping defined in the posterior schema.
- ~~**Webhook authentication**~~. **Built.** AES-256-GCM encrypted
  callback token with PBKDF2 key derivation, 60-min expiry. See
  `api/bayes-webhook.ts`.
- ~~**Graph snapshot at submission time**~~. **Built.** FE sends full
  graph + param files inline in submit payload. See
  `hooks/useBayesTrigger.ts`.

### Progress during on-demand runs (secondary concern)

For on-demand fits, the FE may want to show intermediate progress
(compilation done, sampling chain 2/4, 60% complete, no divergences).

The MCMC pipeline has natural milestones:

- **Evidence assembly** (seconds): N edges queried, M slices found
- **Compilation** (seconds): L latent variables, G groups, F fallbacks
- **Sampling** (minutes–hours): chain progress, iteration count, divergences
- **Post-processing** (seconds): r-hat, ESS, HDI extraction

This is a secondary concern because:
1. Nightly runs don't need it (no FE listening).
2. The completion path works regardless of progress visibility.
3. It can be layered on without changing the result flow.

Possible approaches (not yet decided):

- **Compute vendor's native job status API, proxied through Vercel.** FE
  polls `/api/bayes/status?job=X`, Vercel checks the compute vendor's API.
  No DB involvement for transient state. Simple, but is polling.
- **Lightweight real-time channel** (Ably, Pusher). Worker fires progress
  webhooks to Vercel; Vercel publishes to a channel; FE subscribes. True
  push, small dependency (~$0/month at this scale). Can be added later
  without architectural changes.
- **Defer entirely.** Show "fit running..." until the webhook lands. Accept
  that on-demand fits take minutes and a spinner is fine. Revisit if users
  find it insufficient.

The right answer depends on how often on-demand fits happen in practice and
how long they typically take. If most fits are nightly and on-demand is rare,
deferral is pragmatic. If on-demand becomes the primary mode, real-time
progress becomes important.

### Session log integration

The existing `sessionLogService` pattern (used for git ops, file ops, data
ops) should be extended to cover Bayes runs. When the FE detects a completed
run (via pull or status check), it should log a session entry:

```
sessionLogService.success('bayes', 'BAYES_FIT_COMPLETE',
  `Fitted ${edgesFitted} edges for ${graphId}`, summary, metadata);
```

This gives the user a unified activity log regardless of whether the
operation ran locally (git, file ops) or remotely (MCMC).

---

## 9. Open questions

### Resolved by research

- **Can Vercel host a TS webhook route alongside the Python API?** Yes.
  The project already has 5+ TS routes alongside `python-api.py`. Vercel
  auto-detects runtime by file extension. No configuration needed.
- **Is Octokit available for server-side git commits?** Yes. Already a
  dependency (`@octokit/rest` v22.0.0). `repos.createOrUpdateFileContents`
  is the right call. Server-side uses `Buffer` instead of `btoa()`.
- **Execution time for the webhook handler?** Comfortably under limits.
  Parse JSON + GitHub API commit is seconds, not minutes. Pro plan allows
  up to 800s with Fluid Compute.

### Resolved

- ~~Vendor selection~~: **Modal.** Worker in `bayes/app.py`.
- ~~Shared package evolution~~: Modal's `@app.function` uploads local
  code; no separate pip package needed.
- ~~Webhook authentication~~: **Built.** AES-256-GCM encrypted callback
  token. See `api/bayes-webhook.ts`.
- ~~Service account token~~: **Not needed.** User's git token encrypted
  in the callback token.
- ~~Artefact schema~~: **Resolved in doc 4.**
- ~~Conflict with dirty files~~: **Accepted as known limitation.** User
  resolves via existing merge flow.
- ~~Multi-file commit atomicity~~: **Built.** Git Data API. See
  `api/_lib/git-commit.ts`.
- ~~Commit granularity~~: **Built.** Per-batch atomic commit.
- ~~Graph snapshot at submission~~: **Built.** FE sends inline. See
  `hooks/useBayesTrigger.ts`.
- ~~Which files get updated~~: **Resolved in doc 4.** Full field mapping.
- ~~Warm-start storage~~: **Parameter file YAML.** Previous posterior's
  `(alpha, beta)` with ESS cap. See doc 8 Phase A.
