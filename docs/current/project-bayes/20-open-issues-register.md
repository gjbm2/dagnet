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

---

## How to use this register

This document is the working surface for the current Bayes defect
investigation. It is both:

- the issue tracker
- the run log for the active line of investigation

The operating rule is simple:

1. write the next run entry here before launch
2. say why the run exists, what it is meant to prove, and what it is not
   meant to prove
3. when the run returns, check blockers first:
   - did it complete?
   - is the output trustworthy?
   - did binding and tooling behave correctly?
4. if blocked, treat the run as blocker evidence, not model evidence
5. if clean, answer only the question that run was commissioned to answer
6. update the linked issue entries and write the next run entry

This is how we avoid using a broken or ambiguous run to "prove" a model
claim it was never capable of answering.

---

## Active line

- **Current line**: sparse-graph completion and defect isolation
- **Current priority**: get the blocked sparse graphs to complete
  honestly before returning to onset/sigma/slice-recovery analysis
- **Current blocker focus**: `diamond-*-2dim` under contention
  (`I-010`, `I-011`)
- **Next run goal**: verify that the second `I-010` stall-detector fix
  removes the false-positive retry loop, and cleanly separate detector
  behaviour from the underlying slow-posterior problem in `I-011`

---

## Run log

### Run entry template

```markdown
### R-XXX — [short label]
**Status**: planned | running | returned | blocked | analysed
**Date**: d-MMM-yy
**Run / plan**: [run-id, plan name, or targeted command]
**Related issues**: I-...

**Why this run exists**: ...
**Intended to prove**: ...
**Does not prove**: ...
**Blocker check first**: ...

**Outcome**: pending | [short result]
**Next action**: ...
```

### R-001 — Initial sparse regression (`r1776733951`)
**Status**: analysed
**Date**: 22-Apr-26
**Run / plan**: broad sparse regression across 41 graphs
**Related issues**: `I-001`-`I-010`

**Why this run exists**: first broad pass to surface the major defect
clusters in sparse and sparse-adjacent graphs.
**Intended to prove**: which severe defect families exist and therefore
need prioritisation.
**Does not prove**: any specific root cause, or that the observed bias
patterns are stable model defects; parser and tooling contamination were
still possible.
**Blocker check first**: parser integrity, harness completion, timeout
classification, and stall-detector behaviour.

**Outcome**: surfaced the parser artifact (`I-001`), the arviz race
(`I-008`), timeout misclassification (`I-009`), the stall-detector defect
(`I-010`), and the broad onset/sigma/convergence observations
(`I-002`-`I-007`).
**Next action**: fix the clear blockers and artifacts, then rerun before
forming stronger model claims.

### R-002 — Post-parser / infra rerun (`r1776814894`)
**Status**: analysed
**Date**: 22-Apr-26
**Run / plan**: same sparse scope after the parser and infrastructure
fixes
**Related issues**: `I-001`, `I-010`, `I-011`

**Why this run exists**: separate real sparse/model defects from the
parser and tooling artifacts found in `R-001`.
**Intended to prove**: which serious defects survive once the obvious
artifact and harness failures are removed.
**Does not prove**: that the sparse matrix is now completion-stable;
`diamond-*-2dim` remained blocked by the completion path.
**Blocker check first**: completion and stall behaviour on the
`diamond-*-2dim` set.

**Outcome**: `I-001` verified fixed; `I-010` regressed into a narrower
detector problem; `I-011` diagnosed as a genuine slow-posterior geometry
issue.
**Next action**: rerun the blocked `diamond-*-2dim` set after the second
`I-010` fix before resuming onset/sigma/slice-recovery analysis.

### R-003 — Pending blocker retest for `diamond-*-2dim`
**Status**: planned
**Date**: 22-Apr-26
**Run / plan**: targeted rerun of the previously failing
`diamond-*-2dim` graphs at `max_parallel=2`
**Related issues**: `I-010`, `I-011`

**Why this run exists**: determine whether the second `I-010`
stall-detector fix removed the false-positive retry loop under
contention.
**Intended to prove**: whether the remaining failure mode is still
detector misclassification, or honest slow completion from `I-011`.
**Does not prove**: anything about onset bias (`I-002`), sigma bias
(`I-003`), missing slice recovery (`I-007`), or the broader sparse
matrix.
**Blocker check first**: does the graph now complete honestly, or at
least time out honestly, rather than cycling through stall retries?

**Outcome**: pending
**Next action**: if clean, return to the broader sparse systematic issues;
if blocked, keep all effort on the completion path.

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

```markdown
## I-NNN — [short title]
**State**: hypothesis | diagnosed | designed | implemented | verified | resolved | rejected | deferred
**Updated**: d-MMM-yy
**Owner**: [name or "unclaimed"]
**Severity**: blocker | quality | paper-cut

### Evidence
- Observation 1 with pointer (run ID, file:line, metric value)
- Observation 2 …

### Hypotheses
- **H1** (rejected d-MMM-yy): [hypothesis]. Falsified by: [evidence against].
- **H2** (current): [hypothesis]. Supporting: [evidence for].

### Diagnosis (when state ≥ diagnosed)
[What we now know is the root cause, in one paragraph.]

### Design (when state ≥ designed)
[Proposed fix approach, one paragraph.]

### Implementation (when state ≥ implemented)
Commit / files: [hash + paths]. Scope of change: [lines].

### Verification (when state = verified/resolved)
Regression run [run-id], result: [specific metric that cleared].
```

---

## I-001 — Anchor→first-hop p biased toward 1.0 (parser artifact)
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
- Regression run r1776733951: six outlier edges with |z|>50, all on
  anchor→first-hop edges, all biased toward 1.0:
  - diamond-lifecycle-sparse anchor-to-gate: truth=0.85 post=0.982 z=132
  - diamond-sparse-2-hicard anchor-to-gate: truth=0.85 post=0.984 z=134
  - fanout-sparse-4 anchor-to-gate: truth=0.80 post=0.966 z=55
  - abc-lifecycle-sparse a-to-b: truth=0.70 post=0.856 z=52
- Cross-graph pattern check: in every affected graph, `edge.p.posterior_mean`
  exactly matched one specific slice's posterior_mean, and that slice was
  always the alphabetically last slice with data.

### Hypotheses
- **H1** (rejected 22-Apr-26): `failure_rate` in synth_gen drops only the
  first-hop observation but not the anchor denominator, so p_hat ≈ 1−failure.
  *Falsified by*: `synth_gen.py:2104` shows failure_rate drops entire
  fetch nights (`continue` skips the whole day loop). No per-user asymmetry
  possible.
- **H2** (partially supported): truth comparison uses base edge `p` but
  model estimates a hierarchical mean on logit scale, so the two are
  structurally different when slices have per-edge multipliers. Computed
  effective logit means match posteriors within ~0.03–0.11 for the
  outliers, but are still systematically lower than reported `post`.
- **H3** (partially supported): per-slice multipliers like google p_mult=1.20
  push `0.85 × 1.20 = 1.02` near the clip, so logit averaging pulls the
  hierarchical mean toward the extreme-p slice. Explains the residual in
  H2's numbers.
- **H4** (current, diagnosed): the harness parser's regex for
  `window(): p=...` lacks a start-of-line anchor, so per-slice lines like
  `context(...).window(): p=...` also match and overwrite the aggregate
  `p_mean`. Last match wins → alphabetically last slice. Confirmed by
  harness log for diamond-sparse-3 anchor-to-gate showing aggregate
  window() p=0.8911, but JSON reporting post=0.689 (= email slice p).

### Diagnosis
`bayes/param_recovery.py` has four parser regex sites (lines 493, 510,
575, 591) that match `window(): p=...` / `cohort(): p=...` anywhere in
a line. Per-slice lines `context(…).window(): p=…` contain those
substrings, so each per-slice line overwrites the aggregate value.
Since slices print in sorted order, the last (alphabetically greatest)
slice wins. All downstream regression summaries compare the base truth
against the wrong posterior.

### Design
Anchor each regex to start-of-line (with leading whitespace) and switch
from `re.search` to `re.match` for clarity. Four one-line changes, no
semantic change beyond rejecting the contaminating matches.

### Implementation
Edits applied to `bayes/param_recovery.py`:
- Line 493: first `window()` regex — anchored.
- Line 510: first `cohort()` regex — anchored.
- Line 575: second `window()` regex — anchored.
- Line 591: second `cohort()` regex — anchored.

### Verification
Run r1776814894 (same scope, 41 graphs, parser fix applied):
- Prior run edge-level `p` max |z| = 134 (anchor-to-gate outliers)
  → new run **max |z| = 8.3**
- Prior run aggregate `p` mean |z| = 10.67 → new run **mean |z| = 2.49**
- The extreme-outlier cluster on anchor-to-first-hop edges is gone.

The "systematic upward bias on p" narrative collapsed once the parser
was fixed — it was almost entirely artifact. H2/H3 (base-truth-vs-
logit-mean, clipped-slice logit averaging) may still contribute a small
bias but is no longer load-bearing. No follow-up issue opened.

---

## I-002 — `onset` parameter +0.65d bias across all edges
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
Run r1776733951, across 106 edge-level onset failures:
- Mean bias +0.654 days (absolute)
- 103 of 106 (97%) are positive — near-universal upward
- Max |z|=7.5; not the most-extreme parameter but by far the most consistent

### Hypotheses
- None yet. Candidates to consider: a one-sided prior pulling onset
  upward; onset estimator accumulating travel time from upstream edges
  that isn't being subtracted; synth-gen populating onset differently
  from what the compiler expects; softplus floor behaviour on small
  ages.

### Note
This issue may interact with I-001 in so far as the parser was also
used to extract onset; re-run after parser fix needed before firming up
hypotheses. Current bias magnitude measurement is from pre-fix JSON.

---

## I-003 — `sigma` 100% positive bias
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: paper-cut

### Evidence
6 of 6 sigma failures in r1776733951 are positive, mean +0.285. Small
n relative to onset, but the direction is perfectly one-sided.

### Hypotheses
- None yet. Candidates: prior on log-sigma biased positive; latency
  reparam scaling; shared-sigma-slices interacting with small-N slices.

---

## I-004 — Only 10 of 41 graphs have clean convergence
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
In r1776733951: 31 of 41 graphs had at least one of rhat / ESS /
converged_pct failures. Breakdown:
- 16 × ESS+converged_pct only
- 8 × rhat+ESS+converged_pct
- 5 × ESS only
- 2 × converged_pct only
- 10 clean

### Hypotheses
- None yet. May be secondary — many of the 31 have large point-estimate
  biases, so convergence failure could be a symptom of a misspecified
  target rather than a primary issue.

---

## I-005 — Orth 2-dim graphs: clean point estimates, weak convergence
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
Tier T1 (8 `*-2dim` graphs) in r1776733951: median max |z| = 9.3 (best
of all tiers), but max rhat = 1.463 (worst of all tiers).

### Hypotheses
- None yet. Possibility: two-dim contexted graphs have a wider posterior
  in one direction (e.g. non-identifiable interaction between dims)
  that shows as rhat drift without distorting the marginal means.

---

## I-006 — Single-dim lifecycle has worst single outlier (z=132)
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
diamond-lifecycle-sparse max |z| = 132 in r1776733951. Same graph's
Tier-4 orth-context variant (abc-lifecycle-sparse-2dim) max |z| = 8.8.
Counter-intuitive: orth + lifecycle *cleaner* than lifecycle alone.

### Note
May be entirely an I-001 parser artifact — diamond-lifecycle-sparse is
exactly the shape where clipping interacts most with the parser bug.
Re-run after I-001 fix before forming hypotheses.

---

## I-007 — Missing slice recovery rows on 3 legacy context graphs
**State**: observed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality

### Evidence
13 declared slice entries had no posterior rows in r1776733951:
- diamond-context-sparse: 6 missing
- skip-context-sparse: 4 missing
- context-two-dim-sparse: 3 missing

All three are legacy context graphs; Tier 1–4 additions don't exhibit
the defect.

### Hypotheses
- None yet. Candidates: slice is declared in evidence but model.py
  emits no posterior var (prior-only); or `_parse_slice_posteriors`
  regex doesn't match for these specific edge/slice combinations.

---

## I-008 — arviz daily-warning race on max_parallel ≥ 2
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: blocker (caused one graph to never complete)

### Evidence
`diamond-lifecycle-sparse-2dim` in r1776733951: harness exit 1 at 369ms,
before any MCMC. Trace:
```
FileNotFoundError: '/home/reg/.cache/arviz/daily_warning.tmp'
  -> '/home/reg/.cache/arviz/daily_warning'
```
Root-caused: `arviz/__init__.py::_warn_once_per_day` does a non-atomic
tmp→final rename; two parallel workers both create the same tmp file,
one renames it first, the other errors.

### Implementation
Added `_prime_arviz_daily_warning()` to `bayes/run_regression.py`
(invoked before `ProcessPoolExecutor` fans out). Writes today's ISO
date to the arviz cache stamp file; each worker then finds
`last_date == today` and skips the write path entirely.

### Verification
Run r1776814894: `diamond-lifecycle-sparse-2dim` now compiles and enters
sampling (runs for 3616s). No FileNotFoundError anywhere in the 82 log
files. The graph still fails, but for a different reason (chain stall,
see I-011) — the arviz race is gone.

---

## I-009 — Timeout→SIGSEGV (ungraceful SIGTERM of nutpie native threads)
**State**: verified
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality (misclassification — graph exited, but as HARNESS FAIL)

### Evidence
`synth-abc-sparse-1` in r1776733951: TIMEOUT at 1505s, harness exit 1,
faulthandler log captured 10 KB SIGSEGV trace with `<no Python frame>`.
Chain 1 was CRAWLing at 0.4 draws/s at the time of timeout; SIGTERM
landed mid-matrix-op in native code, producing the collateral SIGSEGV.

### Implementation
- `bayes/test_harness.py:1007–1013`: SIGTERM first, `sleep 1.0`, then
  SIGKILL stragglers (grace period). Exit code 124 (standard timeout)
  instead of 1.
- `bayes/run_regression.py:~1142`: exit 124 now mapped to
  `type="timeout"` in `make_failure`, with the log entry `TIMEOUT (exit
  124)` instead of `HARNESS FAIL`.

### Verification
Run r1776814894: `synth-abc-sparse-1` completed cleanly with retuned
stall detector catching the crawl early enough for one retry to
succeed. No timeout fired, no fault-log. Timeout exit-code path and
grace-period SIGTERM/SIGKILL sequence not exercised in this run because
nothing actually timed out.

---

## I-010 — Stall detector cycles on chain at 15–20% of peak
**State**: regressed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: quality (cause of I-009's root cause — stuck chain never aborted)

### Evidence
abc-sparse-1 chain 1 log (r1776733951): CRAWL ENTERED ↔ CRAWL RECOVERED
cycled every ~2 seconds for minutes without ever firing STALL CONFIRMED.
Chain actual throughput ~0.5 draws/s (11 % of peak 4.4). Entry
threshold was 0.10 × peak = 0.44 draws/s; short bursts to 1.0 draws/s
crossed the threshold and reset the 30 s grace timer.

### Diagnosis
Three compounding issues in `bayes/compiler/inference.py`
`ChainStallDetector`:
1. `crawl_ratio = 0.10` — entry threshold too tight. Chains trapped at
   15–20 % of peak (clearly pathological) were below the detector's
   sensitivity.
2. No hysteresis — entry and exit used the same threshold, so a single
   burst above 10 % reset the timer.
3. `rate_window_s = 5` — rate estimate too noisy; single-draw bursts
   flipped state per-update.

### Implementation
`bayes/compiler/inference.py:56–129`:
- `crawl_ratio` default 0.10 → 0.25
- New `recover_ratio = 0.50` (hysteresis)
- `rate_window_s` default 5 → 15
- Restructured `update()` to branch on `currently_crawling`: uses
  entry threshold only when not crawling, exit threshold only when
  crawling.
- Docstring tuning-history appended with abc-sparse-1 anchor.

### Verification (regressed 22-Apr-26)
Run r1776814894 surfaced the 5 diamond-*-2dim "failures" that I
initially tracked as I-011 "unsamplable posterior". Investigation of
I-011 revealed the detector itself was the problem, not the
posteriors:

- Repro test at base settings running alone (no parallel): graph
  completed in ~18 min, 0 stall retries.
- User observation of live detector log: CRAWL ENTERED/RECOVERED
  cycling every ~2s on a chain with peak=2.9 and rate=2.4 — healthy
  sampling, but detector oscillating.
- Root cause: `peak < crawl_floor` entry escape clause fires
  indiscriminately on slow models; hysteresis-based exit
  (`rate >= recover_ratio × peak`) fires at rate ≈ 0.5 × 2.9 = 1.45
  — much lower than entry threshold. Chain at rate 2.4 satisfies
  exit immediately → oscillation.
- Under CPU contention (max_parallel=2, JAX fan-out halving
  throughput): peak drops further, grace timer accumulates without
  exit → STALL CONFIRMED fires legitimately on a slow-but-healthy
  chain → 20× retries each at different seeds → "Chain stall
  persisted" RuntimeError.

### Second fix (22-Apr-26)
`bayes/compiler/inference.py:134-146` — removed the `peak <
crawl_floor` entry escape clause. Entry now requires `peak >=
crawl_floor`; `warmup_s` is the sole guard for "chain never sped
up". Entry/exit now logically symmetric for slow-model case.
Docstring tuning-history appended with 22-Apr-26 entry explaining
the oscillation and diamond-*-2dim false-positive context.

Note: this fix addresses the **symptom** (false-positive termination
under contention). The **underlying cause** is I-011 — a pathologically
slow posterior. Fixing I-011 via reparam should obviate the need for
the detector to work around slow posteriors.

### Verification (pending for second fix)
Re-run a previously-failing graph (e.g. `diamond-sparse-1-2dim`)
with max_parallel=2 alongside another graph. Should either complete
honestly (in a long wall-clock time) or hit wall-clock timeout — not
enter the stall retry loop.

---

# Workstreams

A workstream is a multi-step investigation tied to one or more issues.
Each phase names explicit success criteria and a CPU budget so phases
can be authorised separately under Gate 5.

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

---

## I-011 — Diamond orth-context graphs have pathologically slow posterior
**State**: diagnosed
**Updated**: 22-Apr-26
**Owner**: unclaimed
**Severity**: blocker (unable to complete under parallel load; completes very slowly alone)

### Evidence
Run r1776814894 (post-fix): all five `synth-diamond-*-2dim` graphs
fail with `RuntimeError: Chain stall persisted after 20 retries`.
Stall rates: 0.13–0.79 draws/s; chain alternates between chain 0 and
chain 1 across the 20 retries. Affected:
- diamond-lifecycle-sparse-2dim
- diamond-sparse-1-2dim
- diamond-sparse-2-2dim
- diamond-sparse-3-2dim
- diamond-sparse-4-2dim

In the prior run (r1776733951, pre-fix detector) these four graphs
appeared to "complete" — but with rhat/ESS patterns that in hindsight
indicate the same stall pathology; the detector just never fired.

Retry-log inspection for diamond-sparse-2-2dim confirmed per-attempt
chain divergence (draw counts [72,58], [100,48], [43,33], [180,122],
[31,46], [33,58], [168,166], [85,49], [58,91], [61,37] across 10
attempts). Each retry does get fresh randomness from nutpie's
entropy-based seeding when `config.random_seed=None`.

### Hypotheses
- **H1** (rejected 22-Apr-26): retry doesn't actually freshen the seed;
  `sampling_config.random_seed` is never mutated between retries, so
  all 20 retries produce the identical stall. *Falsified by*: retry
  log shows divergent per-attempt chain counts (different chains
  stalling first, different draw positions). nutpie's sample() with
  `seed=None` auto-seeds from system entropy each call.
- **H2** (current): posterior geometry in diamond × orth-2-dim ×
  branch-group is genuinely pathological. The Section 6 branch-group
  Dirichlet-Multinomial × per-slice p × per-slice latency × second
  context dim generates a posterior with strong correlation, funnel
  shape, or multi-modality that NUTS cannot navigate from any init.
  Supporting: 20 independent random starts, all stall.

### Note
All five affected graphs are **diamond** topology. abc × orth 2-dim
completes fine. The common factor is branch-group + orth context —
suggests the Section 6 branch-group per-slice Multinomial rewrite
(f1f464c9) needs reparameterisation when a second context dimension
is added.

Candidate diagnostic next step: dump the compiled PyMC model for one
affected graph and inspect the posterior correlations / condition
number / divergence pattern, to confirm funnel vs multi-modal vs
correlation pathology before designing a fix.

See **Workstream W-011** below for the investigation plan.

### Diagnosis (22-Apr-26, corrected)
Reproducibility test at base settings alone completed in **2261s
(~38 min)**, average **1.3 draws/s** across both chains — against a
healthy ~10-20 draws/s for comparable graphs. The chain was crawling
continuously throughout the run; the stall detector oscillated but
never escalated to STALL CONFIRMED because RECOVERED flicks kept
resetting the grace timer. Under CPU contention, the oscillation
stops (chain rates drop low enough to stop bobbling above the exit
threshold), grace accumulates, STALL CONFIRMED fires legitimately on
a slow-but-sampling chain, retries churn 20× — that's the regression
failure mode.

Posterior correlations from the completed run confirm the coupling:
- `corr(onset, mu)` = 0.86-0.94 across latency edges — classic
  shifted-lognormal redundancy: onset and mu both shift the CDF
  position, producing a diagonal posterior ridge.
- `corr(m, a)` = -0.97 on gate-to-path-b and path-b-to-join — strong
  anticorrelation in the reparam block.

**Hypothesis outcomes**:
- H1 (retry doesn't freshen seed): **rejected** (nutpie seed=None
  auto-entropy works; per-attempt chain divergence confirmed).
- H2 (posterior pathology — slow sampling): **confirmed**. Completes
  alone at 1.3 draws/s (10× slower than healthy). Correlations
  explain why — narrow ridge traps the sampler into tiny steps.
- H3 (CPU contention triggers detector): **confirmed as trigger of
  observed failure**, but the UNDERLYING cause is H2 — a fast-enough
  sampler wouldn't drop below the floor under contention. The
  detector fix (I-010 second pass) addresses the false-positive
  termination symptom only.

The real fix is a model-side reparameterisation to break the
onset↔mu ridge. See W-011 Phase C.
