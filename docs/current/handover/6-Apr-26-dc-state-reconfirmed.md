# Handover: D/C State Decomposition — State Reconfirmed

**Date**: 6-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Continues from**: `3-Apr-26-dc-state-decomposition.md` (still canonical — read that first)

---

## Objective

Unchanged from prior handover. The cohort maturity fan chart needs a posterior predictive interval that degenerates to the model's unconditional curve at zero evidence. Phases 1–4 are done. The D/C state decomposition rewrite is the immediate next step.

---

## Current State

### Verified 6-Apr-26

The prior handover's claims were reconfirmed against live code and test runs:

- **Branch**: `feature/snapshot-db-phase0`, HEAD at `66334711` ("Cohort curves XII")
- **Working tree**: clean (3 modified shell scripts — `dev-bootstrap.sh`, `dev-start.sh`, `setup.sh` — unrelated to this work)
- **37 tests pass, 1 test RED**: `test_cohort_mode_zero_evidence_degenerates_to_model` ([test_cohort_forecast.py:673](graph-editor/lib/tests/test_cohort_forecast.py#L673))
- **Failure mode matches handover**: `tau=7: midpoint=0.0 should be > 0`. Diagnostic output shows Pop C's Binomial floor() producing zero y at early taus (x_med=88.2 at tau=5 but y_med=0.00; by tau=10 only y_med=6.00 vs expected model rate 0.466).
- **No code changes were made in this session.**

### Status summary (all unchanged from prior handover)

| Item | Status |
|------|--------|
| Phases 1–4 (direct posterior, drift, IS, stochastic upstream) | DONE |
| Epoch unification | DONE |
| Settings & schema (`COHORT_DRIFT_FRACTION`) | DONE |
| Red test for zero-evidence degeneration | DONE (RED) |
| D/C state decomposition rewrite | NOT STARTED |
| Phase 5: Unified simulator | NOT STARTED |
| INDEX.md update | NOT STARTED |

---

## Key Decisions & Rationale

No new decisions in this session. All decisions documented in `3-Apr-26-dc-state-decomposition.md` remain current — particularly:

- **Pop D**: purely local conditional Binomial, no upstream involvement
- **Pop C**: continuous expectations (not Binomial with floor) — parameter variation across MC draws provides uncertainty
- **X_cohort** = N_i + X_C (not upstream-scaled x_forecast_arr)
- **Y_cohort** = k_i + Y_D + Y_C
- **Delete**: pre-frontier upstream reconstruction (cohort-mode Pop B) and single x_forecast_arr block

---

## Discoveries & Gotchas

No new discoveries. Prior handover's gotchas remain relevant:

- Pre-frontier reconstruction is the wrong bridge (upstream x reinterpreting observed y)
- The discriminator is population type (D/C), not epoch
- DRIFT_FRACTION belongs in Data > Forecasting Settings, not chart settings
- Pop B's double loop is the performance bottleneck the rewrite eliminates

---

## Relevant Files

Unchanged from prior handover. Key files for the rewrite:

### Backend
- **`graph-editor/lib/runner/cohort_forecast.py`** — Core MC fan. Rewrite targets lines ~1055–1211 (x_forecast_arr, Pop B, Pop C, combination) and deterministic midpoint ~1343–1357
- **`graph-editor/lib/api_handlers.py`** — Epoch unification done; threads COHORT_DRIFT_FRACTION

### Tests
- **`graph-editor/lib/tests/test_cohort_forecast.py`** — Red test at line 673. Acceptance criterion for the rewrite
- **`graph-editor/lib/runner/test_fixtures/cohort_test_1.json`** — Fixture used by cohort-mode tests

---

## Next Steps

1. **Implement D/C state decomposition** — the agreed plan is fully described in the "Key Insight" and "The agreed rewrite" sections of `3-Apr-26-dc-state-decomposition.md`. Localised to `cohort_forecast.py` lines ~1055–1211 plus deterministic midpoint ~1343–1357. The red test is the acceptance criterion. All 37 existing green tests must stay green.

2. **Phase 5: Unified simulator** — replace `confidence_bands.py` with the same posterior predictive engine. Not yet designed.

3. **Update INDEX.md** — `docs/current/project-bayes/cohort-maturity/INDEX.md` still describes the removed IS approach.

---

## Open Questions

All carried forward from prior handover (non-blocking for step 1):

- **Deterministic midpoint alignment**: after D/C rewrite, the deterministic fallback should also use D/C split (currently uses `x_forecast × posterior_rate`)
- **Pop D simplification validity**: treating all N_i frontier survivors as having uniform exposure a_i is exact in window mode, approximate in cohort mode
- **`median X < 1` fallback**: should remain as safety net but ideally never fires after the rewrite
