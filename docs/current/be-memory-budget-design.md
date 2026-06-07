# BE Memory Budget: staying under a deployment-defined ceiling

**Status**: Design proposal — step 1 (concurrency gate) landed; steps 2-3 (capacity-derived budget, cohort batching, degradation rungs) still designed only
**Date**: 7-Jun-26
**Scope**: how the Python backend keeps total instance memory under a deployment-defined ceiling `x` (GB), for the cohort-maturity / conditioned-forecast compute path. Builds on the cross-request `ResultCache` leak fix (already landed) and the cohort-axis batching analysis.

**Implementation status (7-Jun-26):**
- **Landed:** the cross-request `ResultCache` leak fix; the **process-global concurrency gate** (`lib/concurrency_gate.py`, single-flight by default via `DAGNET_MAX_CONCURRENCY`, reentrant per request, busy→503 via `DAGNET_GATE_TIMEOUT_S`) wired into both `handle_runner_analyze` and `handle_conditioned_forecast`; per-request cache flush + `malloc_trim` on gate exit. Measured effect: in-process repeated cohort-maturity calls now sit flat at ~260 MB resident (was ~900 MB pre-trim, ~4 GB pre-fix). Tested in `lib/tests/test_concurrency_gate.py` (cap, single-flight, timeout, release-on-error, reentrancy, cleanup).
- **Not yet built (designed below):** cgroup capacity resolution (§8 "Determining box capacity"); deriving and binding the per-request budget; the K-solver and cohort-chunk batching (the two exact levers, §5); the S/C degradation rungs (§6). These are the "capable" half — needed only when a single request's *own* peak still exceeds the budget.

This doc is reasoning and design, not an implementation plan with code. Figures are measured in-process against a real captured `cohort_maturity` request (C=31 cohorts, T≈38, mc_draws 500 and 1000) unless stated otherwise.

---

## 1. The problem, reframed by measurement

The intuition was "peak is `O(C·S·T)`, so batch cohorts." Measurement sharpens this into something more actionable and more alarming:

- **Base footprint is negligible.** A fresh process, after importing the handler and runner but before any request, sits at ~45 MB (~57 MB warm). The import graph adds ~34 MB over a bare interpreter. Base does not scale with concurrency or draws. It is *not* the problem.
- **A single request nearly exhausts a Hobby instance.** One `cohort_maturity` call at mc_draws=1000 peaks (VmHWM) at ~2.05 GB for this modest C=31 query — already at the 2 GB Hobby ceiling, before any concurrency.
- **Peak is overwhelmingly draw-driven, and scales with both S and C.** The portable law is `peak(S) ≈ 2.0 MB · S + ~0.09 GB` at this C, T. Empirically the whole-request peak is ~220× a single `(C,S,T)` float64 tensor — an order of magnitude more than the ~15-20 tensors the FC-assembly block alone holds, because the peak is the *union* across three DSL hops (each running primitive-conditioning → span-composition → continuation-DP), plus a second full-C array set (the `date_axis_projection` scatter feeding the date and scalar reducers). Do **not** model per-request memory as one FC block — it is ~1/12 of the truth.
- **What looks like a leak after a call is glibc arena retention, not a leak.** After one call + GC, RSS sat ~845 MB above base with *zero* live numpy arrays; `malloc_trim(0)` reclaimed it instantly back to ~94 MB. Across six repeated calls VmHWM stayed flat (~2.1 GB) and RSS stabilised at a fragmented ceiling rather than climbing — confirming the cache-leak fix holds, and identifying a near-free concurrency win (trim between requests).

The decisive deployment fact:

- **Vercel Fluid co-locates multiple invocations in one process sharing one memory pool, and the concurrency is Vercel-managed with no user-settable cap.** Memory is per-instance, not per-invocation. An out-of-memory condition crashes the shared process and takes sibling invocations down with it — Vercel's error isolation covers Node exceptions, not OS OOM. So the worst case is `N × per-request-peak`, and `N` is not ours to bound through any Vercel setting.

The direct consequence, and the spine of this design: **a per-request byte budget bounds one summand, never the sum. To make `x` a guarantee, the backend must enforce its own concurrency bound.**

---

## 2. The memory model

Total instance resident memory decomposes as:

> `RSS_instance = base_static + Σ(over k in-flight requests) per_request_working_set + allocator_headroom`

- **`base_static`** ≈ 60 MB (use the warm figure). Loaded once per process, shared by all co-located invocations. An irreducible floor; small but real on Hobby.
- **`per_request_working_set`** must be accounted against the request's *peak* (its VmHWM contribution), not its live RSS, because the driver is transient numpy/glibc temporaries during the FC-assembly and reducer pipeline, not retained objects. The peak follows the scaling law above and is the union across the whole request, not a single block.
- **`allocator_headroom`** is glibc arenas held between free and the next peak. Under concurrency, request A's fragmented residue is still resident while request B peaks. Reserve an explicit fraction of `x` for this (≈20%), and call `malloc_trim(0)` in the per-request cleanup so arenas return to the OS between requests, lowering the baseline a co-located sibling sees.

---

## 3. The budget identity

The contract to honour is:

> `base_static + k_max · per_request_peak + headroom_reserve ≤ x`

Solving for the per-request allowance:

> `per_request_budget = (x − base_static − headroom_reserve) / k_max`

where `k_max` is the **self-enforced** in-process concurrency bound (ours, not Vercel's), and `headroom_reserve ≈ 0.2·x`. The **default is `k_max = 1`** (single-flight — see §4), which gives each request the full `x − base − reserve` with no division.

Worked examples:
- **Pro/Ent, x = 4 GB, single-flight**: per-request budget ≈ 4 − 0.06 − 0.8 ≈ **3.1 GB** — comfortably runs default mc_draws=1000 on normal queries; chunking is then only needed for genuinely large cohort counts. (Opt into `k_max = 2` as a throughput knob and each co-resident request gets ≈ 1.57 GB instead.)
- **Hobby, x = 2 GB**: forced to single-flight anyway (a single default request already peaks at ~2 GB). Per-request budget ≈ 1.64 GB, which by the scaling law caps S at ~780 draws — **Hobby cannot run the default mc_draws=1000 safely and must degrade S**, even with no concurrency.

The per-request budget is the single number that drives both the exact lever (cohort chunk size, holding S fixed) and the approximate lever (reducing S).

---

## 4. The concurrency gate (the crux)

Because Vercel exposes no in-instance concurrency knob and an OOM crashes the shared process, the only path to a hard ceiling is a **process-global admission gate** in the backend:

Tracking active concurrency requires separating **enforcement** from **observation** — a counter you read cannot enforce a limit (two requests both read "k−1 in flight" and both admit → the ceiling is breached). So:

- **Enforcement (authoritative): a module-global `threading.BoundedSemaphore(k_max)`.** `acquire()` at request entry atomically takes a permit or blocks; `release()` in the same `finally` that runs the per-request cache flush and `malloc_trim`. The count of held permits *is* the active concurrency, exact and race-free by construction — there is no read-then-decide window. This is the only thing that makes "≤ k_max" a guarantee. `threading` (not asyncio) because the compute is sync CPU-bound and the dev FastAPI path already runs it in a threadpool; module-global so all co-located Fluid invocations in the one shared process contend on the same instance.
- **Observation (advisory): the existing `_ACTIVE` registry in `request_telemetry.py`.** A self-healing, TTL-swept dict under a lock carrying per-request detail (boot id, mc_draws, …) for logs/metrics; `len(_ACTIVE)` is a readable live count. This is what the OOM telemetry already uses, and what the *adaptive* budget regime (below) would read for `live_inflight` — but it is never the enforcement source. The semaphore acquire/release brackets the same scope as the registry's enter/exit, so the two counts agree; when they must disagree, the semaphore wins.
- **Release safety.** The `finally` covers normal completion and exceptions. The one gap is a hard kill mid-flight (e.g. a 300s SIGKILL) where `finally` does not run and a permit leaks — under single-flight that wedges the instance. Mitigate with a bounded `acquire(timeout=…)` and by relying on Vercel taking the process down on timeout; the registry's TTL self-heal repairs the *observability* count but not the semaphore, so release-safety is the semaphore's own concern, not the registry's.

Two regimes:
1. **Fixed bounded `k`** — admit up to `k_max` concurrently, each budgeted to `(x − base − reserve)/k_max`; the surplus blocks. Cleanest provable ceiling.
2. **Adaptive co-location** — at admission, size each request to the *actual* contention: `per_request_budget = (x − base − reserve)/max(1, live_inflight)`. Less wasteful, but races on the in-flight count changing after admission, so it must keep a hard `k_max` as a backstop.

Recommendation: **single-flight (`k_max = 1`) by default.** This is the cleanest hard ceiling: only one heavy working set is ever live, so the concurrency-OOM — the actual prod failure mode — is eliminated outright, and each request gets the *full* budget (`per_request_budget = x − base − headroom`, no division). The earlier worry that serialising risks the 300s timeout was a confusion of signals: the 300s timeouts seen in prod were a *symptom* of the memory pathology (allocation pressure → GC/arena thrash and CPU starvation under co-location), not legitimate compute duration. A legitimate request runs in a few seconds, and the concurrency of an internal modelling tool is low, so a queued request waits a few seconds — nowhere near 300s. The 300s cap is a backstop against pathology, not a budget that queueing eats into. `k_max > 1` is therefore a pure *throughput* optimisation to opt into only on a plan with spare headroom (e.g. Pro/Ent at 4 GB), never a timeout-avoidance necessity; if used, each co-resident request is budgeted to `(x − base − reserve)/k_max`.

The cache-leak fix is a prerequisite here: because working set is released per request, the gate's accounting stays accurate — a finished request genuinely frees its claim.

---

## 5. Reducing the per-request peak: the two exact levers

To make a request fit its budget without changing results, two structural changes (verified exact against the code):

**Lever A — chunk the cohort axis.** Cohorts are the only exactly-chunkable axis: every cross-cohort step is an additive reduction (`sum(axis=0)`) followed by a deferred division. Run the FC-assembly block, the scatter, and the downstream reducers inside a loop over cohort chunks of size `K`, accumulating numerator and denominator sums separately and dividing **once** at the end. This is the "sum-first / divide-once" invariant the code already flags. Peak transient drops from `O(C·S·T)` to `O(K·S·T)`. The chunk loop must wrap the single existing projection call and **reuse the one already-built runtime/spans** — it must not re-resolve the CF runtime per chunk (that would reintroduce the forbidden per-date sweep).

**Lever B — fold the reducers in, eliminating the second full-C set.** The biggest surprise from the measurement is that the FC block is only ~1/12 of the peak; a second full-C array set (the `date_axis_projection` scatter) and the three downstream reducers dominate. All of them are cohort-streamable:
- the cohort-maturity (tau) reducer reads only the `(S,T)` aggregates — a running sum;
- the scalar reducer's cross-cohort step is an N-weighted per-draw mean — streamable numerator/denominator `(S,)` sums divided once;
- the date reducer and the completeness vector are *per-cohort independent* — each row reads only its own cohort's slice and emits scalars;
- the scatter itself is a pure reorder with no maths — replaceable by an index map applied per chunk, so all-NaN slices for skipped cohorts are never allocated.

Folding these into the same cohort-chunk loop removes the second full-C set. The **irreducible remainder** is then not `O(C·S·T)` but `O(C·T)` strict evidence + `O(C)` scalar outputs + a *fixed* (~6) set of `(S,T)` accumulators — all small because T≈60 and the outputs are scalars. The costly S=1000 axis collapses to at most `K` coexisting cohort-slices. In short: **with both levers, the per-request peak can be driven below an arbitrary `x` by shrinking `K`, down to a small base floor.**

**The one open engineering risk** (the reason the floor-reducibility verdict was "partial, maths confirmed"): the FC-assembly DP that *builds* the `(C,S,T)` surfaces (`node_density` and the subject/Pop-C continuations) must be evaluable on a cohort *subset*, or its inputs sliceable before that call. The reducers and scatter are cleanly chunkable; the DP that produces the surfaces is where the real work sits. Cohort-separability is strongly suggested by the timing-span and frontier-residual kernels operating on flattened cohort×draw rows with no cross-cohort coupling, but it must be **proven before Lever A is buildable**.

---

## 6. The degradation ladder

When a request cannot fit its budget, walk this ladder in order — exact reductions first, then approximations that must carry provenance, then refusal. Never speculatively over-allocate, because an OOM crashes the shared instance.

1. **Shrink K (cohort chunk size).** *Exact* — bit-identical results (sum-first/divide-once; per-cohort-independent reducers). Cost is only wall-clock (more iterations). This absorbs almost all pressure.
2. **Fold reducers into the loop / drop the scatter.** *Exact* — pure reorder removed; structural prerequisite that makes K meaningful (otherwise the scatter re-materialises full-C regardless of K).
3. **Reduce S (mc_draws), with an explicit precision flag.** *Approximate* — fewer Monte Carlo draws widen and shift bands; S is not exactly chunkable. Stamp the response with the reduced draw count and reason. Hobby hits this rung for default S even single-flight.
4. **Cap / coarsen C, with provenance.** *Approximate* — the answer no longer covers all requested cohorts; lossy in coverage, not per-cohort precision. Stamp which cohorts were dropped/coarsened.
5. **Structured refusal.** If even the minimum viable shape exceeds the budget, return a precise error stating the requested `(C,S,T)`, the derived budget, `x`, and the current concurrency — strictly better than an OOM that kills co-located requests.

---

## 7. The chunk-size solver

Mirror the existing source-axis chunk solver pattern (`empirical_evidence_operator.py:803-821`): `K = per_request_budget_bytes // (M · 8 · S · T)`, clamped to `[1, C]`, holding S fixed (S is not chunkable). The per-cohort working unit is one `(1,S,T)` slice (~0.48 MB at S=1000, T=60).

`M` is the **conservative, empirically-measured** multiplier — not the hand-counted one. Hand-counting the FC block gives ~15-20; the measured whole-request multiplier is ~220×, because the peak spans three hops plus the scatter plus transient temporaries. Using the hand count would under-budget by ~12× and OOM. Set `M ≈ 230-260` (measured ~220 plus margin). Subtract the fixed cross-loop accumulators (a few MB) from the budget before solving. As the chunked pipeline matures and the *per-chunk* union is measured directly, `M` should be re-fit downward — today's ~220 reflects the un-chunked pipeline and will make the solver over-chunk (safe but slow) until re-measured.

---

## 8. Plumbing the deployment variable

Two values, read once at module import via the established environment idiom (as `DAGNET_COHORT_DEBUG` and `DB_CONNECTION` already are):
- **`DAGNET_MEMORY_BUDGET_GB`** — the configured box capacity (fallback / override; see "Determining box capacity" below). Default to the plan floor (2 GB).
- **`DAGNET_MAX_CONCURRENCY`** — `k_max`. Default to 1 (safe).

On Vercel these are dashboard env vars; in dev they come from `.env.local`. Separately, `vercel.json` should gain a functions block for the Python API pinning `memory` (so the *instance* is sized to match the capacity) and `maxDuration` — today it has neither and inherits plan defaults.

### Determining box capacity

The capacity is not guessed or probed-by-crashing — it is **read**, with a fallback to what is **configured**. Two layers, resolved once at startup:

1. **Read the real enforced ceiling from the OS (authoritative).** A serverless instance is a Linux container; the limit the kernel OOM-kills at is the cgroup memory limit: cgroup v2 `/sys/fs/cgroup/memory.max`, or cgroup v1 `/sys/fs/cgroup/memory/memory.limit_in_bytes`. This is ground truth and auto-adapts when the plan/memory setting changes. **Caveat to verify on the real Vercel runtime:** some serverless platforms report the *host* RAM here, not the function's limit (and cgroup v2 may report the literal `max`). A one-time check must confirm the read returns the expected 2/4 GB, not a host-sized number; if it proves unreliable, the configured env value is the source of truth.
2. **Cross-check against the configured value.** `vercel.json` function `memory` (and its mirror `DAGNET_MEMORY_BUDGET_GB`) is the capacity you explicitly chose. At startup take the **min of (cgroup read, configured value)** and log a warning if they disagree — this catches both an unreliable cgroup read and config drift.

The resolved `box_capacity` is then turned into the guard the rest of the system uses (per §3): `x_guard = box_capacity − base_static − headroom_reserve`. The estimator and gate budget against `x_guard`, never against the raw capacity, so a request is refused (or chunked harder) *before* the kernel OOM-kills — the reserve is the deliberate gap between our refuse line and the box's death line. (Throughout this doc, `x` denotes the resolved `box_capacity`; the `(x − base − reserve)` in §3's identity is exactly this guard derivation.)

The **derived per-request budget** rides the existing request-scoped settings contextvar — the cleanest plumbing point, because every engine site already reads current settings with no signature threading (this is exactly how mc_draws flows). Add a budget field to that settings object. At request entry, after acquiring the gate and reading the live in-flight count, compute the per-request budget and inject it via the same settings-override pattern already used to adjust mc_draws. The solver and any S-reduction then read the budget from the contextvar wherever the code currently reads the hardcoded 1 GiB constant, making that constant a default fallback only.

---

## 9. Enforcement: estimate is the contract, runtime check is insurance

- **Primary (the contract): an up-front analytical estimate.** Before allocating, compute the expected resident peak from the known `(C,S,T)`, the conservative `M`, and the chosen `K`, and verify it fits the per-request budget. If not, walk the ladder until it does — *before* doing heavy work. This is deterministic and prevents the allocation rather than reacting to it, which matters because an OOM on Fluid crashes siblings.
- **Backstop (defence in depth): a runtime RSS check** (the VmRSS/VmHWM helper already exists in the telemetry module), sampled at phase boundaries; if RSS approaches `x`, tighten `K` for remaining chunks or trip the structured-fail path early. Account against peak (VmHWM), not live RSS — temporaries and arena retention make live RSS understate the true peak. This is best-effort: it cannot un-allocate an in-flight temporary.
- **Hygiene:** `malloc_trim(0)` in the per-request cleanup so freed arenas return to the OS between requests.

The guarantee rests on: *(admission gate bounds k)* × *(up-front estimate bounds each per-request peak ≤ budget)* → *Σ ≤ x*. The runtime check insures against estimate error and fragmentation drift.

---

## 10. Testing

Integration tests against the captured *real* request body (synthetic shapes miss the three-hop union that drives the ~220× multiplier):
- **Scaling-law regression** — assert per-request VmHWM stays within tolerance of `peak(S)` across S∈{500,1000}, fresh-process, so multiplier drift is caught.
- **Chunking exactness (HARD BLOCK — new code path)** — assert the chunked loop, with K across {1, small, full-C}, yields results bit-identical (within float tolerance) to the un-chunked path, proving sum-first/divide-once and the per-cohort-independent reducers preserve results.
- **Budget honouring** — with the env vars set, assert the solver picks a K whose measured peak ≤ derived budget, and that the ladder rungs fire in order as the budget is squeezed, each approximate rung stamping its provenance flag.
- **Concurrency ceiling** — simulate `k_max+1` concurrent requests (the dev threadpool path makes this testable) and assert the gate blocks the surplus and combined VmHWM stays under `x`.
- **Fragmentation/leak guard** — repeat the request six times in one process; assert VmHWM does not accumulate and (with trim wired) RSS returns toward base.

Never truncate test output.

---

## 11. Honest limits

- **`base_static` (~60 MB) is irreducible** and carried once per co-located process. Small, but every MB counts on Hobby.
- **Fragmentation headroom is real and not fully eliminable.** `malloc_trim` reclaims between requests, but overlapping peaks still carry one request's fragmented residue while another peaks. The ~20% reserve is a genuine claim on `x`, not pessimism.
- **Hobby cannot run default S=1000** even single-flight; it must degrade S.
- **The guarantee holds only under the shared-single-process co-location model** Vercel documents. If the platform ever places genuinely independent processes on one physical instance, a per-process gate bounds each process but not their sum — that case is best-effort, and is the load-bearing assumption to re-validate.
- **The lowest ladder rungs are approximate by construction.** Once S is reduced or C capped, only honest provenance is preserved, not precision.
- **`M ≈ 230` is an upper bound for today's un-chunked pipeline.** The solver will over-chunk (safe, slower) until `M` is re-measured against the chunked code.

---

## 12. Open decisions

- **Verify cgroup capacity-read on the real Vercel runtime** — confirm `/sys/fs/cgroup/memory.max` (or v1) returns the function's 2/4 GB limit, not host RAM or a literal `max`. If unreliable, demote layer 1 and treat the configured `DAGNET_MEMORY_BUDGET_GB` as the source of truth. This must be checked before the cgroup read is trusted as authoritative.
- Whether to ever raise `k_max` above the single-flight default at all. Single-flight is the recommended baseline (clean ceiling, full per-request budget, concurrency-OOM eliminated; queue waits are a few seconds given fast legitimate compute, so the 300s cap is irrelevant — it is a pathology backstop, not a queueing budget). `k_max > 1` is a throughput optimisation worth considering only on Pro/Ent with genuine concurrent demand and spare headroom; if adopted, fixed bounded `k` vs adaptive `(x−base−reserve)/live_inflight` (less waste, but races on the in-flight count changing post-admission).
- `headroom_reserve` fraction (~20%) — calibrated on the dev box; validate on the real Vercel runtime before treating as contract.
- Whether `DAGNET_MAX_CONCURRENCY` is set independently or derived from `x` and a target S — coupling risks surprise, decoupling risks inconsistent config.
- A planned re-measurement gate to re-fit `M` downward once chunking lands.
- **Proving cohort-subset evaluability of the FC-assembly DP** — the precondition for Lever A; the reducers/scatter are chunkable, but the surface-building DP must be confirmed sliceable per cohort.
- `vercel.json` functions block: pin Python-API `memory`/`maxDuration`, and whether to derive `DAGNET_MEMORY_BUDGET_GB` from the `memory` setting to keep them in lockstep.
- Whether `malloc_trim(0)` per request is net-beneficial on the Vercel glibc, or whether page re-faulting under high churn outweighs the reclaim — measure on the real runtime.

---

## Sequencing note

The exact levers (chunk K, fold reducers) and the concurrency gate are independent and complementary; the gate is the only thing that *guarantees* `x`, while the levers are what let a request *fit* its share. A sensible order: (1) land the concurrency gate + env plumbing + up-front estimate + `malloc_trim` — this alone converts silent OOM-crashes into structured refusals and bounds the instance; (2) prove cohort-subset evaluability, then land Lever B (fold/scatter removal) and Lever A (chunk loop) so requests can actually fit smaller budgets instead of being refused; (3) add the S/C degradation rungs with provenance. Step 1 makes the system *safe*; steps 2-3 make it *capable*.
