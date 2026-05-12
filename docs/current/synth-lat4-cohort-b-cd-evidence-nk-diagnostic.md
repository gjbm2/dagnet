# Diagnostic: `evidence_n` / `evidence_k` mismatch for `cohort(synth-lat4-b, …)` on `c→d` vs `window` / `cohort(synth-lat4-c, …)`

**Status:** Open — critical system defect in surfaced evidence totals for **active carrier** cohort on downstream subject edge.  
**Fixture:** `synth-lat4` (`bayes/truth/synth-lat4.truth.yaml`).  
**Test:** `graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`.  
**Date:** 8-May-26

---

## 1. Summary

For **`from(synth-lat4-c).to(synth-lat4-d)`** with the pinned calendar band **`29-Jan-26:29-Apr-26`**, **`conditioned_forecast`** exposes per-edge **`evidence_n`** and **`evidence_k`** (sourced from cohort maturity **`evidence_x` / `evidence_y`** on the saturated row — see `graph-editor/lib/api_handlers.py` circa 2281–2306).

**`window(…)`** and **`cohort(synth-lat4-c, …)`** (denominator anchor = **`c`**, i.e. **`A = X`**) agree exactly on **`(N, K)`**.

**`cohort(synth-lat4-b, …)`** (anchor **`b`**, single-hop upstream of **`c`**) produces **strictly lower `N` and `K`**, and **`K` falls far short** of **`N × p_{c→d}`** for **`p = 0.65`** from the fixture — inconsistent with treating both modes as the same underlying **`c→d`** incidence stream under the YAML edge truth.

The outside-in test treats **`cohort(b)`** parity with **`window`** on these fields as the acceptance oracle (WP8-off subject-helper / rate-conditioning evidence family). The failure is **not** a flaky tolerance issue; it signals incorrect **`engine_cohorts` → maturity projection → CF edge** plumbing for **active carrier + downstream subject**.

Follow-up row inspection confirms the asymmetry is **not** an `api_handlers` walk-back artefact: both queries expose populated rows through **τ=99**, and `api_handlers` reads the final row for both. The rows themselves carry different populations.

---

## 2. Symptom

- **Assertion:**  
  `(admitted_edge.evidence_k, admitted_edge.evidence_n) == (window_edge.evidence_k, window_edge.evidence_n)`
- **Observed (witness):**  
  `(13440, 26317)` vs `(17543, 27698)` — mismatch on **both** coordinates.

### 2.1 Row-level witness

The `api_handlers` projection walks from the saturated row only when the saturated row lacks `evidence_x` / `evidence_y`. Here both runs are populated at **τ=99**, so the edge-level `(evidence_n, evidence_k)` values are direct reads from the final maturity rows.

| τ | Window `evidence_x` | Window `evidence_y` | `cohort(b)` `evidence_x` | `cohort(b)` `evidence_y` | Notes |
|---:|---:|---:|---:|---:|---|
| 0 | 27,698 | 0 | None | None | Window carries `x_frozen` from τ=0; active cohort has no bucket yet |
| 1 | 27,698 | 0 | 0 | 0 | First active bucket; no B→C arrivals yet |
| 3 | 27,698 | 0 | 2 | 0 | Arrivals at C begin |
| 5 | 27,698 | 641 | 529 | 0 | Window conversions start while active cohort is still ramping |
| 10 | 27,698 | 12,047 | 12,505 | 37 | Active denominator catches up; numerator lags heavily |
| 15 | 27,698 | 16,435 | 22,269 | 2,292 | Epoch B begins (`tau_solid_max = 9`) |
| 20 | 27,698 | 17,321 | 25,310 | 7,733 | |
| 25 | 27,698 | 17,488 | 26,067 | 11,348 | |
| 30 | 27,698 | 17,529 | 26,251 | 12,786 | |
| 35 | 27,698 | 17,542 | 26,300 | 13,256 | |
| 45 | 27,698 | 17,543 | 26,316 | 13,431 | Window saturated; active cohort still creeping |
| 55 | 27,698 | 17,543 | 26,317 | 13,440 | Active cohort saturated |
| 99 | 27,698 | 17,543 | 26,317 | 13,440 | Final row read by `api_handlers` |

`tau_solid_max = 9` in both runs. The active cohort row has no τ=0 bucket, but that does not explain the final-row mismatch.

---

## 3. Oracle (what the test is actually checking)

The test does **not** compare arbitrary curves; it compares **two integers per edge** taken from the **conditioned_forecast** payload:

| Role | DSL fragment |
|------|----------------|
| Reference | `…window(29-Jan-26:29-Apr-26)` |
| Identity cohort | `…cohort(synth-lat4-c,29-Jan-26:29-Apr-26)` |
| Admitted single-hop | `…cohort(synth-lat4-b,29-Jan-26:29-Apr-26)` |

**Intent (from assertion message):** with WP8 default-off, **single-hop anchor override** must **not** swap the **subject-side rate-conditioning evidence totals** on **`c→d`** away from the **window-rooted** totals — carrier/completeness may move, but **`N`/`K`** on that edge should match **`window`**.

---

## 4. Historical vacuity

Before **`evidence_n` / `evidence_k`** were populated on the CF edge, **`None == None`** made the assertion **pass vacuously**. Once handlers/projections filled **`evidence_x` / `evidence_y`** through to the edge, the check became **real** and began failing. That is **test power restored**, not a bad oracle.

---

## 5. Fixture expectations (truth YAML)

From **`bayes/truth/synth-lat4.truth.yaml`**:

- Linear chain **`a → b → c → d`**; **`c→d`** edge declares **`p: 0.65`** (plus latent-time parameters).
- Commentary (non-numeric): **`cohort` anchored at `c`** on **`c→d`** **collapses** to **`window`** on **`c→d`**; anchor **`b`** is the **alternate** cohort family on **`c→d`** for admission tests.

So **at minimum**, **`window`** and **`cohort @ c`** must agree — which they do on **`(N,K)`**.

---

## 6. Analytic cross-check (YAML only — order-of-magnitude)

This does **not** reproduce five-digit **`N`/`K`** without running **`simulate_graph`**, but it fixes **`p_{c→d}`** and scale:

- Rough throughput toward **`c`:**  
  `λ_A × p_{ab} × p_bc ≈ 2000 × 0.6 × 0.5 = 600` person-equivalents/day (upper-scale before latency/failure thinning).
- Horizon ~90 days ⇒ **`N`** **order ~10⁴** (observed **~2.77×10⁴** — plausible).
- **`K`** should track **`N × 0.65`** with only a **small** latency haircut — not a **large** gap unexplained by **`p_{c→d}`**.

---

## 7. Evidence table (representative run)

| Query | **`evidence_n` (`N`)** | **`evidence_k` (`K`)** | **`N × 0.65`** | **`K / (N × 0.65)`** |
|--------|-------------------------|-------------------------|----------------|----------------------|
| **`window`** | 27 698 | 17 543 | ~18 004 | **~0.97** |
| **`cohort` @ **`c`** | 27 698 | 17 543 | ~18 004 | **~0.97** |
| **`cohort` @ **`b`** | 26 317 | 13 440 | ~17 106 | **~0.79** |

**Reading:**

- **`window` / `cohort` @ `c`:** **`K`** within **~3%** of **`N × p_{c→d}`** — consistent with **edge `p` + light censoring**.
- **`cohort` @ `b`:** **`K`** is **~21% below** **`N × 0.65`** for **its own `N`** — not a small latency effect; the **pair `(`N`,`K`)** is **incompatible** with the same **Binomial-at-edge** story that fits the other two queries.

---

## 8. Problem statement (concise)

**`cohort(synth-lat4-b, …)` on `from(c).to(d)`** surfaces **`evidence_n` / `evidence_k`** that:

1. **Violate** the **documented outside-in parity oracle** (match **`window`** on **`N`/`K`**).
2. **Violate** a **simple YAML-consistent check:** **`K ≈ N × p_{c→d}`** to the same degree as **`window` / `cohort` @ `c`**.

Therefore the **b-anchored active-carrier** path is **defective** in how **observed-prefix / maturity `evidence_x`/`evidence_y`** are constructed or aggregated for the **`c→d`** subject primitive — **not** merely “different clocks” on an otherwise identical mass ledger.

The row-level evidence narrows this further: the defect is upstream of the CF edge flattening. `api_handlers` is reading the row it says it reads; the wrong population is already present on the final active-carrier maturity row. Either:

1. the active selected A-clock `Y_prefix` is under-attributing terminal `c→d` conversions for mass that has reached `c`, or
2. the public CF `evidence_n` / `evidence_k` fields are incorrectly sourced from selected A-clock display rows even though the WP8-off contract says they expose the window-rooted subject-helper p-conditioning totals.

Both interpretations are critical: the first is genuine mass destruction inside the active-carrier count flow; the second is a public contract violation that makes `evidence_n` / `evidence_k` report the wrong evidence family.

---

## 9. Likely engineering locus (non-exhaustive)

Investigation should trace **`cohort(b)`** through:

- **`cohort_forecast_v3`**: **`engine_cohorts`**, **`build_cohort_evidence_from_frames`**, **`_project_runtime_rows`**, and the **active-carrier** branch that **zeros `raw_obs_x` / `raw_obs_y`** for **`is_active_carrier`** (see circa 4713–4721 in recent tree — exact lines shift with edits).
- **`cohort_forecast_v3` active selected evidence**: **`_build_observed_span_evidence_surface`**, **`_build_rate_attributed_subject_prefix`**, **`_build_active_selected_a_clock_evidence_from_runtime`**, and the runtime-resolved **`selected_source_day_mass` / `selected_x_prefix` / `selected_y_prefix`** trio. The final row shows `X_prefix` saturating at **26,317** while `Y_prefix` saturates at **13,440**, so this is the immediate mass ledger to audit.
- **`api_handlers.py`**: flatten **`last_row['evidence_x']`/`evidence_y`** onto **`evidence_n`/`evidence_k`** with walk-back (2293–2306).

Hypothesis class: **cohort-restricted observation set**, **incorrect selected-source-day mass attribution**, or **wrong public field source** under **anchor `b`** produces **smaller `N`** and **much smaller `K`** than the shared **`c→d`** ledger implies under **`p_{c→d}`**.

---

## 10. Exit criteria

- **`cohort(b)`** **`(evidence_k, evidence_n)`** matches **`window`** within the test (and **`cohort` @ `c`** remains aligned).
- **`K`** remains within **tight** tolerance of **`N × p_{c→d}`** for **`c→d`** given **`p = 0.65`** from truth YAML (plus documented latency slack), **for all three** query shapes above — unless product **explicitly** documents a different definition of **`N`/`K`** and **updates** the oracle accordingly.

---

## 11. References

- Test: `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` — `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`.
- CF edge fill: `graph-editor/lib/api_handlers.py` — maturity **`last_row`**, **`evidence_x`/`evidence_y`** → **`evidence_n`/`evidence_k`**.
- Fixture: `bayes/truth/synth-lat4.truth.yaml`.
- Tracker cross-reference: `docs/current/post-cf-rebuild-batches/phase-2-batch-O-orphan-fails-and-A1-cleanup.md` (witness table row for this test).
