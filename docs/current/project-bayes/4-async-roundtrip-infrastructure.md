# Project Bayes: Async Roundtrip Infrastructure

**Status**: Draft
**Date**: 16-Mar-26
**Purpose**: Define the infrastructure for asynchronous remote compute — a working
roundtrip from FE submission through compute vendor execution to git-committed
results — with the correct schema in place but no dependency on Bayesian
inference logic.

**Related**: `programme.md` (programme),
`3-compute-and-deployment-architecture.md` (Compute arch),
`../codebase/APP_ARCHITECTURE.md` (app architecture)

---

## Context

Project Bayes has two independent workstreams (see `programme.md`):

- **Semantic foundation**: fix cohort semantics, move model ownership to
  Python, delete FE fitting code. No dependency on remote compute.
- **Async infrastructure** (this doc): submission, webhook, git commit
  plumbing. No dependency on cohort semantics or model ownership.

The two workstreams share no code, no systems, and no sequencing constraints.
When both are done, Bayesian inference plugs real logic into the infrastructure
built here.

This document is self-contained and can be started, implemented, and verified
without reference to the Semantic foundation workstream.

---

## Why this matters

The async roundtrip is the only genuinely new architectural pattern in the app.
Everything today is synchronous request/response (FE → Vercel → response → FE
writes to IDB/git). Remote compute introduces: submit a job, wait, receive
results asynchronously via webhook, commit to git, pull into FE.

Getting a trivial payload through this full circuit proves the infrastructure
works — vendor integration, webhook auth, atomic git commits, FE job tracking,
conflict handling. Once proven, the inference logic has a known-good deployment
target with no infrastructure debugging mixed in.

The schema additions belong here (not deferred to inference work) because:

- The webhook handler needs to know the target YAML field shape to format
  commits.
- The FE needs to be able to read back what was written (even if it doesn't
  yet consume it for display).
- Validation and verification require real schema fields, not ad-hoc JSON
  blobs.

---

## What the roundtrip proves

End state: the user can trigger a fit from the FE. A remote worker runs, reads
from the snapshot DB, and fires a webhook. The webhook handler formats the
result into YAML updates and commits them to the repo. The FE pulls and sees
updated posterior fields on edges. The values are placeholder (e.g. uniform
priors, dummy quality metrics), but the full data path works.

```
FE                     Vercel                    Compute vendor         GitHub
│                       │                          │                     │
├─ POST /api/bayes/fit─>│                          │                     │
│  {graph_id, ...}      ├─ submit job ────────────>│                     │
│                       │                          │                     │
│<── {job_id} ─────────┤                          │                     │
│                       │                          ├─ connect to DB      │
│                       │                          ├─ read evidence      │
│                       │                          ├─ compute (trivial)  │
│                       │                          │                     │
│                       │<── webhook ──────────────┤                     │
│                       │  {posteriors, quality}   │                     │
│                       ├─ format YAML updates      │                     │
│                       ├─ atomic commit ──────────────────────────────>│
│                       │                          │                     │
│  (next pull)          │                          │                     │
├─ git pull ───────────────────────────────────────────────────────────>│
│<── updated files ────────────────────────────────────────────────────┤
│                       │                          │                     │
├─ IDB → FileRegistry → GraphStore → UI           │                     │
```

---

## Schema additions

### Design principles

- **Posterior fields sit alongside existing point estimates, not replacing
  them.** `p.mean` and `p.stdev` continue to carry the current best estimate
  (whether moment-based or Bayesian). The `posterior` sub-object carries the
  distributional detail and quality metadata.
- **Provenance is explicit.** A `provenance` field on the posterior
  distinguishes `bayesian`, `pooled-fallback`, `point-estimate`, and `skipped`.
  Consumption code can branch on this.
- **Git history is the time-series.** Each nightly fit overwrites current
  posterior values. Git commits provide the historical record. No need to
  store successive fits in the same YAML.
- **Schema changes are additive.** All new fields are optional. Existing
  graphs without posteriors continue to work unchanged.

### Probability posterior (`p.posterior`)

Added to `ProbabilityParam`:

| Field | Type | Description |
|---|---|---|
| `alpha` | number | Beta posterior shape parameter α |
| `beta` | number | Beta posterior shape parameter β |
| `hdi_lower` | number | Lower bound of HDI (at configured level) |
| `hdi_upper` | number | Upper bound of HDI |
| `hdi_level` | number | HDI level used (e.g. 0.9 for 90%) |
| `ess` | number | Effective sample size |
| `rhat` | number | Gelman-Rubin convergence diagnostic |
| `fitted_at` | string | UK date (d-MMM-yy) when posterior was computed |
| `fingerprint` | string | Deterministic hash of (graph structure + policy + evidence window) |
| `provenance` | string | `bayesian` / `pooled-fallback` / `point-estimate` / `skipped` |

When a Bayesian posterior is written, `p.mean` and `p.stdev` are updated to
the posterior mean and standard deviation of the Beta(α, β) distribution:
- `p.mean = α / (α + β)`
- `p.stdev = sqrt(αβ / ((α+β)²(α+β+1)))`

This means **zero changes to existing consumption code**. Everything that reads
`p.mean` and `p.stdev` today — confidence intervals, graph rendering, path
calculations — continues to work, now with better estimates.

### Latency posterior (`p.latency.posterior`)

Added to `LatencyConfig`:

| Field | Type | Description |
|---|---|---|
| `mu_mean` | number | Posterior mean of lognormal μ |
| `mu_sd` | number | Posterior SD of lognormal μ |
| `sigma_mean` | number | Posterior mean of lognormal σ |
| `sigma_sd` | number | Posterior SD of lognormal σ |
| `hdi_t95_lower` | number | Lower HDI bound for t95 (days) |
| `hdi_t95_upper` | number | Upper HDI bound for t95 (days) |
| `hdi_level` | number | HDI level used |
| `ess` | number | Effective sample size |
| `rhat` | number | Convergence diagnostic |
| `fitted_at` | string | UK date (d-MMM-yy) |
| `fingerprint` | string | Same fingerprint as probability posterior |
| `provenance` | string | Same enum as probability posterior |

When a latency posterior is written, `p.latency.mu` and `p.latency.sigma` are
updated to the posterior means. Again, zero consumption-path changes — existing
completeness calculations and t95 derivations use `mu`/`sigma` directly.

### Where schema changes are needed

All additions are optional fields on existing interfaces/models:

| Layer | File | Change |
|---|---|---|
| **TypeScript types** | `src/types/index.ts` | Add `posterior?: ProbabilityPosterior` to `ProbabilityParam`; add `posterior?: LatencyPosterior` to `LatencyConfig` |
| **Python Pydantic** | `lib/graph_types.py` | Add `ProbabilityPosterior` and `LatencyPosterior` models; add optional `posterior` field to existing models |
| **YAML schema** | `public/param-schemas/parameter-schema.yaml` | Add `posterior` object under `p` and under `latency` with the fields above |
| **Graph YAML schema** | (if separate from parameter schema) | Same additions |

### What the roundtrip skeleton writes

The skeleton worker doesn't run inference. It writes placeholder posteriors
that exercise the full schema:

- **Probability**: `alpha=1, beta=1` (uniform prior), `provenance='point-estimate'`,
  `ess=0, rhat=NaN`, `fitted_at` = today, `fingerprint` = hash of graph
  snapshot.
- **Latency**: mirror current `mu`/`sigma` values as `mu_mean`/`sigma_mean`
  with `mu_sd=0, sigma_sd=0`, same quality placeholders.
- **p.mean / p.stdev**: left unchanged (placeholder posterior doesn't update
  point estimates).

This is enough to verify: webhook formats correctly, YAML round-trips, FE
reads the fields back, git diff shows expected changes.

---

## Infrastructure components

### 1. Vercel submission route (`/api/bayes/fit`)

Accepts a fit request from the FE and submits a job to the compute vendor.

**Input**: `{ graph_id, repo, branch, graph_snapshot, parameters_index }`.
**Output**: `{ job_id }`.

The route:
1. Validates the request.
2. Submits a job to the compute vendor (Modal function call or equivalent),
   passing the graph snapshot and parameters index in the job payload.
3. Returns `job_id` to the FE immediately.

The FE records `job_id` locally (IDB or in-memory) for status tracking.

The graph snapshot is the full graph YAML at the moment of submission —
frozen at submission time. See "Graph discovery" below for rationale.

### 2. Compute vendor worker (`bayes/worker.py`)

The worker entry point. For this workstream, the logic is trivial:

1. Connect to Neon PostgreSQL.
2. Read evidence inventory for the submitted graph (proves DB access works).
3. Build placeholder posterior payload (proves schema formatting works).
4. Fire webhook to `/api/bayes-webhook` with the payload.

Once the infrastructure is proven, the inference work (see Logical blocks,
blocks 2–5) replaces step 3 with the actual compiler + model + sampler
pipeline.

### 3. Webhook handler (`/api/bayes-webhook.ts`)

Receives posterior results and commits them to the repo.

**Key design decisions:**

**Atomic multi-file commit.** A single fit updates multiple parameter files
(one per edge). The GitHub Contents API (`createOrUpdateFileContents`) commits
one file at a time — 14 edges = 14 commits. Instead, use the Git Data API:
1. `git.getRef` — get current branch HEAD SHA.
2. `git.getCommit` — get the tree SHA.
3. For each file: `git.createBlob` with updated YAML content.
4. `git.createTree` — new tree with all updated blobs.
5. `git.createCommit` — single commit referencing the new tree.
6. `git.updateRef` — advance the branch.

This produces one clean commit per fit, regardless of how many files changed.

**Idempotency.** The handler deduplicates on `(job_id, fingerprint)`. If the
same webhook fires twice (vendor retry), the second call is a no-op. Check:
does a commit with this fingerprint already exist? (Search recent commit
messages, or maintain a short-lived in-memory/KV dedup window.)

**Webhook authentication.** Shared secret in a header, verified against
`process.env.BAYES_WEBHOOK_SECRET`. Compute vendor includes the secret in
webhook configuration.

**Commit message format:**
```
[bayes] Fitted {n} edges for {graph_id} — {provenance_summary}

fingerprint: {fingerprint}
job_id: {job_id}
edges: {edge_count}
quality: r-hat {max_rhat}, min ESS {min_ess}
```

### 4. FE job tracking

Minimal for this workstream — just enough to close the loop:

- Store `{ job_id, graph_id, submitted_at }` in IDB or session state.
- On next pull, detect the `[bayes]` commit message and match to job_id.
- Log to `sessionLogService`:
  ```
  sessionLogService.success('bayes', 'BAYES_FIT_COMPLETE',
    `Fitted ${n} edges for ${graphId}`, summary, metadata);
  ```
- Clear the pending job record.

No real-time progress in this workstream. The FE shows "fit running" until the
commit appears. Progress visibility can be layered on later.

---

## Open questions

### Resolved

- **What schema fields does the webhook write?** `posterior` sub-objects on
  `ProbabilityParam` and `LatencyConfig` (see Schema additions above).
- **Single vs multi-file commit?** Atomic multi-file via Git Data API.
- **How does the FE detect completion?** Commit message pattern on next pull.
- **Parameter file vs graph file.** Both. The webhook updates parameter files
  AND cascades to graph files in the same atomic commit, using a shared
  isomorphic cascade module extracted from UpdateManager. See "Which files
  the webhook updates" below.
- **Webhook route GitHub auth (partial).** Credentials and simple API calls
  are proven. Atomic multi-file commits via Git Data API are NOT proven
  server-side — needs a spike. See "Server-side GitHub auth" below.
- **Submission route runtime.** See "Submission route" below.

### Resolved (16-Mar-26, continued)

- **Webhook payload contract.** See "Webhook payload contract" below.
- **Edge scoping.** See "Edge scoping rule" below.
- **YAML formatting responsibility.** Webhook handler owns YAML. See
  "YAML formatting" below.
- **Worker reads graph from git.** FE sends graph in submission payload for
  on-demand fits. See "Graph discovery" below.

### Still open

- **Isomorphic cascade module extraction.** The pure cascade logic
  (138 field mappings, override checking, value transforms) must be extracted
  from UpdateManager into a shared module usable by both the browser and the
  webhook handler. Investigation confirmed the core logic has zero platform
  dependencies — the extraction is a refactor, not a rewrite. But it touches
  a large, critical service (UpdateManager is ~5100 lines) and must not
  change FE behaviour. Needs a careful implementation plan. See "Which files
  the webhook updates" below.
- **Git Data API spike.** The atomic multi-file commit workflow (createBlob →
  createTree → createCommit → updateRef) has never been executed server-side
  in this codebase. All existing implementations are browser-only
  (`gitService.ts`). A spike is needed to verify this works from a Vercel TS
  serverless function, including Octokit instantiation, execution time within
  Vercel timeout limits, and correct commit output. See "Server-side GitHub
  auth" below for details.
- **Compute vendor selection.** Modal is the leading candidate (see Compute
  arch, section 3). This workstream's prototyping should resolve it — the worker
  logic is trivial, so the evaluation is purely about DX, cold start, DB
  connectivity, and webhook support.
- **Conflict with dirty files.** If the user has local edits to a parameter
  file and the webhook commits to the same file, the next pull conflicts.
  Accepted as a known limitation — the existing pull/merge flow handles
  file-level conflicts. Revisit if problematic.
- **Nightly graph discovery.** For nightly scheduled fits (no FE trigger),
  the worker needs to discover which graphs to fit and read them from git.
  Deferred — nightly scheduling is out of scope for this workstream.

---

## Investigation findings (16-Mar-26)

### Which files the webhook updates

**Both parameter files and graph files, in a single atomic commit.**

Codebase investigation confirmed the existing data flow:

- Parameter files (`parameters/*.yaml`) are the source of truth for `p.mean`,
  `p.stdev`, `latency.mu`, `latency.sigma`, `latency.model_trained_at`, and
  other fitted/observed values.
- UpdateManager (`src/services/UpdateManager.ts`) has explicit file→graph
  mappings that flow these fields to graph edges during "Get from File".
- Graph files are master for `query`, `n_query`, `anchor_node_id` — the
  webhook must never modify these.
- The `_overridden` pattern protects manually-set values: if
  `p.mean_overridden` is true on a graph edge, auto-sync from the parameter
  file skips that field.

**What the webhook writes to each parameter file:**

- `posterior` sub-object (new): alpha, beta, HDI, ess, rhat, fitted_at,
  fingerprint, provenance
- `latency.posterior` sub-object (new): mu_mean, mu_sd, sigma_mean, sigma_sd,
  HDI for t95, same quality fields
- `values[latest].mean` and `values[latest].stdev`: updated to posterior mean/sd
- `latency.mu`, `latency.sigma`: updated to posterior means
- `latency.model_trained_at`: updated to fit date
- **Preserved unchanged**: `query`, `n_query`, `anchor_node_id`, all
  `_overridden` flags, `values[]` history

**Graph file cascade:**

The webhook must update both parameter files AND graph files in the same
atomic commit. Without the graph update, the roundtrip is incomplete — the
graph YAML in git would be stale, and the FE would not see updated values
after pulling.

Today the cascade (parameter file → graph edge) is handled by
`UpdateManager.handleFileToGraph()` in the browser. The core cascade logic
— 138 declarative field mappings, override flag checks, and value transforms
— is a pure data transformation with **zero platform dependencies** (no IDB,
FileRegistry, GraphStore, browser APIs). The orchestration around it (IDB
reads, GraphStore mutations, event dispatch, UI callbacks) is browser-only.

**Approach: extract a shared isomorphic cascade module.**

1. Extract the pure cascade logic from UpdateManager into a shared module
   (e.g. `lib/parameter-cascade.ts`): mapping definitions, `applyMappings()`
   engine, override checking, `getNestedValue`/`setNestedValue` helpers, and
   value transforms (date normalisation, rounding).
2. Browser-side UpdateManager imports the shared module and wraps it with
   IDB/FileRegistry/GraphStore orchestration — no behavioural change to the
   FE.
3. Server-side webhook handler imports the same module. For each fitted edge:
   reads the graph YAML from git, applies the cascade via the shared module
   (respecting `_overridden` flags), includes the updated graph file in the
   atomic commit alongside the parameter files.

This ensures:

- **Single implementation** of cascade logic — no divergence between browser
  and server.
- **`_overridden` semantics are respected** — same code path, same rules.
- **Git is self-consistent** after the commit — parameter files and graph
  edges reflect the same posteriors.
- **The extraction is a refactor, not a rewrite** — the pure logic is already
  cleanly separated from orchestration inside UpdateManager. Investigation
  confirmed ~65–70% of UpdateManager's core logic is pure and isomorphic.

**Implications for the atomic commit:** the webhook handler reads the graph
file in addition to parameter files, applies cascaded changes, and includes
the updated graph file in the same `createTree` call. One commit, all files
consistent.

**What the webhook does NOT touch (regardless of option):**

- `query`, `n_query`, `anchor_node_id` — graph-mastered
- `_overridden` flags — user-controlled
- `values[]` history entries (only the latest/top entry is updated)

### Server-side GitHub auth

**Answer: credentials and simple API calls are proven. Atomic multi-file
commits are NOT — they need a spike.**

**What is proven server-side:**

- **Credentials loading.** `api/graph.ts` (lines 58–83) loads credentials from
  `SHARE_JSON` / `VITE_CREDENTIALS_JSON` env vars, validates against
  `SHARE_SECRET` / `VITE_CREDENTIALS_SECRET`, extracts
  `GitRepositoryCredential` with owner, repo, and token. This pattern works.
- **Simple GitHub REST API calls.** `api/auth-callback.ts` makes `fetch()`
  calls to `api.github.com` (OAuth token exchange, user info). `api/graph.ts`
  reads single files via the Contents API. Both use token auth headers.

**What is NOT proven server-side:**

- **Atomic multi-file commits via Git Data API.** The full workflow
  (getRef → getCommit → getTree → createBlob × N → createTree → createCommit
  → updateRef) exists **only** in `gitService.ts`, which is browser-only
  (`btoa()`, `window`, `CustomEvent`, Octokit instantiation assumes browser).
  No server-side route has ever performed this sequence.
- **Octokit server-side instantiation.** `@octokit/rest` is in
  `package.json`, but it is only imported in `gitService.ts` (browser).
  Octokit itself should work in Node.js (it's designed for both environments),
  but this has not been tested in a Vercel serverless function in this codebase.

**What the spike must verify:**

1. Instantiate Octokit in a Vercel TS serverless function with credentials
   from `SHARE_JSON`.
2. Execute the full Git Data API sequence: read current ref → create blobs for
   2–3 test files → create tree → create commit → update ref.
3. Confirm the commit appears correctly in the repo.
4. Measure execution time (Vercel serverless has a 10s default / 60s max
   timeout for hobby, 300s for pro).

**Alternative**: skip Octokit entirely and use raw `fetch()` calls to the Git
Data API (same as `auth-callback.ts` pattern). This avoids any Octokit
browser-assumption risk but requires manual JSON handling for each API call.

**The webhook handler authenticates in two directions:**

1. **Inbound (compute vendor → webhook):** validate shared secret from request
   against `process.env.BAYES_WEBHOOK_SECRET` (or reuse existing
   `SHARE_SECRET`).
2. **Outbound (webhook → GitHub):** load git credentials from
   `process.env.SHARE_JSON`, extract token, use for Git Data API calls.

**Existing env vars that can be reused:**

| Var | Purpose | Already configured? |
|---|---|---|
| `SHARE_JSON` / `VITE_CREDENTIALS_JSON` | Git credentials (owner, repo, token) | Yes (used by `graph.ts`) |
| `SHARE_SECRET` / `VITE_CREDENTIALS_SECRET` | Webhook validation | Yes (used by `graph.ts`, `init-credentials.ts`) |

A dedicated `BAYES_WEBHOOK_SECRET` may be preferable to reusing `SHARE_SECRET`
(separation of concerns), but the mechanism is identical.

### Submission route runtime

**The submission route (`/api/bayes/fit`) should be a Python route**, not TS.

Rationale: if Modal is the compute vendor, job submission uses Modal's Python
SDK (`modal.Function.spawn()`). A TS route would need to call Modal's HTTP
API instead — possible but less natural. Since the existing Python API
(`api/python-api.py`) already handles all Python-SDK-dependent routes, the
submission endpoint fits the same pattern: add a new endpoint to
`python-api.py` (or a new Python file if preferred).

Alternative: if the vendor provides a REST API for job submission, a TS route
works fine. Decide during vendor prototyping.

### FE sync gap (resolved)

The webhook commits both parameter files and the graph file in a single
atomic commit. After pulling, the FE sees updated graph edges directly — no
manual "Get from File" needed. The FE sync gap that exists for other data
flows (e.g. "Get Data" updates) does not apply to the Bayesian fit pathway
because the server-side cascade handles it.

### Webhook payload contract

The worker POSTs a single JSON object to `/api/bayes-webhook`. The handler
uses this to update parameter files and commit to git.

```json
{
  "job_id": "fit-abc123",
  "graph_id": "conversion-flow-v0",
  "repo": "nous-conversion",
  "branch": "main",
  "graph_file_path": "graphs/conversion-flow-v0.yaml",
  "fingerprint": "sha256:abc123...",
  "fitted_at": "16-Mar-26",
  "quality": {
    "max_rhat": 1.02,
    "min_ess": 450,
    "converged": true
  },
  "edges": [
    {
      "param_id": "household-delegation-rate",
      "file_path": "parameters/household-delegation-rate.yaml",
      "probability": {
        "alpha": 1.0,
        "beta": 1.0,
        "mean": 0.5,
        "stdev": 0.289,
        "hdi_lower": 0.025,
        "hdi_upper": 0.975,
        "hdi_level": 0.94,
        "ess": 0,
        "rhat": null,
        "provenance": "point-estimate"
      },
      "latency": {
        "mu_mean": 2.3,
        "mu_sd": 0.0,
        "sigma_mean": 0.6,
        "sigma_sd": 0.0,
        "hdi_t95_lower": 12.0,
        "hdi_t95_upper": 18.0,
        "hdi_level": 0.94,
        "ess": 0,
        "rhat": null,
        "provenance": "point-estimate"
      }
    }
  ],
  "skipped": [
    {
      "param_id": "some-edge-no-evidence",
      "reason": "no_evidence"
    }
  ]
}
```

Design notes:

- **`graph_file_path`**: the repo-relative path to the graph file. The
  webhook handler needs this to read, cascade to, and commit the graph file.
- **`edges` array keyed by `param_id`**: the worker discovers parameters from
  the graph edges' `p.id` fields. Each entry maps 1:1 to a parameter file.
- **`file_path` included**: the worker resolves this from `parameters-index.yaml`
  so the webhook handler knows which file to update without re-parsing the index.
- **`probability` and `latency` are separate**: an edge may have probability
  evidence but no latency evidence (or vice versa). Omit the sub-object if not
  fitted.
- **`skipped` array**: edges that were scoped in but couldn't be fitted (no
  evidence, degenerate data, etc.). Logged in the commit message for operator
  visibility.
- **`quality` top-level**: aggregate quality metrics for the commit message and
  FE session log. Per-edge quality is in the edge sub-objects.

### Edge scoping rule

An edge is in scope for fitting when **all** of the following hold:

1. The edge has `p.id` defined (linked to a parameter file).
2. The parameter has at least one snapshot evidence row in the DB for that
   workspace-prefixed `param_id`.
3. The edge is active (not disabled/hidden in the graph).

Edges without `p.id` are not parameter-linked and are excluded entirely —
they may be placeholder edges or manually-configured edges that don't
participate in data-driven fitting.

Edges that are in scope but have insufficient evidence (below minimum
threshold) appear in the `skipped` array with reason `insufficient_evidence`.
The threshold is defined by modelling policy (see Logical blocks, §3.7).

For the skeleton roundtrip, the scoping is simpler: any edge with `p.id` gets
a placeholder posterior. The worker doesn't query the snapshot DB for evidence
counts — it just produces `provenance: 'point-estimate'` for all scoped edges.

### YAML formatting

**The webhook handler owns YAML formatting. The worker produces JSON only.**

Flow:

1. Worker computes posteriors and POSTs JSON to the webhook (see payload
   contract above).
2. Webhook handler, for each edge in the payload:
   a. Reads the current parameter file content from git (via Git Data API:
      `git.getBlob` on the current tree).
   b. Parses the YAML.
   c. Merges in the posterior fields: sets `posterior` sub-object, updates
      `values[0].mean`, `values[0].stdev`, `latency.mu`, `latency.sigma`,
      `latency.model_trained_at`.
   d. Serialises back to YAML.
   e. Creates a blob for the updated content.
3. Webhook handler cascades to graph file:
   a. Reads the graph YAML from git.
   b. For each fitted edge, applies the shared cascade module: updates
      `p.mean`, `p.stdev`, `p.latency.*`, `p.posterior` on the graph edge,
      respecting `_overridden` flags.
   c. Serialises the updated graph YAML.
   d. Creates a blob for the graph file.
4. All blobs (parameter files + graph file) are committed atomically in a
   single tree/commit/ref update.

Why this approach:

- **Worker stays language-agnostic.** Python worker produces JSON; it doesn't
  need to know about YAML formatting, field ordering, or comment preservation.
- **Single point of YAML handling.** The TS handler uses the same YAML library
  (`yaml` package, already in `package.json`) as the rest of the app.
- **Read-before-write is required anyway.** The handler must read current files
  to build the base tree for the atomic commit. Merging posterior fields into
  the parsed YAML is a small incremental step.
- **Future-proof.** When real inference replaces the skeleton, only the JSON
  payload content changes. The YAML merge logic in the handler stays the same.

### Graph discovery

**For on-demand fits (FE trigger), the graph is sent in the submission payload.**

The `/api/bayes/fit` submission includes:

- `graph_id`: identifies the graph
- `repo`, `branch`: target repository
- `graph_snapshot`: the full graph YAML content (or parsed JSON) at the
  moment of submission
- `parameters_index`: the full `parameters-index.yaml` content (so the worker
  can resolve `param_id` → `file_path` without a GitHub API call)

This means:

- **No GitHub API dependency from the worker** (for on-demand fits).
- **No race conditions.** The graph is frozen at submission time. If the user
  edits the graph between submission and completion, the posteriors are written
  against the submitted version. The next fit picks up changes.
- **Payload size is acceptable.** A large graph is ~200KB of YAML. The
  parameters index is ~10KB. Well within webhook/API payload limits.

**For nightly scheduled fits** (future, out of scope for this workstream), the
worker will need to read graphs directly from git. This requires GitHub API
access from the worker environment — a separate concern to be addressed when
nightly scheduling is implemented.

---

## Acceptance criteria

This workstream is complete when:

1. **Submission works.** FE can call `/api/bayes/fit` and receive a `job_id`.
2. **Worker executes.** The compute vendor runs the worker, connects to the
   snapshot DB, reads evidence inventory, and fires the webhook.
3. **Webhook commits.** The Vercel handler receives the payload, updates
   parameter files with `posterior` fields, cascades to graph edges via the
   shared isomorphic cascade module (respecting `_overridden` flags), and
   commits all files atomically to git.
4. **FE reads back.** After pulling, the FE sees updated `posterior` fields
   on graph edges and updated `p.mean`/`p.stdev` values. The fields parse
   correctly and appear in the type system. No manual "Get from File" needed.
5. **Cascade consistency.** The shared cascade module produces identical
   results when called from the webhook handler and from the browser-side
   UpdateManager. Verified by tests that run the same inputs through both
   paths.
6. **Schema is correct.** TypeScript types, Python models, and YAML schemas
   all include the `posterior` sub-objects. Existing graphs without posteriors
   continue to load without errors.
7. **Idempotency holds.** Firing the same webhook twice does not create
   duplicate commits.
8. **Session log records the event.** The FE logs a `BAYES_FIT_COMPLETE`
   entry when it detects the committed result.

What is explicitly **not** required:
- Real Bayesian inference (placeholder values are fine)
- FE display of posterior data (reading + type-checking is enough)
- Real-time progress during execution
- Fan charts or confidence band changes
- Nightly scheduling (on-demand trigger only)

---

## Implementation sequence

### Step 1: Schema additions
Add `posterior` sub-objects to TypeScript types, Python Pydantic models, and
YAML schemas. Write a focused integration test that round-trips a graph with
posterior fields through YAML serialisation/deserialisation.

### Step 2: Isomorphic cascade module (via slimdown UM-PR1–PR3)

Extract the pure cascade logic from UpdateManager into importable modules
usable by both the browser and Vercel serverless functions. This step is
executed as **UM-PR1 through UM-PR3** of the existing UpdateManager
slimdown plan (`docs/current/refactor/src-slimdown.md`, Target 2). The
slimdown plan is the authoritative reference for extraction mechanics,
cluster inventory, stop/gates, and test runlists. This section records
only the async-infra-specific context that the slimdown plan does not
cover.

#### Why align with the slimdown plan

The slimdown plan's Target 2 was designed independently of this workstream
but produces exactly the modules needed here. Aligning avoids:

- Maintaining two competing extraction plans for the same 5,136-line file.
- Risk of the two extractions conflicting or producing incompatible module
  boundaries.
- Duplication of test work (the slimdown plan already defines stop/gates
  and test runlists for each PR).

#### What UM-PR1–PR3 produce

Per the slimdown plan (verified current as of 16-Mar-26, UpdateManager
still 5,136 lines, all function locations unchanged):

- **UM-PR1 (types + pure helpers)**: `updateManager/types.ts` (FieldMapping,
  UpdateOptions, UpdateResult, FieldChange, Conflict, UpdateError, Warning),
  `updateManager/nestedValueAccess.ts` (getNestedValue, setNestedValue),
  `updateManager/roundingUtils.ts`, `updateManager/auditLog.ts`.
- **UM-PR2 (mapping configuration)**: `updateManager/mappingConfigurations.ts`
  — the 18 `addMapping()` calls (~1,200 lines of declarative config),
  exported as named constants so consumers can select subsets by direction,
  operation, and sub-destination.
- **UM-PR3 (mapping engine)**: `updateManager/mappingEngine.ts` —
  `applyMappings()` (currently lines 1346–1470) extracted as a standalone
  pure function.

After UM-PR3, UpdateManager imports these modules and its public API is
unchanged. All existing callers (dataOperationsService, UI) are unaffected.

#### How the webhook handler uses the extracted modules

The webhook handler imports directly from `updateManager/` — it never
instantiates UpdateManager.

```
webhook receives JSON payload
  → for each edge: parse parameter YAML, merge posterior fields
  → read graph YAML from git
  → for each fitted edge:
      - find the graph edge by p.id match
      - build source object (updated parameter data)
      - import FILE_TO_GRAPH_PARAMETER_UPDATE mappings from mappingConfigurations
      - call applyMappings(source, graphEdge, mappings, options)
        from mappingEngine
      - apply returned changes to the graph edge
  → serialise updated graph YAML
  → commit all files atomically
```

Only the `fileToGraph` direction with `UPDATE` operation and `parameter`
sub-destination is needed — a subset of the full mapping configuration.

#### Isomorphic verification gate (after UM-PR3)

After UM-PR3 completes, and before proceeding to Step 3, verify that the
extracted modules are genuinely platform-agnostic:

1. **No browser imports**: confirm `mappingEngine.ts`,
   `mappingConfigurations.ts`, `nestedValueAccess.ts`, and `types.ts`
   import nothing from `sessionLogService`, IDB, FileRegistry, GraphStore,
   `window`, `document`, `btoa`/`atob`, `CustomEvent`, or any other
   browser-only API.
2. **No `this` captures**: confirm that mapping transform/condition
   functions in `mappingConfigurations.ts` are stateless predicates (no
   closure over UpdateManager instance state). Investigation (16-Mar-26)
   found this to be the case, but must be re-verified after extraction.
3. **Parity test**: run the same source/target pair through the extracted
   `applyMappings()` directly AND through UpdateManager's
   `handleFileToGraph()`, assert identical `UpdateResult`. This is the
   key test that proves extraction didn't change behaviour.
4. **Node.js import test**: a trivial script that `require()`s (or
   `import()`s) the extracted modules in a plain Node.js context (no
   bundler, no jsdom) and calls `applyMappings()` with a minimal fixture.
   If it runs without error, the modules are server-safe.

If any of these checks fail, resolve before proceeding — the webhook
handler's correctness depends on these modules being pure.

#### Investigation findings (carried forward)

These findings from the 16-Mar-26 codebase investigation inform UM-PR1–PR3
execution. They are recorded here rather than in the slimdown plan because
they are specific to the isomorphic use case:

- **`applyMappings()` is pure**: lines 1346–1470 perform no I/O, no side
  effects, no browser API calls. It returns `UpdateResult` and the caller
  decides what to do with it.
- **`sessionLogService` is not called from `applyMappings()`**: logging
  happens in the direction handlers, not the engine. The extracted module
  must not import it; if logging is ever needed, accept an optional
  callback.
- **Transform/condition functions are stateless**: they check properties of
  the `source` and `target` objects passed in (e.g. `isProbType` checks
  `source.type === 'probability'`). No closure captures `this`.
- **Helper imports are all platform-agnostic**: `normalizeToUK`,
  `roundToDecimalPlaces`, `generateUniqueId`, `getSiblingEdges`,
  `normalizeConstraintString`, and the latency constants are pure
  JS/Date/Math with zero browser dependencies.
- **No direct tests of `applyMappings()` exist today**: the ~2,335 lines
  of UpdateManager tests cover higher-level operations (renameNodeId,
  rebalance) but not the core mapping engine. This gap must be filled
  during extraction — see the slimdown plan's test runlist and the parity
  test above.

### Step 3: Git Data API spike + webhook handler

Prove that atomic multi-file commits work from a Vercel serverless function,
then build the webhook handler that uses both the Git Data API and the
shared cascade module.

#### Part A: Git Data API spike

**Goal:** a minimal Vercel serverless function that creates a multi-file
atomic commit on a test branch using the Git Data API.

**Why this needs a spike:** the full Git Data API workflow (getRef →
getCommit → getTree → createBlob × N → createTree → createCommit →
updateRef) exists only in `gitService.ts`, which is browser-only. No
server-side route has ever performed this sequence. The spike must verify
that it works in the Vercel Node.js runtime.

**What the spike creates:**

A temporary route `api/bayes-spike.ts` (deleted after the spike) that:

1. Loads credentials from `SHARE_JSON` env var using the existing pattern
   from `api/graph.ts` (lines 58–83).
2. Instantiates Octokit server-side. Two approaches to evaluate:
   - **Octokit:** `new Octokit({ auth: token })` — likely works in Node.js
     (Octokit is designed for both environments) but unproven in this
     codebase's Vercel setup.
   - **Raw fetch:** call `api.github.com` endpoints directly with
     `Authorization: token ${token}` headers, as `api/auth-callback.ts`
     already does. More verbose but zero library risk.
3. Executes the Git Data API sequence on a test branch:
   a. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` — current HEAD SHA
   b. `GET /repos/{owner}/{repo}/git/commits/{sha}` — base tree SHA
   c. `POST /repos/{owner}/{repo}/git/blobs` × 2 — create test file blobs
   d. `POST /repos/{owner}/{repo}/git/trees` — new tree referencing blobs
   e. `POST /repos/{owner}/{repo}/git/commits` — commit with message
   f. `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` — advance ref
4. Returns the commit SHA and URL for manual verification.

**Success criteria:**

- Commit appears correctly in the GitHub repo.
- Execution time is within Vercel timeout (measure; expect <5s for 2 files).
- No `btoa`/`atob` errors (these are browser-only; the spike must use
  `Buffer.from(content).toString('base64')` instead).

**Decision after spike:** Octokit vs raw fetch. If Octokit works cleanly,
use it (matches `gitService.ts` patterns, less code). If it has issues
(bundle size, initialisation quirks), use raw fetch (proven in existing
routes).

**Platform-agnostic Git Data API extraction:**

Regardless of Octokit vs fetch, extract the core commit logic into a
shared utility (e.g. `lib/git-commit.ts`):

```
async function atomicCommitFiles(
  octokit_or_fetcher,   // GitHub API client (Octokit instance or fetch wrapper)
  owner, repo, branch,  // target
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<{ sha: string; url: string }>
```

This function encapsulates the 6-step Git Data API sequence. Both the
webhook handler (server-side) and potentially `gitService.ts` (browser-side,
future refactor) can use it. The browser-specific concerns (`btoa`, event
dispatch, progress callbacks) stay in `gitService.ts`'s wrapper.

#### Part B: Webhook handler (`/api/bayes-webhook.ts`)

**After the spike proves the Git Data API works server-side**, build the
full webhook handler.

**Request flow:**

1. **Authenticate.** Validate `x-bayes-secret` header against
   `process.env.BAYES_WEBHOOK_SECRET`. Reject with 401 if missing/wrong.

2. **Parse payload.** Validate the JSON body against the webhook payload
   contract (see "Webhook payload contract" above). Reject with 400 if
   malformed.

3. **Idempotency check.** Search recent commits on the target branch for
   a commit message containing the `fingerprint`. If found, return 200
   with `{ status: 'already_committed', sha }`. This prevents duplicate
   commits from vendor retries.

4. **Load credentials.** Extract GitHub token from `SHARE_JSON` env var
   using the existing pattern from `api/graph.ts`.

5. **Read current files from git.** For each edge in the payload:
   a. Read the parameter file at `file_path` from the current branch HEAD
      (via Contents API or `git.getBlob`).
   b. Parse the YAML.
   Also read the graph file (the handler needs `graph_id` → graph file
   path; this mapping must be in the payload or derivable from the
   parameters index).

6. **Update parameter files.** For each edge:
   a. Merge `posterior` sub-object into the parameter YAML.
   b. Update `values[0].mean`, `values[0].stdev` to posterior mean/stdev.
   c. Update `latency.mu`, `latency.sigma` to posterior means.
   d. Update `latency.model_trained_at` to `fitted_at`.
   e. Preserve all other fields unchanged.

7. **Cascade to graph file.** Using the shared cascade module:
   a. For each fitted edge, find the matching graph edge (by `p.id`).
   b. Build a source object from the updated parameter data.
   c. Call `applyMappings(source, graphEdge, FILE_TO_GRAPH_MAPPINGS,
      { ignoreOverrideFlags: false })`.
   d. Apply the returned changes to the graph edge.
   e. Also set `p.posterior` on the graph edge (this is a new field, not
      part of the existing cascade mappings — add it to the mapping
      definitions in Step 2, or handle it as a direct field set in the
      webhook handler).

8. **Atomic commit.** Using the extracted Git Data API utility:
   a. Create blobs for all updated parameter files + the graph file.
   b. Create tree, commit, update ref — single commit.
   c. Use the commit message format defined in "Infrastructure components,
      §3" above.

9. **Return.** `{ status: 'committed', sha, files_updated, edges_fitted }`.

**Error handling:**

- GitHub API errors → 502 with error detail.
- YAML parse failure → 500 with the file path that failed.
- Credential loading failure → 500 (not 401 — this is a server config
  issue, not a client auth issue).
- All errors include `job_id` in the response for correlation.

**What the webhook handler needs in the payload that isn't there yet:**

The current payload contract includes `graph_id` but not the **graph file
path** in the repo. The handler needs to know which file to read and update.
Options:
- Add `graph_file_path` to the payload (e.g. `graphs/conversion-flow-v0.yaml`).
- Derive it from a convention (`graphs/{graph_id}.yaml`).
- Include it in the submission payload and pass through.

Recommendation: add `graph_file_path` to the webhook payload contract.

**Testing the webhook handler:**

- **Local cURL test:** craft a JSON payload matching the contract, POST to
  `localhost:3000/api/bayes-webhook` with the correct secret header. Verify
  the commit appears in the repo with correct parameter + graph file changes.
- **Idempotency test:** POST the same payload twice. Second call returns
  `already_committed`.
- **Override test:** set `p.mean_overridden: true` on a graph edge before
  the test. Verify the webhook respects the flag and does not overwrite
  `p.mean` on that edge.
- **Malformed payload test:** POST invalid JSON, missing fields, wrong
  secret. Verify correct error codes.

### Step 4: Compute vendor setup
Set up Modal (or chosen vendor). Deploy the trivial worker. Verify DB
connectivity, webhook delivery, and cold start behaviour.

### Step 5: Submission route
Build `/api/bayes/fit`. Wire FE trigger (button or dev-only command). Verify
end-to-end: trigger → worker → webhook → commit → pull → read back.

### Step 6: FE integration
Add job tracking (minimal). Add session log integration. Verify the full
circuit from the user's perspective.

---

## Relationship to other docs

**Compute arch** (`3-compute-and-deployment-architecture.md`) covers the
deployment topology, vendor evaluation, shared code strategy, and DB access
patterns. This doc extracts the implementation-ready milestone from that
architectural context. Compute arch is the reference for *why* decisions were
made; this doc defines *what to build* and *how to verify it works*.

**Logical blocks**, **Model contract**, and **Reference impl** belong to the
Semantic foundation workstream. They have no dependency on this infrastructure
work and vice versa. Once both workstreams are complete, the inference logic
plugs into the worker entry point built here. The infrastructure does not
change when real inference replaces the placeholder.
