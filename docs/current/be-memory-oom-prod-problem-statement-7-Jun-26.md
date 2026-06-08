# Production OOM persists after cohort-axis chunking — problem statement

**Status**: Open. The cohort-axis chunking work (commit `9df2c30f2` "Memory fix") is deployed to production and a real `cohort_maturity` query still OOM-kills the instance. Cause **not yet established**.
**Date**: 7-Jun-26
**Companion**: `be-memory-budget-design.md` (the prior memory analysis — note its figures were measured on a *different* request; see "What is NOT established" below).

This document separates **what has been verified with direct evidence** from **what has been asserted but not established**. The latter section exists because the investigation up to this point repeatedly presented inference and second-hand figures as conclusions. Treat anything not in the "Verified" section as a hypothesis to test, not a fact.

---

## 1. Symptom

A production `cohort_maturity` analysis returns HTTP 500. The Vercel runtime log for the failed invocation reads, verbatim and reproducibly:

> `POST /api/runner/analyze  500  Vercel Runtime Error: instance was killed because it ran out of available memory`

This is an OS-level out-of-memory kill of the serverless instance, not an application error (the application would return a JSON error body; this returns a platform crash page, which the CLI surfaces as the generic "Analysis API unavailable (500)").

---

## 2. Verified facts (with how each was established)

1. **Prod OOMs on the test query at both `mc_draws=1000` and `mc_draws=2000`.** Established by driving the query against prod (command in §6) and reading the Vercel runtime logs (`vercel logs https://dagnet-nine.vercel.app`), which show the OOM kill line above for each run.

2. **The chunking code is deployed.** The Vercel logs contain `[mem-phase] … phase=install DONE wrapped=3/3 rss_mb=68` — the diagnostic probe installs at startup, proving the committed code is live. All four changed files (`runtime_memory.py`, `cohort_forecast_v3.py`, `cf_analysis.py`, `forecasting_settings.py`) are in commit `9df2c30f2`. Deployment `dpl_EBpg1KBUKqXhfUFBjXhT6ay9DAxM`, version `2.1.9-beta`, bundle `index-BKKfDB6G.js`, region `iad1`, plan `hobby`.

3. **The cohort-chunk loop bounds only the projection call; two full-cohort allocations sit outside it.** Verified by reading `graph-editor/lib/runner/cohort_forecast_v3.py:2489-2564`:
   - `_effective_chunk` is computed from `runtime_memory.projection_memory_budget_bytes()` and `current_rss_bytes()` when the AUTO sentinel is passed (`cohort_chunk_size <= _COHORT_CHUNK_AUTO`).
   - The chunk loop (`:2500-2519`) wraps only `model_span_spine.project_selected_cohort_rows`.
   - `_combine_selected_cohort_projections` (`:2520`) returns full `(C, S, T)` per-cohort arrays.
   - `_scatter_to_cohort_list` (`:2561-2564`) allocates `np.full((C_all,) + shape, nan)` per surface — sized by the total `cohort_list` length, **after** and outside the chunk loop.
   - Consequence that follows from the code structure alone (no measurement): the combine output and the scatter arrays are sized by total cohort count and are **not** reduced by the chunk size K. Whether either is the allocation that triggers the OOM is **not** established (see §3).

4. **The perimeter wiring routes a production request to the AUTO solver.** `cf_analysis.py` `prepare_cf_projection_bundle` resolves `cohort_chunk_size` to the AUTO sentinel when the request setting is 0 (the default) and no explicit chunk size was passed. (Verified by reading `cf_analysis.py` and `forecasting_settings.py`; the request setting defaults to `0.0`.) This means the solver *runs* on a production request — but what value it then computes on Vercel is not established (§3).

5. **On the dev box, auto-detection returns 31806 MiB** and the solver therefore does not chunk there. Established by running `runtime_memory._container_memory_limit_bytes()` in-process. (This is the *dev* box, not prod; it tells us nothing about what prod detects.)

6. **Unit tests and the outside-in oracle pass.** 70 unit tests (solver arithmetic, runtime_memory readers, separability, settings) and the oracle (56 passed, 1 xfailed). These prove the solver *arithmetic* and the *bit-identical* combine, not anything about the prod peak.

---

## 3. NOT established (open unknowns — previously asserted as fact, retracted)

- **Where on prod the memory is exhausted** (which phase: runtime build / span composition / projection / combine / scatter / reducer / evidence fetch). The probe's per-phase log lines do **not** appear in the Vercel logs — only the startup `install` line and the OOM error do. The OOM kill (SIGKILL) appears to destroy the request's buffered stdout, so reactive per-phase logging during the request is not recoverable.
- **Whether chunking engaged on prod, or what K it chose.** No visibility.
- **What memory ceiling `runtime_memory` detects on Vercel.** No visibility. The claim that it over-reads (returns host/micro-VM RAM rather than the function cap) is a **hypothesis**, not a measurement.
- **The function's configured memory size.** `vercel inspect` did not expose a memory field; `vercel.json` pins no `memory` for the Python function, so it inherits the plan default — value unconfirmed.
- **Whether the full-cohort combine/scatter allocations dominate the peak.** Their existence is verified (§2.3); their contribution to the peak is not measured for this query.
- **The "≈1/12 of the peak", "two full-C sets dominate", "Hobby cannot run default draws" figures.** These come from `be-memory-budget-design.md`, which measured a **different** request (C=31, T≈38, mc_draws 500/1000). They have **not** been confirmed for the query in §6 or for the current code. Do not carry them forward as established.

---

## 4. Reproduction is a constructed query, not the original failure

The original production failure was described only as "a cohort query with 1–30 May cohorts." Its exact shape — graph, from/to nodes, single- vs multi-hop, draw count — is **unknown**. The query used here (§6) was *constructed* to be heavy: the full funnel `from(household-created).to(switch-success)` on `conversion-flow-v2-recs-collapsed` (a multi-hop span) over a 30-day band. It does reproduce an OOM, but it may differ materially from the user's actual failing query (different span length, cohort count, or draw count). Confirm the real failing query before treating this reproduction as canonical.

---

## 5. Candidate hypotheses (UNVERIFIED — each with the evidence that would settle it)

- **H1 — Budget auto-detection returns too high on Vercel, so K = C and chunking never engages.** Settle by logging `projection_memory_budget_bytes()` and the chosen K at the chunk decision, emitted *before* the heavy allocation so it survives the kill.
- **H2 — Chunking engaged but the un-bounded combine + scatter full-cohort allocations (verified outside the loop, §2.3) still exceed the box.** Settle with per-phase peak-RSS markers logged before each phase's allocation.
- **H3 — The OOM is upstream of the projection** (runtime/span composition for the multi-hop span, or evidence fetch), which chunking does not touch. Settle with the same pre-allocation phase markers.
- **H4 — The box is smaller than assumed** (e.g. the Hobby default function memory is below 2 GB), so even a moderate request cannot fit. Settle by logging the detected cgroup limit / `/proc/meminfo` MemTotal / `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` at startup, and by reading the Vercel function memory setting.
- **H5 — Draw count too high for the box.** Settle by sweeping `mc_draws` against a known box size once H4 is answered.

These are not mutually exclusive.

---

## 6. Exact reproduction

```
PYTHON_API_URL=https://dagnet-nine.vercel.app \
  bash graph-ops/scripts/analyse.sh \
  conversion-flow-v2-recs-collapsed \
  "from(household-created).to(switch-success).cohort(1-May-26:30-May-26)" \
  --type cohort_maturity --mc-draws 1000 --no-cache
```

CLI result: `[cli] ERROR: Analysis API unavailable (500)`. Vercel log: the OOM line in §1. Both `--mc-draws 1000` and `--mc-draws 2000` reproduce it.

To read the prod logs: `cd graph-editor && npx vercel logs https://dagnet-nine.vercel.app --json` (returns only a small recent window — install lines and the OOM error; no per-phase trail).

---

## 7. The diagnostic gap, and the minimal next step

The OOM-kill destroys the request's logs, so any diagnostic must emit its data **before** the allocation that kills the process. The single highest-value next step is to log, at the chunk decision (before the projection allocates):
- the memory ceiling `runtime_memory` detected, and the raw cgroup / MemTotal / Lambda-env values it read;
- the resolved per-request budget and current RSS;
- the chosen K and the cohort count C.

If that line survives in the Vercel logs after the next deploy, it settles H1, H4, and partially H3/H5 at once. Without it, the cause cannot be determined from outside the instance and any claim about *why* prod OOMs is speculation.

A complementary step is to get the function's configured memory directly from the Vercel project settings / dashboard (it was not obtainable via `vercel inspect`).

---

## 7a. Accessing production telemetry — channels, commands, and their limits

**Where BE telemetry goes (verified by reading the code):** every telemetry line is written to **stdout** via `print(..., flush=True)`. There is **no persistent or DB-backed telemetry sink** — nothing survives the instance dying.
- `graph-editor/lib/request_telemetry.py` (added commit `2913bcda4` "Added BE telemetry"): a `request_telemetry(label=…)` context manager brackets `handle_runner_analyze` and `handle_conditioned_forecast` (`api_handlers.py:551`). It emits ENTER/EXIT markers carrying VmRSS/VmHWM and an in-flight count; a `mark(phase, **extra)` helper for mid-request phase markers; and a background **watchdog thread** that periodically snapshots in-flight requests (`_ACTIVE`) with their phase and memory. The watchdog is the only channel that emits *during* a long request rather than at its end.
- `graph-editor/lib/mem_phase_probe.py` (temporary, commit `9df2c30f2`): prints `[mem-phase]` lines per phase to stdout and *also* appends to a file (`_SINK`, default `/tmp/dagnet-mem-phase.log`, override `DAGNET_MEM_PHASE_LOG`). On Vercel `/tmp` is **ephemeral** and unretrievable; only the stdout copy reaches the logs. Disable with `DAGNET_MEM_PHASE_PROBE=0`.

**How to read prod stdout (verified):**
- The Vercel CLI is installed (`npx vercel`, v54.9.1) and authenticated (`npx vercel whoami` → `gjbm2`); the repo is linked via `graph-editor/.vercel/project.json` (project `prj_FOBcCJpHC5wDg4yubnhZcoXAxNJE`).
- `cd graph-editor && npx --no-install vercel logs https://dagnet-nine.vercel.app [--json]` returns recent runtime logs.

**Observed limitation (verified — this is the crux):** that command returned only a **sparse window** (~19 records spanning several minutes) containing only the cold-start `[mem-phase] install` line, `snapshots/health` hits, and the OOM error. It did **not** include the per-invocation `request_telemetry` ENTER marker or any per-phase line — even though the code emits them at request entry, before the OOM. So the non-follow `vercel logs` snapshot is lossy and does not surface in-request telemetry for the failing call. Combined with the OOM SIGKILL (which can drop the request's buffered stdout before Vercel's collector flushes it), there is at present **no demonstrated way to retrieve the pre-OOM phase trail**.

**Untested avenues to get the full / pre-OOM trail (NOT verified here — try these next):**
- `npx vercel logs https://dagnet-nine.vercel.app --follow` (live tail) started *before* reproducing, so each line streams as emitted rather than being sampled after the fact.
- Vercel dashboard → deployment `dpl_EBpg1KBUKqXhfUFBjXhT6ay9DAxM` → Runtime Logs, with a time filter around the reproduction.
- A Vercel **log drain** to an external collector — the only channel that guarantees delivery independently of the instance dying.
- Make the decisive numbers (detected budget, chosen K, C/S/T, per-phase RSS) emit **before** the fatal allocation (§7), and route them through the watchdog (which ticks on a timer and may land the last pre-kill snapshot), maximising the chance a line escapes before SIGKILL.

**Driving a query at prod (verified):** `graph-ops/scripts/analyse.sh` honours `PYTHON_API_URL`, so
`PYTHON_API_URL=https://dagnet-nine.vercel.app bash graph-ops/scripts/analyse.sh <graph> "<dsl>" --type cohort_maturity --mc-draws N --no-cache`
runs the compute on the prod instance against the prod DB. Liveness check: `curl https://dagnet-nine.vercel.app/api/snapshots/health` → `{"status":"ok","db":"connected",…}`. Current deployed bundle hash (to confirm a deploy landed): `curl -s "https://dagnet-nine.vercel.app/?cb=$RANDOM" | grep -oE 'index-[A-Za-z0-9_]+\.js'`.

---

## 8. Outstanding debt introduced by this work

- **The temporary memory probe is in production.** `graph-editor/lib/mem_phase_probe.py` and its `install()` hook appended to `graph-editor/lib/api_handlers.py` were committed (commit `9df2c30f2`) and are running on prod (it is the source of the `[mem-phase]` log lines). It is documented as TEMPORARY and reversible (disable with `DAGNET_MEM_PHASE_PROBE=0`). It should be removed or gated off.
- **Budget source-of-truth is unresolved.** `runtime_memory.py` auto-detects the container limit first and falls back to a 2 GiB default; `be-memory-budget-design.md` §8/§12 recommends treating the *configured* env value (`DAGNET_MEMORY_BUDGET_GB`) as source of truth (taking the min with the cgroup read) precisely because the cgroup read may be unreliable on Vercel. The current code does not implement that recommendation. Whether this matters depends on H1, which is unverified.
- **`vercel.json` pins no `memory` or `maxDuration` for the Python function** — it inherits plan defaults (noted in `be-memory-budget-design.md` §8).

---

## 9. What is and isn't true about the shipped chunking

- **True (verified):** it is deployed; its arithmetic and bit-identical combine are unit-tested; the oracle still passes; the chunk loop bounds the projection call only.
- **Unknown (not verified):** whether it engages on prod, whether it reduces the prod peak at all, and whether the prod peak is even in the part it bounds. The earlier claim that "the lever works / brings the request under 2 GB" was based on dev-box and in-process measurements and is **not** supported by any production evidence. On the contrary, prod still OOMs with the code deployed.
