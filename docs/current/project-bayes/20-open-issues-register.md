# Doc 20 — Open Issues Register (Bayes Regression)

**Status**: Open
**Started**: 22-Apr-26
**Purpose**: Track issues surfaced by the sparseness regression (and its
offspring) from hypothesis through to resolution, and keep the current
run context attached to the investigation so results do not get detached
from why they were commissioned.

Complements:
- `18-compiler-journal.md` — chronological dev journal
- `19-be-stats-engine-bugs.md` — narrow stats-engine bug records

> **Structured source of truth**: `20-open-issues-register.tracker.yaml`.
> The marker-fenced sections below are rewritten from the YAML by the
> tracker MCP server (`render_register`). See doc 63 for the spec and
> doc 20's free-form sections — "How to use", "State model", "Per-issue
> template", and "Workstreams" — which live outside the marker regions
> and are preserved across renders.

---

## How to use this register

This document is the working surface for the current Bayes defect
investigation. It is both:

- the issue tracker
- the run log for the active line of investigation

Workflow for any investigation run:

1. **orient** — call `get_overview` to see the current line, open blockers,
   and the next planned run. Never assume state from reading this document;
   the YAML is the source of truth.
2. **create** — `create_run` before launch. Why the run exists, what it is
   meant to prove, and what it is not meant to prove are required fields.
   If you cannot say what a run is *not* meant to prove, you do not
   understand it well enough to launch it.
3. **start** — `start_run` with the returned `tracker_run_id`, then launch
   the Bayes command with that id attached to the result envelope
   (Phase 2 of doc 63 will make the runners refuse without it; until
   that ships, attach manually).
4. **check blockers first when the run returns**:
   - did it complete?
   - is the output trustworthy?
   - did binding and tooling behave correctly?
5. **complete** — `complete_run` with `status="blocked"` (plus a
   `blocker_category`) if any blocker check failed, or `status="answered"`
   with a one-line outcome if clean. Blocked runs are first-class evidence
   that completion work isn't done — they are not failures to hide.
6. **update issues** — `upsert_issue` to reflect what the run taught you,
   then `render_register` to refresh this document from the YAML.

This is how we avoid using a broken or ambiguous run to "prove" a model
claim it was never capable of answering.

---

## Tracker operations reference

The tracker is registered in `.mcp.json` as **`bayes-tracker`**. Full
contract and field schema live in doc 63; tool docstrings carry the
per-operation semantics. This section is the quick map — use it to pick
which tool to call, not to learn field types.

**Reads** (call these first, always cheap):

| Tool | Returns |
|---|---|
| `get_overview` | current line, open blockers, next planned run, state counts |
| `list_blockers` | every blocked run plus counts by `blocker_category` |
| `get_next_run` | the next `planned` run, if any |
| `get_issue` | full issue plus its related runs |
| `get_run` | full run plus its related issues |

**Writes** (each enforces its required-field set; see doc 63 §9):

| Tool | When |
|---|---|
| `set_current_line` | switching investigation focus |
| `create_run` | before launching a run — required fields gate creation |
| `start_run` | at launch — stamps `started_at`, sets `active_run_id` |
| `complete_run` | when the run returns — status ∈ {`blocked`, `answered`, `abandoned`} |
| `upsert_issue` | new defect, or update to an existing one |
| `link_run_and_issue` | cross-reference after the fact; `create_run` already auto-links |
| `render_register` | rewrites the marker regions of this doc from the YAML |

**Blocker categories** (§14 — pick one when completing a run as
`blocked`):

- `tooling` — harness, parser, infrastructure, CLI
- `evidence_integrity` — parser drift, binding contamination, wrong snapshot
- `binding` — query-to-evidence binding failed
- `compile_runtime` — compile or sampling crashed
- `sampling_geometry` — legitimate model pathology (funnel, multi-modal, ridge)
- `external` — CI, cloud, network
- `unknown` — only when you genuinely cannot classify

**Invariants the schema enforces** (so you do not fight them):

- IDs are tracker-assigned (`I-001`, `R-001`, zero-padded serial). Do not
  pass `id` to `create_run` / `upsert_issue` on create.
- Every run carries `related_issue_ids`; they must resolve. `create_run`
  automatically mirrors the back-link onto each issue.
- A run transitions `planned → running → {blocked|answered|abandoned}`.
  `start_run` only accepts `planned`; `complete_run` only accepts
  `planned`/`running`/`returned`.
- `active_run_id` on the current line is singular — one run at a time.
- Completing as `blocked` requires `blocker_category`; completing as
  `answered` requires `outcome_summary` and `next_action`.

Edits inside the marker-fenced regions of this document are overwritten
on the next `render_register`. Edit the YAML (or use the MCP tools) if
something in a rendered region is wrong.

---

<!-- tracker:current-line:start -->
## Active line

- **Current line**: sparse-graph completion and defect isolation
- **Current priority**: get the blocked sparse graphs to complete
- **Current blocker focus**: `diamond-*-2dim` under contention
- **Next run goal**: verify that the second `I-010` stall-detector fix
<!-- tracker:current-line:end -->

---

<!-- tracker:run-log:start -->
## Run log

### R-003 — Pending blocker retest for `diamond-*-2dim`
**Status**: planned
**Date**: 22-Apr-26
**Run / plan**: targeted rerun of the previously failing
**Related issues**: I-010, I-011

**Why this run exists**: determine whether the second `I-010`
**Intended to prove**: whether the remaining failure mode is still
**Does not prove**: anything about onset bias (`I-002`), sigma bias
**Blocker check first**: does the graph now complete honestly, or at

**Outcome**: pending
**Next action**: if clean, return to the broader sparse systematic issues;

### R-002 — Post-parser / infra rerun (`r1776814894`)
**Status**: answered
**Date**: 22-Apr-26
**Run / plan**: same sparse scope after the parser and infrastructure
**Related issues**: I-001, I-010, I-011

**Why this run exists**: separate real sparse/model defects from the
**Intended to prove**: which serious defects survive once the obvious
**Does not prove**: that the sparse matrix is now completion-stable;
**Blocker check first**: completion and stall behaviour on the

**Outcome**: `I-001` verified fixed; `I-010` regressed into a narrower
**Next action**: rerun the blocked `diamond-*-2dim` set after the second

### R-001 — Initial sparse regression (`r1776733951`)
**Status**: answered
**Date**: 22-Apr-26
**Run / plan**: broad sparse regression across 41 graphs
**Related issues**: —

**Why this run exists**: first broad pass to surface the major defect
**Intended to prove**: which severe defect families exist and therefore
**Does not prove**: any specific root cause, or that the observed bias
**Blocker check first**: parser integrity, harness completion, timeout

**Outcome**: surfaced the parser artifact (`I-001`), the arviz race
**Next action**: fix the clear blockers and artifacts, then rerun before

<!-- tracker:run-log:end -->

---

## State model

```
observed ──▶ hypothesis ──▶ diagnosed ──▶ designed ──▶ implemented ──▶ verified ──▶ resolved
              │                │                                          ▲
              ▼                │                                          │
           rejected ────────▶  │                                       regressed
              │                ▼
              └──▶ deferred ──▶ resolved (won't fix)
                        │
                        └──▶ hypothesis (reopened)
```

| State | Meaning | Leaves via |
|---|---|---|
| **observed** | symptom seen, no hypothesis yet | hypothesis · duplicate |
| **hypothesis** | candidate cause articulated, not yet tested | diagnosed · rejected |
| **rejected** | hypothesis falsified | hypothesis (new) · observed |
| **diagnosed** | root cause confirmed through evidence | designed |
| **designed** | fix approach agreed; not coded yet | implemented |
| **implemented** | code committed | verified · regressed |
| **regressed** | post-fix evidence contradicts resolution | hypothesis (reopen) |
| **verified** | post-fix regression confirms resolved | resolved |
| **resolved** | closed, with provenance of verification | (terminal) |
| **deferred** | known, not fixing now | hypothesis · resolved (won't fix) |

Rejections accumulate (H1 rejected, H2 rejected, H3 → diagnosed). Each
rejection carries the falsifying evidence so the hypothesis doesn't get
re-proposed later.

---

## Per-issue template

Issues are authored via the tracker (`upsert_issue`), which enforces the
required-field set. The rendered form below is how each entry appears
in the `tracker:issues` region.

```markdown
### I-NNN — [short title]
**State**: hypothesis | diagnosed | designed | implemented | verified | resolved | rejected | deferred
**Updated**: d-MMM-yy
**Owner**: [name or "unclaimed"]
**Severity**: blocker | quality | paper-cut

**Summary**: [one-paragraph summary]
**Next action**: [one line]
**Related runs**: R-...

**Evidence**:
- Observation 1 with pointer (run ID, file:line, metric value)
- Observation 2 …

**Diagnosis**: [present when state ≥ diagnosed]
**Design**: [present when state ≥ designed]
**Implementation**: [present when state ≥ implemented]
**Verification**: [present when state ∈ {verified, resolved}]
```

---

<!-- tracker:issues:start -->
## Issues

### Observed

### I-002 — `onset` parameter +0.65d bias across all edges
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: Run r1776733951, across 106 edge-level onset failures: - Mean bias +0.654 days (absolute) - 103 of 106 (97%) are positive — near-universal upward - Max |z|=7.5; not the most-extreme parameter but by far the most consistent
**Next action**: Investigate.
**Related runs**: —

### I-003 — `sigma` 100% positive bias
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: paper-cut

**Summary**: 6 of 6 sigma failures in r1776733951 are positive, mean +0.285. Small n relative to onset, but the direction is perfectly one-sided.
**Next action**: Investigate.
**Related runs**: —

### I-004 — Only 10 of 41 graphs have clean convergence
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: In r1776733951: 31 of 41 graphs had at least one of rhat / ESS / converged_pct failures. Breakdown: - 16 × ESS+converged_pct only - 8 × rhat+ESS+converged_pct - 5 × ESS only - 2 × converged_pct only - 10 clean
**Next action**: Investigate.
**Related runs**: —

### I-005 — Orth 2-dim graphs: clean point estimates, weak convergence
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: Tier T1 (8 `*-2dim` graphs) in r1776733951: median max |z| = 9.3 (best of all tiers), but max rhat = 1.463 (worst of all tiers).
**Next action**: Investigate.
**Related runs**: —

### I-006 — Single-dim lifecycle has worst single outlier (z=132)
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: diamond-lifecycle-sparse max |z| = 132 in r1776733951. Same graph's Tier-4 orth-context variant (abc-lifecycle-sparse-2dim) max |z| = 8.8. Counter-intuitive: orth + lifecycle *cleaner* than lifecycle alone.
**Next action**: Investigate.
**Related runs**: —

### I-007 — Missing slice recovery rows on 3 legacy context graphs
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: 13 declared slice entries had no posterior rows in r1776733951: - diamond-context-sparse: 6 missing - skip-context-sparse: 4 missing - context-two-dim-sparse: 3 missing
**Next action**: Investigate.
**Related runs**: —

### Diagnosed

### I-011 — Diamond orth-context graphs have pathologically slow posterior
**State**: diagnosed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: blocker

**Summary**: Run r1776814894 (post-fix): all five `synth-diamond-*-2dim` graphs fail with `RuntimeError: Chain stall persisted after 20 retries`. Stall rates: 0.13–0.79 draws/s; chain alternates between chain 0 and chain 1 across the 20 retries. Affected: - diamond-lifecycle-sparse-2dim - diamond-sparse-1-2dim - diamond-sparse-2-2dim - diamond-sparse-3-2dim - diamond-sparse-4-2dim
**Next action**: Design a fix.
**Related runs**: R-002, R-003

### Regressed

### I-010 — Stall detector cycles on chain at 15–20% of peak
**State**: regressed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: abc-sparse-1 chain 1 log (r1776733951): CRAWL ENTERED ↔ CRAWL RECOVERED cycled every ~2 seconds for minutes without ever firing STALL CONFIRMED. Chain actual throughput ~0.5 draws/s (11 % of peak 4.4). Entry threshold was 0.10 × peak = 0.44 draws/s; short bursts to 1.0 draws/s crossed the threshold and reset the 30 s grace timer.
**Next action**: Investigate regression.
**Related runs**: R-002, R-003

### Verified

### I-001 — Anchor→first-hop p biased toward 1.0 (parser artifact)
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: - Regression run r1776733951: six outlier edges with |z|>50, all on   anchor→first-hop edges, all biased toward 1.0:   - diamond-lifecycle-sparse anchor-to-gate: truth=0.85 post=0.982 z=132   - diamond-sparse-2-hicard anchor-to-gate: truth=0.85 post=0.984 z=134   - fanout-sparse-4 anchor-to-gate: truth=0.80 post=0.966 z=55   - abc-lifecycle-sparse a-to-b: truth=0.70 post=0.856 z=52 - Cross-graph pattern check: in every affected graph, `edge.p.posterior_mean`   exactly matched one specific slice's posterior_mean, and that slice was   always the alphabetically last slice with data.
**Next action**: None — closed.
**Related runs**: R-002

### I-008 — arviz daily-warning race on max_parallel ≥ 2
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: blocker

**Summary**: `diamond-lifecycle-sparse-2dim` in r1776733951: harness exit 1 at 369ms, before any MCMC. Trace: ``` FileNotFoundError: '/home/reg/.cache/arviz/daily_warning.tmp'   -> '/home/reg/.cache/arviz/daily_warning' ``` Root-caused: `arviz/__init__.py::_warn_once_per_day` does a non-atomic tmp→final rename; two parallel workers both create the same tmp file, one renames it first, the other errors.
**Next action**: None — closed.
**Related runs**: —

### I-009 — Timeout→SIGSEGV (ungraceful SIGTERM of nutpie native threads)
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

**Summary**: `synth-abc-sparse-1` in r1776733951: TIMEOUT at 1505s, harness exit 1, faulthandler log captured 10 KB SIGSEGV trace with `<no Python frame>`. Chain 1 was CRAWLing at 0.4 draws/s at the time of timeout; SIGTERM landed mid-matrix-op in native code, producing the collateral SIGSEGV.
**Next action**: None — closed.
**Related runs**: —

<!-- tracker:issues:end -->

---

# Workstreams

A workstream is a multi-step investigation tied to one or more issues.
Each phase names explicit success criteria and a CPU budget so phases
can be authorised separately under Gate 5.

Workstreams are narrative-only; they are not part of the tracker schema.

---

## W-011 — Characterise and fix diamond × orth-2-dim posterior pathology
**Linked issue**: I-011 (diagnosed)
**State**: active (Phase C)
**Updated**: 22-Apr-26
**Owner**: unclaimed

**Status**: Phases A1-A3 complete. Pathology confirmed as strong posterior
correlation (not funnel, not multi-modal, not shape bug). Target fix is
reparameterisation of the onset/mu block for shifted-lognormal latency
edges. Phases A4, B skipped as unnecessary given Phase A1+A3 data already
isolates the correlation pathology.

### Problem statement
Five `synth-diamond-*-2dim` graphs consistently fail with chain stalls
across 20 independent random starts. Failure is deterministic across
randomisation — the posterior geometry itself is pathological. abc ×
2-dim works; diamond × 1-dim works. The branch-group + orthogonal
second context dim combination is the trigger.

### Phase A — Characterise the pathology
**Budget**: 1 targeted fit, ~15–30 min. No regression run.

- **A1**: Diagnostic short run on `diamond-sparse-1-2dim` (mildest
  sparsity, rules out data starvation). Config: `chains=2`,
  `tune=300`, `draws=300`, `target_accept=0.99`, `max_treedepth=15`,
  save warmup trace.
- **A2**: Extract NUTS diagnostics per draw: divergence flags, tree
  depth, step size, energy, n_steps. Use pattern-match to classify
  the failure mode:
  - **Funnel**: step size → 0, divergences rise, tree depth maxed.
  - **Multi-modal**: divergences low, per-chain means separate,
    rhat ≫ 2 with no ESS issue within a chain.
  - **Correlation**: step size stable, n_steps/draw very high
    (tree depth ≥ 10).
  - **Step-size pathology**: step size oscillates, acceptance swings.
- **A3**: Post-hoc pairwise posterior correlations from warmup
  samples. Blocks of high-correlation pairs name the specific
  variable pairs driving the pathology (e.g. `p_base` ↔ `tau_p`,
  `mu_slice_vec` ↔ `onset_slice_vec`).
- **A4**: Dump PyMC model structure (RVs, shapes). Confirm per-slice
  vectors have the expected length (9 for a 3×3 orth grid, not 3 or
  6). Cheap, catches shape bugs masquerading as geometry issues.

**Exit criteria**: classify the pathology into one of the four
categories above with evidence from A2 and A3; OR identify a shape
bug from A4. Record in I-011 as diagnosed.

### Phase B — Isolate the trigger (parametric strip-down)
**Budget**: 5–6 targeted fits, serial, ~2 h total.

Build five truth-file variants of `diamond-sparse-1-2dim`, each
altering ONE dimension:
- **B1.a**: drop second dim → 1-dim diamond (should work — baseline
  sanity).
- **B1.b**: drop sparsity → full-data diamond × 2-dim.
- **B1.c**: replace branch group with sequential edges
  (`a→b→c→d` × 2-dim).
- **B1.d**: reduce second dim cardinality 3 → 2.
- **B1.e**: shared p across slices (`centred_p_slices=False`).

- **B2**: High-cardinality single-dim check — diamond × 1-dim × 9
  values (matches 3×3 = 9 orth cells). Disambiguates orthogonality
  from cardinality.

**Exit criteria**: identify the minimal reproducer; the specific
trigger (branch-group, orthogonality, cardinality, per-slice p,
per-slice latency) is named.

### Phase C — Hypothesis-driven fix
**Budget**: design-only + one targeted fit per candidate fix.

Based on A's classification and B's reproducer:
- **Funnel** → non-centred/centred reparam of the suspect variable.
- **Multi-modal** → multiple init points; identify symmetry
  (label-switching) or prior-induced modes.
- **Correlation** → block reparam, constraint/anchor, or Riemann HMC.
- **Step-size** → `init_mean` priming, tighter `target_accept`.
- **Shape bug** → compiler fix.

**Exit criteria**: one candidate fix makes `diamond-sparse-1-2dim`
complete with healthy chains (rhat < 1.1, ESS > 200).

### Phase D — Verify
**Budget**: D1 ~30–60 min (5 affected graphs serial); D2 full regression
~2–3 h.

- **D1**: Focused mini-regression on the 5 affected diamond-*-2dim
  graphs. All five must complete cleanly.
- **D2**: Full sparse regression if D1 passes; confirm no new harness
  failures introduced.

**Exit criteria**: I-011 moves to verified/resolved in the register.

### Risks / unknowns
- Phase A diagnostics depend on nutpie exposing per-draw step size
  and tree depth to the InferenceData. If it doesn't, fall back to
  PyMC's NUTS backend for A1.
- Phase B assumes the five strip-down variants are cheap to author.
  If the generator doesn't support them directly, that's a scope
  expansion (1–2 h to extend `generate_sparsity_sweep.py`).
- Phase C fixes may interact with other tiers. A fix for funnel in
  Section 6 per-slice Multinomial could regress abc × 2-dim — hence
  Phase D2's full regression.
