# Doc 20 — Open Issues Register (Bayes Regression)

**Status**: Open
**Started**: 22-Apr-26
**Purpose**: Track issues surfaced by the sparseness regression (and its
offspring) from hypothesis through to resolution, with the falsified
hypotheses recorded so we don't re-propose dead ends.

Complements:
- `18-compiler-journal.md` — chronological dev journal
- `19-be-stats-engine-bugs.md` — narrow stats-engine bug records

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
**State**: implemented (verification pending on re-run)
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

### Verification (pending)
Re-run the extended sparse regression. Success criteria: for
diamond-sparse-3 anchor-to-gate, `post` should land near 0.891
(harness-log aggregate window p), with z-score in single digits. The
current 0.689 value should disappear.

**Corollary**: once parser fixed, the "systematic upward bias on p"
narrative needs revisiting. H2/H3 may still contribute a small structural
mismatch; that becomes a separate issue if it persists after H4 is fixed.

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
**State**: implemented (verification pending)
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

### Verification (pending)
Re-run regression — `diamond-lifecycle-sparse-2dim` should compile and
enter sampling rather than dying at 369ms.

---

## I-009 — Timeout→SIGSEGV (ungraceful SIGTERM of nutpie native threads)
**State**: implemented (verification pending)
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

### Verification (pending)
Re-run. abc-sparse-1 (or any other crawl-prone graph) should produce a
clean TIMEOUT verdict and no fault-log noise.

---

## I-010 — Stall detector cycles on chain at 15–20% of peak
**State**: implemented (verification pending)
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

### Verification (pending)
Re-run. abc-sparse-1 chain 1 should either recover (if it's a real hard
region that resolves) or hit STALL CONFIRMED → ChainStallError →
worker.py retry logic kicks in (up to 3 retries). No silent timeout
from a detector that never fired.
