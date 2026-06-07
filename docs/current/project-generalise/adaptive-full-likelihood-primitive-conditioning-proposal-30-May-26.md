# Full-Likelihood Primitive Conditioning Plan

**Date:** 30-May-26  
**Status:** staged implementation plan, revised 7-Jun-26  
**Scope:** Fix importance-sampling particle collapse in the primitive conditioner while preserving the full-likelihood posterior target. Stage 1 is fully drafted below and is the only stage intended for immediate implementation. Stages 2 and 3 are explicit escalation paths, not work to start by default.

---

## 1. Purpose

The primitive conditioner has the right statistical target but can approximate it badly. For latent primitives it samples candidate probability/timing worlds, scores them with the full maturity-aware likelihood, and resamples by the resulting weights. When the candidate set barely covers the scoped posterior, a few particles carry most of the mass and the forecaster can publish over-narrow or unstable bands.

The temporary `essthreshold` URL parameter restores the old ESS-tempering path. That path can make the answer look sensible, but it changes the target by weakening the likelihood. It is therefore a comparison and rollback aid only.

The production target remains:

- full likelihood with `λ = 1`;
- no ESS-controlled likelihood tempering;
- preservation of the current probability basis selected by the existing conditioner (`proposal_alpha` / `proposal_beta` in the latent branch) unless a separate reviewed change deliberately retargets epistemic versus predictive basis semantics;
- unchanged public primitive draw shape;
- unchanged downstream CF projection, reducers, charts, and graph schema;
- enough request/cache/provenance plumbing that flagged and unflagged answers never collide silently.

The staged resolution is:

1. **Stage 1:** add a p-guided probability proposal behind a short-lived URL parameter.
2. **Stage 2:** only if Stage 1 fails, add conditioner-local adaptive candidate expansion.
3. **Stage 3:** only if Stage 2 fails, move to a true joint probability/timing proposal at the shared timing-particle boundary.
4. **Stage 4:** retire `essthreshold` and the temporary p-guided URL flag once a full-likelihood proposal path is accepted.

---

## 2. Current Code Surface

This section pins the code this plan is based on. Any implementation that discovers these surfaces have changed must update the plan before proceeding.

### 2.1 Browser request plumbing

`graph-editor/src/constants/latency.ts` defines `ForecastingSettings`, `buildForecastingSettings()`, and the current request-only `essthreshold` URL hook. `buildForecastingSettings()` is the browser choke point that sends forecast settings in API requests.

`graph-editor/src/services/conditionedForecastService.ts` sends `forecasting_settings: buildForecastingSettings()` to `/api/forecast/conditioned` for graph-mutating CF enrichment.

`graph-editor/src/lib/graphComputeClient.ts` sends `forecasting_settings: { ...buildForecastingSettings(), ...overrides }` to `/api/runner/analyze` and `/api/forecast/conditioned` for read-only analysis paths. It already includes `essthreshold` in analysis result cache keys through `essThresholdCacheKeyPart()`.

`graph-editor/src/services/forecastingSettingsService.ts` reads persisted forecasting model settings from `settings/settings.yaml`, but URL comparison flags are not persisted settings. Stage 1 should not add a persisted user-facing settings entry.

### 2.2 Python request settings

`graph-editor/lib/runner/forecasting_settings.py` defines the Python `ForecastingSettings` dataclass. `settings_from_dict()` accepts numeric fields whose names match dataclass fields. `compute_settings_signature()` excludes `is_ess_threshold_enabled` so request-only comparison flags do not change persisted model signatures.

`graph-editor/lib/api_handlers.py` binds `forecasting_settings` with `use_request_settings()` in both `/api/runner/analyze` and `/api/forecast/conditioned`. The CF endpoint then temporarily reduces `mc_draws` for scalar graph-enrichment work by replacing the current settings object with a lower-draw copy. Any Stage 1 request-only flag must survive that dataclass replacement.

### 2.3 Primitive conditioner

`graph-editor/lib/runner/primitive_conditioning.py` is the Stage 1 implementation target.

The current latent branch of `_evaluate_likelihood_plan()`:

- samples probability proposal particles from the current prior/predictive Beta proposal;
- samples timing particles from `sample_timing_particles_from_params()`;
- builds endpoint and row-aligned CDF surfaces;
- computes the full maturity-aware multinomial likelihood over `_CohortLikelihoodPlan.cohort_buckets`;
- normalises weights at `λ = 1` by default;
- optionally searches for a tempered `λ` when `is_ess_threshold_enabled` is true;
- resamples `cond_p_draws` and `cond_cdf_draws`;
- records `mode`, `tempering_lambda`, `ess`, and `ess_threshold_enabled` in provenance notes.

`_build_cohort_likelihood_plan()` already gives Stage 1 the evidence summaries it needs: cohort latest totals, cohort buckets, weighted totals, per-draw weighted totals, row-level totals, and provenance. No new evidence read path is needed for Stage 1.

### 2.4 Timing-particle invariant

`graph-editor/lib/runner/timing_particles.py` states the invariant that the same timing particles drive prefix-arrival evidence weighting and primitive-conditioning CDFs. Stage 1 must not change timing proposal generation. A timing-guided proposal belongs to Stage 3 because it must be introduced at the shared timing-particle boundary.

### 2.5 Tests already in scope

`graph-editor/lib/tests/test_primitive_conditioning.py` already covers the default full-likelihood path and the existing `essthreshold` compatibility branch.

`graph-editor/lib/tests/test_forecasting_settings.py` already covers request settings, dict parsing, context binding, and exclusion of `is_ess_threshold_enabled` from the persistent settings signature.

---

## 3. Constraints

These constraints are binding for Stage 1.

1. Stage 1 must not introduce a new forecast path, reducer, chart builder, graph field, or analysis type.
2. Stage 1 must not change timing particles, prefix-arrival maps, evidence binding, span composition, projection, or reducers.
3. Stage 1 must keep the public primitive draw count equal to request `draw_count`.
4. Stage 1 must keep `λ = 1` whenever the `essthreshold` compatibility path is not explicitly requested.
5. Stage 1 must be guarded by a request-only URL parameter until accepted.
6. Stage 1 must include URL/cache/request plumbing. A plan that only edits `primitive_conditioning.py` is incomplete.
7. Stage 1 must expose provenance sufficient to distinguish default full-likelihood, p-guided full-likelihood, and legacy ESS-tempered runs.
8. Stage 1 must preserve current default behaviour when the new URL parameter is absent.

---

## 4. Proposed URL And Settings Contract

### 4.1 URL parameter

Use a short-lived URL parameter named `pguided`.

`pguided` means: enable the Stage 1 p-guided full-likelihood probability proposal for request-scoped CF/analysis calls. It does not mean "use ESS threshold", does not alter `λ`, and is not a product setting.

The existing `essthreshold` parameter remains separate:

- no URL parameter: current full-likelihood prior/predictive proposal;
- `pguided`: p-guided full-likelihood proposal;
- `essthreshold`: legacy ESS-tempered compatibility path;
- both parameters together: p-guided proposal plus legacy ESS tempering applied to the corrected p-guided log weights. This combined mode exists only for forensic comparison. Provenance must show both flags, the proposal mode, and the final `λ`.

### 4.2 TypeScript settings field

Add a numeric request-only field to `ForecastingSettings` in `graph-editor/src/constants/latency.ts`, for example `is_p_guided_proposal_enabled`.

Default value: `0`.

`buildForecastingSettings()` should set it to `1` only when `window.location.search` contains `pguided`.

This mirrors the current `is_ess_threshold_enabled` pattern and keeps URL interpretation at the browser settings boundary.

### 4.3 Python settings field

Add the same numeric field to `ForecastingSettings` in `graph-editor/lib/runner/forecasting_settings.py`.

`settings_from_dict()` will then accept it automatically.

`compute_settings_signature()` must exclude it, just as it excludes `is_ess_threshold_enabled`, because this is a request-only comparison flag and does not change persisted Bayes model artefacts.

The CF endpoint's dataclass replacement for reduced `mc_draws` must preserve the flag automatically. An explicit test should pin this.

### 4.4 Cache identity

Add `pguided` to `graphComputeClient` cache identity while the flag exists.

The existing `essThresholdCacheKeyPart()` should become a more general temporary forecast-flag cache suffix, or a sibling method should be added. It must be used in:

- `analyzeSelection()` cache key;
- `analyzeMultipleScenarios()` cache key;
- any read-only conditioned forecast cache key if one exists or is added later.

The graph-mutating CF enrichment path does not use the same result cache, but it still receives the settings flag through `buildForecastingSettings()`.

---

## 5. Stage 1 Design: Fixed p-Guided Proposal

Stage 1 changes only probability proposal placement for latent primitives. It does not change the likelihood and does not change timing proposal generation.

### 5.1 Current latent proposal

The current latent proposal samples probability from the current prior/predictive Beta proposal and timing from the shared timing-particle prior. Because the probability proposal is treated as the probability prior/proposal family, weights are effectively likelihood-only in the default full-likelihood path.

### 5.2 Stage 1 proposal shape

Stage 1 introduces an explicit probability proposal helper in `primitive_conditioning.py`.

That helper should return:

- probability candidate draws;
- per-draw log proposal density for those candidates;
- per-draw log prior density for those candidates;
- proposal provenance.

When p-guided mode is disabled, the helper returns the current proposal and the log prior/proposal correction cancels. This is the reproduction mode and must be tested.

When p-guided mode is enabled, the helper returns a per-timing-draw Beta proposal for `p`:

- the current timing particles are unchanged;
- for each timing draw, the helper derives a probability proposal from the p-dependent part of the full latent likelihood under that timing draw;
- the proposal density is used in the importance correction.

The likelihood remains the existing maturity-aware likelihood. The latent weight for each candidate becomes full likelihood plus the probability-basis/proposal correction. Timing contributes no proposal correction in Stage 1 because timing is still sampled from the current timing proposal.

### 5.3 Evidence guide construction

The guide is deliberately local and derived. It uses only `_CohortLikelihoodPlan` plus the timing CDF particles already built in `_evaluate_likelihood_plan`; it must not read graph fields, files, DB rows, or raw request payloads.

There must be no arbitrary guide concentration, mixture weight, or acceptance literal in Stage 1. The p proposal should be derived from the one-dimensional conditional p posterior induced by the existing timing draw.

For one timing draw `s`, the existing latent likelihood has this p-dependent shape:

`log L_s(p) = K_s log(p) + Σ_d R_{d,s} log(1 - p F_{d,s}) + const`

where:

- `K_s` is the draw-indexed total observed conversion increment across the cohort buckets;
- `R_{d,s}` is the residual unconverted mass for cohort bucket `d` at its final observed age;
- `F_{d,s}` is the timing CDF value for draw `s` at that final observed age.

The current probability basis contributes its own Beta log-density. Stage 1 should build a Beta proposal approximation to the one-dimensional conditional posterior:

`current_probability_basis(p) × L_s(p)`

The intended first implementation is a deterministic mode/curvature approximation:

1. Find the conditional mode `m_s` of the p-dependent log posterior on the open interval `(0, 1)`.
2. Evaluate the negative second derivative `H_s` at `m_s`.
3. Convert mode and curvature into Beta parameters:
   - `C_s = 2 + H_s m_s (1 - m_s)`
   - `α_q,s = 1 + m_s (C_s - 2)`
   - `β_q,s = 1 + (1 - m_s) (C_s - 2)`
4. Sample `p_s ~ Beta(α_q,s, β_q,s)`.
5. Use `log q_s(p_s)` in the importance correction.

This uses the evidence and timing particles already present in the conditioning subsystem. It introduces no product-level tuning parameter. Numerical boundary constants used to keep logs finite should be named as numerical safety constants and kept local to the conditioner.

Guide validity handling belongs at the helper perimeter:

- invalid or empty evidence means use only the current probability proposal;
- failure to find a finite conditional mode or curvature means use only the current probability proposal;
- derived Beta parameters must be finite and positive;
- provenance must say when the guide was skipped and why.

### 5.4 Proposal correction

The proposal density must be the density of the actual proposal that produced each draw. It is not acceptable to sample from the guide and weight by likelihood only.

The helper should compute the current probability-basis density and proposal density using the same Beta parameterisation used for sampling. `numpy_stats.py` already contains `math.lgamma`-based Beta special-function support; Stage 1 can add a small vectorised Beta log-density helper either in `primitive_conditioning.py` or in `numpy_stats.py`. If added to `numpy_stats.py`, it should be narrowly scoped and covered by tests.

The existing `essthreshold` branch must apply after the corrected full-likelihood log weights are available. In p-guided mode, `essthreshold` must not accidentally temper uncorrected likelihood-only weights.

### 5.5 Provenance

Primitive notes should include, at minimum:

- proposal mode: current proposal or p-guided conditional Beta proposal;
- whether `pguided` was enabled;
- whether `essthreshold` was enabled;
- derived guide mode and curvature/Beta parameters when used;
- guide skip reason when not used;
- final ESS and, if cheap, ESS ratio/top-weight share;
- tempering lambda.

Do not make chart UI dependent on this provenance in Stage 1. The provenance is for tests, CLI, and forensic comparison.

---

## 6. Stage 1 Implementation Atoms

Stage 1 is the immediate implementation plan. The atoms below should land together unless explicitly split by the maintainer.

### Atom 1 - Request Flag Plumbing

Edit `graph-editor/src/constants/latency.ts`.

Add the Stage 1 request-only field to `ForecastingSettings`. Add a URL helper for `pguided`, mirroring the current `essthreshold` helper. Add a default constant set to disabled. Include the field in `buildForecastingSettings()`.

Edit `graph-editor/lib/runner/forecasting_settings.py`.

Add the matching dataclass field. Exclude it from `compute_settings_signature()`. Confirm `settings_from_dict()` accepts it automatically.

Edit `graph-editor/lib/tests/test_forecasting_settings.py`.

Add tests that the field defaults to disabled, round-trips through `settings_from_dict()`, is visible through `use_request_settings()`, survives dataclass replacement where relevant, and does not change `compute_settings_signature()`.

### Atom 2 - Result Cache Separation

Edit `graph-editor/src/lib/graphComputeClient.ts`.

Include `pguided` in the same cache-key family as `essthreshold`. The cache suffix should clearly distinguish:

- no temporary proposal flag;
- `pguided`;
- `essthreshold`;
- combined `pguided` + `essthreshold`.

Cover both single-scenario and multi-scenario analyse cache keys. If a relevant conditioned-forecast read-only cache key exists, include it there too.

Add or update frontend tests if there is an existing graph compute client cache-key test harness. If no focused harness exists, record this as a Stage 1 manual verification item in the stage note rather than creating a broad FE test fixture.

### Atom 3 - Conditioning Options And Cache Key

Edit `graph-editor/lib/runner/primitive_conditioning.py`.

Add a request-backed option on `ConditioningPolicyOptions` for the p-guided proposal flag, following the existing `is_ess_threshold_enabled` pattern.

Update `_primitive_cache_key()` so the p-guided proposal flag enters primitive cache identity. Otherwise a flagged request could reuse an unflagged primitive posterior or vice versa.

Add tests in `test_primitive_conditioning.py` or `test_forecasting_settings.py` proving the option default follows request settings and cache identity distinguishes p-guided from unflagged. If directly inspecting cache keys is too brittle, use a behavioural cache test that would fail if the cached primitive were reused across modes.

### Atom 4 - Probability Proposal Helpers

Edit `graph-editor/lib/runner/primitive_conditioning.py`.

Add helper logic for:

- Beta log-density;
- current proposal reproduction mode;
- p-guided conditional Beta proposal;
- guide construction from `_CohortLikelihoodPlan` plus the existing timing CDF particles;
- guide skip provenance.

Keep this helper private to the conditioner for Stage 1. Do not generalise it into the shared timing/proposal substrate yet.

The helper should not mutate the plan or timing particles. It should use the existing keyed RNG seam. If it needs a distinct RNG derivation for guide draws, add a named derivation through the existing `make_rng()` pattern rather than using an unkeyed random source.

### Atom 5 - Latent Weight Calculation

Edit the latent branch of `_evaluate_likelihood_plan()`.

Replace direct probability proposal sampling with the proposal helper. Compute the existing latent log likelihood exactly as before, using the returned probability draws and unchanged timing CDF draws.

Normalise full-likelihood weights using the corrected log weights. The default reproduction path should reduce to the current weights.

Keep the `essthreshold` compatibility branch opt-in. If it remains supported alongside `pguided`, it must temper the corrected log weights rather than the raw likelihood-only vector.

Do not touch the non-latent conjugate path except for shared provenance structures if unavoidable.

### Atom 6 - Provenance And Notes

Extend `_ConditioningOutcome.provenance` and the final primitive notes to include Stage 1 proposal provenance.

The existing note starting with `maturity_aware_mode=` should remain readable by existing tests, but tests should be updated to check the new fields where relevant.

No chart or UI work is required.

### Atom 7 - Focused Tests

Update `graph-editor/lib/tests/test_primitive_conditioning.py`.

Minimum tests:

- default latent path remains full-likelihood with `λ = 1` and p-guided disabled;
- current-proposal reproduction mode cancels the probability-basis/proposal correction;
- p-guided mode records proposal provenance and keeps `λ = 1`;
- p-guided mode preserves output draw shape;
- p-guided mode changes proposal placement under a controlled evidence case;
- p-guided mode derives proposal parameters from conditional p mode/curvature rather than from a hard-coded concentration or mixture share;
- p-guided mode and `essthreshold` are distinguishable in notes;
- `essthreshold`, if combined with p-guided, tempers corrected p-guided weights and reports both flags;
- primitive cache identity separates p-guided and unflagged requests.

Add one targeted synthetic or fixture-backed test for the known failure shape if it can be expressed at primitive level. If not, record an outside-in acceptance run as a Stage 1 manual verification item rather than blocking the unit implementation on a large fixture build.

### Atom 8 - Documentation And Stage Note

Update this plan if implementation discovers a different guide formula or URL name is needed.

Record the Stage 1 outcome:

- URL parameter used;
- guide formula;
- tests run;
- known forecaster case result versus default and `essthreshold`;
- decision: accept Stage 1, proceed to Stage 2, or revise.

---

## 7. Stage 1 Acceptance

Stage 1 is complete only when all of the following are true:

- `pguided` enables p-guided full-likelihood proposal from the browser request path.
- The flag is request-only and excluded from persistent Bayes model signatures.
- FE analyse cache keys separate flagged and unflagged responses.
- Primitive cache keys separate flagged and unflagged primitive posteriors.
- Default behaviour without `pguided` matches current full-likelihood behaviour.
- P-guided mode keeps `λ = 1` unless `essthreshold` is explicitly also requested, in which case tempering applies to corrected p-guided weights and provenance reports the combined mode.
- Public primitive output arrays remain at request `draw_count`.
- Timing particles, prefix-arrival maps, evidence binding, span composition, projection, reducers, chart builders, and graph schemas are unchanged.
- Focused tests cover settings, cache identity, proposal correction, provenance, and output shape.
- The known forecaster case has been compared in default, `pguided`, and `essthreshold` modes.

Acceptance does not require Stage 1 to solve every possible particle-collapse case. It must decide whether the p-guided proposal is sufficient for the known case. If it is not, Stage 2 becomes justified.

---

## 8. Stage 2 - Conditioner-Local Adaptive Candidate Expansion

Do not implement Stage 2 until Stage 1 has been tried against the known case.

Stage 2 extends the Stage 1 proposal helper so the conditioner can evaluate additional candidate batches under the same full-likelihood target.

Stage 2 stays inside `primitive_conditioning.py` as far as possible:

- no evidence rebinding;
- no prefix-arrival change;
- no reducer or chart change;
- public output remains `draw_count`;
- batches are deterministic under the primitive draw-family key plus a batch discriminator;
- resampling happens once from the accumulated weighted candidate pool;
- provenance reports candidate count, batch count, final ESS, top-weight share, and cap-hit status.

Stage 2 may sample extra timing particles for extra conditioner-local candidate batches, but because evidence binding is not recomputed it remains an approximation to "try more joint candidates", not a true timing-guided proposal. If this distinction becomes unacceptable, proceed to Stage 3 rather than stretching Stage 2.

---

## 9. Stage 3 - Shared Joint Probability/Timing Proposal

Do not implement Stage 3 until Stage 2 fails or evidence shows timing proposal coverage is the dominant issue.

Stage 3 moves proposal generation to the shared particle boundary so the same timing worlds are used by prefix-arrival weighting, primitive evidence binding, and latent likelihood scoring.

Required shape:

- a shared proposal object carrying probability draws, timing draws, proposal log density, prior log density, and provenance;
- prefix-arrival maps built from the proposal's timing draws;
- evidence binding performed under those arrival maps;
- primitive conditioning consuming the same proposal particles;
- latent weights using the full prior/proposal correction;
- cache identity including proposal identity/settings;
- no projection or reducer selecting fits or proposals.

A two-pass guide may be required: first bind evidence under the current proposal to build a guide, then build the final guided proposal, rebuild arrival maps, rebind evidence, and condition. That is a substantial substrate change and is outside the Stage 1 implementation budget.

---

## 10. Stage 4 - Flag Retirement

Once a full-likelihood proposal path is accepted:

- make the accepted proposal path the default;
- remove the temporary `pguided` URL parameter;
- remove or hard-deprecate `essthreshold`;
- remove temporary cache-key suffixes for deleted flags;
- update tests so the accepted path is the default expectation;
- update this plan or replace it with a completion note.

The intended end state is one production full-likelihood proposal path, not a permanent menu of proposal modes.

---

## 11. Non-Goals

This plan does not:

- change the posterior target;
- introduce default ESS tempering;
- modify chart rendering;
- modify projection or reducer semantics;
- solve kappa-realised predictive dispersion;
- introduce per-primitive variable public draw counts;
- replace the shared timing-particle invariant in Stage 1;
- make p-guided proposal a permanent user-facing feature.

---

## 12. Success Criteria

The programme succeeds when:

- full-likelihood conditioning remains the default statistical target;
- the known narrow-band forecaster case no longer depends on `essthreshold` for sensible output;
- scoped evidence is not pulled back toward the prior by hidden tempering;
- downstream consumers continue to read the same primitive shapes;
- the first sufficient stage in the escalation ladder is the stage that ships;
- temporary URL flags are removed after acceptance;
- low particle quality is visible in provenance rather than silently repaired by changing the likelihood.
