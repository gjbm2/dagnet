# Forecast Runtime Semantic Pseudo-Code

**Status**: Current implementation companion, audited 6-May-26
**Scope**: Semantic pseudo-code for the CF runtime stages described in [`FORECAST_RUNTIME_ARCHITECTURE.md`](FORECAST_RUNTIME_ARCHITECTURE.md). Semantic authority remains [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

This document is a terminology-first walk through what the CF runtime does in the current codebase. It is still semantic pseudo-code, not a line-for-line implementation transcript. It names the current implementation seams where they are load-bearing, and uses **Implementation note** blocks for code/doc tensions or deliberately imperfect implementation details. Terms follow [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md):

- `A` is the population root in active `cohort(A, X -> end)`.
- `X` is the denominator node and the start of the subject span.
- `end` is the subject end (`Y` for single-hop, `Z` for multi-hop).
- A selected Cohort `C` is rooted at `C.anchor_day`.
- Carrier means the denominator-side `A -> X` object.
- Subject span means the numerator-side `X -> end` object.
- The displayed rate is always `Y / X`, never `Y / A`.

The notation below uses:

- `d_obs` for a raw row's primitive source day: the calendar day on the primitive source node `U`.
- `d_ret` for the raw row's retrieval timestamp: the snapshot day that places the row on the chart age axis.
- `tau_A(C, d) = d - C.anchor_day`.
- `increments(CDF)` for the daily PMF obtained from a CDF.
- `selected_cohorts` for the materialised, admissible selected Cohort set, not the raw DSL date range.
- `chart_tau_extent` for the emitted row-axis extent. This is distinct from the deeper internal saturation horizon used by fallback/support arrays.

## A.1 Request Shape And Selected Cohorts

Input:

- resolved query mode: `window()` or `cohort()`;
- population root: `A` for active cohort, otherwise `X`;
- denominator node `X`;
- subject span `X -> end`;
- snapshot frames and evidence-superset rows prepared outside `ResolvedCFRuntime`.

Semantic pseudo-code:

```text
resolve request:
  if query is window():
    population_root = X
    carrier = identity
  else:
    population_root = A
    carrier = identity if A == X else active A -> X

materialise selected Cohorts:
  selected_cohorts = admissible Cohorts from the prepared frame set
  for each Cohort C:
    C.anchor_day = the population-root day for this Cohort
    C.frontier_age = latest observed age available for C
    C.base_mass =
      if active cohort(A != X):
        observed root-window n on the first carrier primitive rooted at A
      else:
        X-rooted frame base mass

derive row epochs:
  tau_solid_max = min(C.frontier_age for C in selected_cohorts)
  tau_future_max = max(0, sweep_to - public_anchor_from)
  tau_future_max = max(tau_future_max, tau_solid_max)
  chart_tau_extent = max(tau_future_max, caller_axis_tau_max, edge_latency_t95_horizon)
  chart_tau_extent = min(chart_tau_extent, 400)
  internal_saturation_extent =
    min(max(chart_tau_extent, 2 * edge_or_path_latency_t95_horizon), 400)
  row_tau_range = 0..chart_tau_extent
```

Invariants:

- Anchor dates decide which Cohorts exist; retrieval dates decide how far those Cohorts have been observed.
- The selected-Cohort denominator is the admissible materialised set, not the raw DSL date range.
- In active `cohort(A != X)`, X-clock target-frame prefixes are not selected A-clock evidence. They are primitive evidence only.
- In active `cohort(A != X)`, frame-bundle `a` is not an admissible fallback for base mass. Anchors without root-window carrier `n` are zeroed out for projection.
- `tau_solid_max` is evidence-depth. `tau_future_max` / `chart_tau_extent` are row-axis extent. Do not derive row extent from `max(frontier_age)`.

**Implementation note:** `tau_future_max` is currently computed from the public `anchor_from` rather than from the earliest surviving admissible selected Cohort. This matches the current chart-axis implementation when the selected set spans the public range, but it is a subtle distinction if materialisation later admits a strict subset.

## A.2 Evidence Ingress

Input:

- `evidence_superset_rows` from the preparation / fetch-envelope layer.

Semantic pseudo-code:

```text
for each prepared per-edge evidence_superset_rows entry:
  translate each raw evidence row r into an EvidenceCandidate:
    identity = edge, role, subject_from, subject_to, slice, regime, context
    coordinate = (observed_date = d_obs, retrieved_at = d_ret)
    counts = (n, k)

flatten subject, target, and carrier candidates into one request pool
dedupe exact duplicate candidate records in that pool
primitive-local merge later groups and admits rows for each primitive
```

Invariants:

- `ResolvedCFRuntime` does not fetch, widen, or choose source families. Fetch-envelope construction and snapshot access live in preparation / handlers.
- The request-pool adapter performs exact duplicate suppression before primitive binding. Semantic merge, supersession, and evidence admission remain primitive-local.
- All evidence enters through the same candidate pool, then primitive-local binding admits or rejects it.
- A row's `observed_date` and `retrieved_at` are different clocks and must not be collapsed.

**Implementation note:** subject preparation is window-row-led today: `prepare_forecast_subject_group` calls the per-subject preparation path with `subject_is_window=True` even for cohort queries, so snapshot row selection favours the window family. Cohort semantics enter through the envelope, arrival maps, carrier/subject roles, and selected A-clock projection, not through a distinct DB row-family role at this layer. WP8 direct `cohort()` rate conditioning remains out of the standard production path.

## A.3 Runtime Resolution: Roles And Clocks

Input:

- population root;
- denominator node `X`;
- subject span `X -> end`;
- active source-ledger priors and latency parameters.

Semantic pseudo-code:

```text
resolve subject primitives:
  subject_primitives = parameterised edges in X -> end

resolve carrier primitives:
  if population_root == X:
    carrier_primitives = empty
    composed_carrier = identity
  else:
    carrier_primitives = parameterised edges in A -> X

build arrival maps:
  if active carrier:
    carrier arrival map is A-rooted:
      L_carrier[C, n] = arrival PMF at carrier-chain node n from selected Cohort C

  subject arrival map is subject-clocked:
    for active cohort() subject primitives:
      root is X
      root-day support is the X-day support induced by selected Cohorts
      through the carrier, not donor phantoms and not merely the public
      A-anchor window
      L_subject_local[n] = arrival PMF at subject-chain node n from X
    for cohort(A = X) subject primitives:
      root is X over the public X-clock range
      carrier is identity
    for window() subject primitives:
      root is each primitive source; local identity binding is used
```

Invariants:

- Carrier and subject clocks are separate. Carrier answers "who reached X by A-clock age tau?". Subject answers "given mass at X, when does it reach end?".
- Identity carrier is data, not a route. `window()` and `cohort(A = X)` are degeneracies of the same runtime object.
- Donor or retrieval support may widen what is fetched, but selected-Cohort attribution later normalises over selected Cohorts only.
- Evidence role in the merge layer is currently flattened to the WP8-default-off `WINDOW_SUBJECT_HELPER` role. Carrier/subject semantics are carried by which arrival map and runtime role consumes the candidate, not by a distinct merge-layer role enum.
- In window mode, runtime primitive preparation forces local identity arrival weights for subject primitives, even if a compatibility subject arrival map object exists.

## A.4 Primitive-Local Binding

Input:

- one primitive `U -> V`;
- the candidate pool for that primitive;
- role-appropriate arrival support at source node `U`.

Semantic pseudo-code:

```text
for each primitive U -> V:
  choose binding support at the primitive source node U:
    if U -> V is a carrier primitive:
      support(root_day, d_obs) = carrier arrival support at U on the A-clock
    else if U -> V is a cohort subject primitive:
      support(root_day, d_obs) = subject-local support at U on the X-clock
    else if U -> V is a window subject primitive:
      support(root_day, d_obs) = local identity support at U

  for each raw candidate row r for U -> V:
    d_obs = r.observed_date
    d_ret = r.retrieved_at

    if total support at d_obs <= 0:
      reject r as off-clock for this primitive
      continue

    bind r into a WeightedEvidenceRow:
      arrival_weight = support(d_obs)
      root_day_shares = normalised root-day contributions to d_obs
      n_weighted = r.n * arrival_weight
      k_weighted = r.k * arrival_weight
      row_age = d_ret - d_obs
```

Invariants:

- Primitive conditioning uses the primitive's own clock. Subject rows are not moved onto A-clock here.
- `d_obs` is the primitive source day. `d_ret - d_obs` is the maturity age used by the primitive likelihood.
- `root_day_shares` are provenance for the binding clock; selected A-clock display may later remap them.

## A.5 Single Conditioning Locus

Input:

- one primitive's weighted evidence rows;
- the primitive's aggregate prior and timing model.

Semantic pseudo-code:

```text
for each primitive U -> V:
  start with aggregate prior p_UV and timing CDF_UV

  build likelihood plan:
    group rows by observed_date
    resolve same-retrieval conflicts within each observed_date group
    pick the latest retrieved_at row per observed_date for cohort totals
    cohort_aggregate =
      sum latest n_weighted per observed_date,
      sum latest k_weighted per observed_date

    if timing is latent:
      for each observed_date group:
        sort retrievals by row age = retrieved_at - observed_date
        preserve zero-increment plateau cells
        build multinomial increments:
          delta_k_i = max(k_i, k_{i-1}) - k_{i-1}
          residual = n_latest - k_latest

  evaluate likelihood plan:
    if no evidence:
      return prior-only(reason = no_evidence)
    else if timing is latent and no usable timing grid:
      return prior-only(reason = no_timing_grid)
    else if timing is latent and no row has positive age:
      return prior-only(reason = no_latent_rows)
    else if timing is non-latent:
      apply conjugate Beta update on cohort_aggregate:
        alpha' = alpha + cohort_k
        beta'  = beta  + (cohort_n - cohort_k)

    else:
      draw joint particles:
        p_s from predictive Beta proposal
        timing_s from the primitive timing posterior / dispersion model
        CDF_s(age) from timing_s

      for each observed_date bucket:
        prev_CDF_s = 0
        for each retrieval age tau_i:
          cell_prob_s = p_s * (CDF_s(tau_i) - prev_CDF_s)
          add delta_k_i * log(cell_prob_s)
          prev_CDF_s = CDF_s(tau_i)

        residual_prob_s = 1 - p_s * CDF_s(last_observed_tau)
        add residual * log(residual_prob_s)

      importance-sample joint (p_s, CDF_s) particles with full likelihood
      record ESS as a diagnostic of particle quality

  materialise primitive:
    if outcome is prior-only:
      return prior-only ConditionedTransitionPrimitive with reason
    else:
      apply doc-52 subset blend to the conditioned/prior draw families

  produce ConditionedTransitionPrimitive:
    probability posterior / draws
    timing posterior / draws
    weighted evidence totals
    conditioning provenance
    residual / unsupported classification
```

Invariants:

- Conditioning happens once, at primitive construction.
- No row projection, scalar projection, chart display, carrier composition, or subject composition reconditions the primitive.
- Raw under-matured evidence is evidence for the primitive's maturity-aware likelihood, not mature evidence for `p_infinity`.
- Draw-family coherence is load-bearing: when timing is latent, the same full-likelihood resampled particle index selects both `p_s` and `CDF_s`.
- Non-latent timing is the `F == 1` degeneration of the same plan/evaluate/materialise shape. It uses cohort-distinct latest rows, not the row-level sum of every repeated retrieval.
- No usable latent likelihood means the unconditioned prior is the answer. The latent path must not fall back to a conjugate update that implicitly treats `F` as 1.
- Same-retrieval non-identical conflicts skip the whole observed-date group; identical collisions coalesce.

## A.6 Role Composition

Input:

- conditioned subject primitives;
- conditioned carrier primitives, if any.

Semantic pseudo-code:

```text
compose subject span:
  composed_subject = topology composition over conditioned primitives in X -> end
  expose:
    span reach: probability of X reaching end
    timing: CDF / draw family for X -> end

compose carrier:
  if population_root == X:
    composed_carrier = identity
  else:
    composed_carrier = topology composition over conditioned primitives in A -> X
    expose:
      carrier reach: probability of A reaching X
      timing: CDF / draw family for A -> X
```

Invariants:

- `ComposedPrimitiveSpan` is role-neutral; meaning comes from the `composed_subject` or `composed_carrier` slot.
- Reach and timing remain separate until a consumer chooses its public surface.
- Multi-hop subject means `X -> end`, not "last edge into end".

## A.7 Selected A-Clock Evidence Prefix Construction

This stage builds the selected-Cohort observed evidence prefix for active `cohort(A != X)` rows. It is not primitive conditioning and it is not model projection.

The prefix is **source-node mass scaled** and **selected-A-clock placed**. Window-family subject rows provide local primitive rates (`k/n`) on the primitive's own source clock; they do not provide selected-Cohort destination counts. The selected count contribution is the local primitive rate multiplied by selected mass at that primitive source node/day, then placed on the selected `A` clock by retrieval age.

Input:

- selected Cohorts;
- primitive-bound observed rows;
- observed root-window `N_cohort(C)` for selected anchor days;
- carrier-only selected denominator prefix `X_prefix(C, tau)`;
- selected source-node mass surfaces `M_select(U, C, u)` for each subject primitive source node `U`;
- topology for carrier `A -> X` and subject span `X -> end`.

Semantic pseudo-code:

```text
build selected source-node mass surfaces:
  for each selected Cohort C:
    N_cohort(C) =
      observed root-window n for C.anchor_day on the first carrier
      primitive rooted at A

    source-layer timing transitions:
      T_source =
        resolved source-ledger timing transitions for carrier + subject
        edges under the active model-source preference

    carrier-only increments at X:
      g_carrier(C, u) =
        reach-preserving A -> X arrival increment on source day u,
        computed from T_source and scaled by N_cohort(C)

    X_prefix(C, tau) =
      N_cohort(C) * G_carrier(C, tau)

    for each subject primitive source node U in X -> end:
      M_select(U, C, u) =
        N_cohort(C) * reach-preserving A -> U arrival increment
        on source day u, computed by the unified timing composer over
        carrier plus preceding subject-source transitions
      # For the first subject edge U == X:
      #   M_select(X, C, u) = N_cohort(C) * g_carrier(C, u)
      # Single-hop is only the one-edge degeneracy of this rule.

for each subject primitive U -> V:
  for each primitive-bound row r on edge U -> V:
    d_obs = r.observed_date       # primitive source day at U
    d_ret = r.retrieved_at        # chart retrieval day

    if r.n_weighted <= 0:
      drop row as unusable for local-rate display
      continue

    local_rate = r.k_weighted / r.n_weighted

    for each selected Cohort C:
      source_mass = M_select(U, C, d_obs)
      if source_mass <= 0:
        continue

      tau = d_ret - C.anchor_day
      if tau < 0:
        continue

      subject_source_day_cell[edge U -> V, C, d_obs, tau].n += r.n_weighted * placement_share
      subject_source_day_cell[edge U -> V, C, d_obs, tau].k += r.k_weighted * placement_share
      subject_source_day_cell[edge U -> V, C, d_obs, tau].coverage_share += placement_share

for each subject primitive U -> V, selected Cohort C, source day u, and tau:
  latest_n, latest_k =
    latest subject_source_day_cell[edge U -> V, C, u, t].n/k
    where t <= tau

  if latest_n > 0:
    latest_rate = latest_k / latest_n
    attributed_destination_mass[edge U -> V, C, u, tau] =
      M_select(U, C, u) * latest_rate
    attributed_destination_coverage[edge U -> V, C, u, tau] =
      latest carried coverage for that source day

compose subject prefix:
  for each selected Cohort C and tau:
    subject_y =
      topology_compose attributed destination mass across X -> end
      after per-source-day carry-forward

    Y_prefix(C, tau) = subject_y
    X_prefix(C, tau) already comes from the carrier-only prefix

pair selected prefix:
  for each selected Cohort C and tau:
    paired_prefix[C, tau].x_at_query_x = X_prefix(C, tau)
    paired_prefix[C, tau].y_at_subject_end = Y_prefix(C, tau)
    paired_prefix[C, tau].carrier_coverage = carrier prefix coverage
    paired_prefix[C, tau].subject_coverage = subject prefix coverage
```

Invariants:

- `d_obs` identifies the primitive source day whose selected source-node mass scales the row. `d_ret` decides the row's selected-A chart `tau`.
- Subject row values are local rates (`k/n`) scaled by selected source-node mass. Raw `k` is not selected-Cohort destination mass.
- The denominator prefix is carrier-only: `X_prefix(C, tau) = N_cohort(C) * G_carrier(C, tau)`. It is not rate-attributed and must not be sourced from subject rows.
- Selected source-node mass is a runtime-resolved surface built from source-layer timing transitions. It must not be sourced from the joint selected A-clock backmap, subject evidence, or posterior-conditioned draw surfaces.
- Single-hop and multi-hop use the same subject-span evidence projection; single-hop is just the one-edge degenerate subject span.
- Carry-forward happens per primitive source day before superaddition across source days.
- Coverage is role-aware. Carrier coverage and subject coverage are computed separately; row coverage is the weaker side.

**Implementation note:** the live selected-prefix amplitude is built by `model_span_spine.project_selected_cohort_rows`, which materialises the strict cumulative evidence surfaces (`evidence_x_strict`, `evidence_y_strict`, `rate_strict`) on a `SelectedCohortRowProjection`. `_project_runtime_rows` reads those strict surfaces directly; there is no separate raw-`k` `observed_count` surface in the production path. (The earlier `_row_selected_a_clock_placements` / `_build_observed_span_evidence_surface` placement-and-collapse functions were removed in the empirical-spine cutover.)

**Implementation note:** if the unified timing composer cannot populate `M_select` for a downstream subject source node, that node contributes zero and provenance records the missing mass surface. Projection must not reconstruct missing downstream mass from observed evidence.

## A.8 Selected-Cohort Evidence Aggregate

Input:

- paired selected A-clock prefix cells;
- selected Cohort set;
- row `tau` range.

Semantic pseudo-code:

```text
for each tau:
  contributing_cohorts = []

  for each selected Cohort C:
    latest_cell = paired_prefix[C, tau]
    if latest_cell exists:
      contributing_cohorts.append(C)
      sum_x += latest_cell.x_at_query_x
      sum_y += latest_cell.y_at_subject_end

  if contributing_cohorts is empty:
    aggregate_by_tau[tau] = absent
  else:
    evidence_x = numeric sum_x
    evidence_y = numeric sum_y
    rate = evidence_y / evidence_x if evidence_x > 0 else undefined
    coverage = |contributing_cohorts| / |admissible_selected_cohorts|
```

Invariants:

- "Covered with zero mass" is numeric zero, not absence.
- `rate = None` when `evidence_x == 0` because `0 / 0` is undefined; `evidence_y == 0` with positive `evidence_x` is a real zero rate.
- Coverage is a simple Cohort applicability display scalar; evidence values describe what was observed.
- The aggregate is a projection of the selected prefix. It must not repair upstream non-monotonicity by sorting, clipping, cumulative-max, or smoothing.
- The same prefix object must feed A.9 frontier state; otherwise the epoch A/B seam can gap even if both sides use the same latency weights.

**Implementation note:** the live per-τ selected aggregate is the cumulative `_cell_at_or_before(τ)` clamp inside `model_span_spine.project_selected_cohort_rows`, emitted as `evidence_x_strict` / `evidence_y_strict` (with `rate_strict`) on the `SelectedCohortRowProjection`. It preserves the "cells are cumulative paired prefixes" assumption for active selected evidence and is intentionally not a monotonicity repair layer. (This replaces the deleted `SelectedAClockEvidence.aggregate_by_tau` authority, whose semantics the strict surface reproduces.)

## A.9 Selected-Cohort E+F Reduction

This is the E+F trajectory authority. It answers the chart question as a selected-Cohort group rate, not as an average of per-Cohort rates.

Input:

- selected Cohorts;
- observed prefixes;
- `composed_carrier`;
- `composed_subject`;
- per-particle draw family.

Semantic pseudo-code:

```text
for each particle s:
  for each row tau:
    X_total = 0
    Y_total = 0

    for each selected Cohort C:
      frontier = C.frontier_age

      if tau <= frontier:
        if selected prefix exists:
          X_C_tau = selected X prefix for C at tau
          Y_C_tau = selected Y prefix for C at tau
        else if selected A-clock evidence was requested:
          skip this Cohort as absent from selected prefix
        else:
          X_C_tau = identity-carrier engine observed X prefix for C at tau
          Y_C_tau = identity-carrier engine observed Y prefix for C at tau

      else:
        x_frozen = X_prefix(C, frontier)
        y_frozen = Y_prefix(C, frontier)

        if population_root == X:
          # Identity carrier: denominator is fixed.
          X_C_tau = x_frozen
          future_x_pool = 0
        else:
          # Active carrier: denominator can still grow from A to X.
          future_x_pool = C.a_pop - x_frozen
          X_C_tau = x_frozen + projected future arrivals to X by tau

        # Pop D: already at X at the frontier, not yet at subject end.
        Y_from_D = projected subject progression for frontier X survivors

        # Pop C: not yet at X at the frontier; subject clock starts when
        # each member reaches X.
        if population_root == X:
          Y_from_C = 0
        else:
          Y_from_C = projected future arrivals to X convolved with subject progression

        Y_C_tau = y_frozen + Y_from_D + Y_from_C

      X_total += X_C_tau
      Y_total += Y_C_tau

    rate_draw[s, tau] = Y_total / X_total if X_total > 0 else NaN
```

Invariants:

- The reducer sums mass first and divides once: `sum(Y) / sum(X)`.
- It never computes `Y / A`.
- Pop C is empty for identity carrier.
- Pop D and Pop C are valid additive future numerator terms only under the factorised representation.
- `x_frozen` and `y_frozen` must come from the same selected prefix object that A.8 projects for the evidence line. The seam at `frontier` dovetails by identity only when A.8 and A.9 share that prefix.

**Implementation note:** the live selected-Cohort E+F group rate is `SelectedCohortRowProjection.ef_rate_draws`, built by `_project_frontier_continuation_surfaces` and read by `_project_runtime_rows` for midpoint/fan; it is authoritative over the selected prefix and does not fall through to legacy per-anchor `engine_cohorts` observed prefixes for missing active anchors. The `engine_cohorts` (`CohortEvidence`) path remains the identity-carrier / window evidence path.

## A.10 Model-Only Overlays

Input:

- unconditioned `composed_subject`;
- optional unconditioned `composed_carrier`;
- row `tau` range.

Semantic pseudo-code:

```text
for each row tau:
  if population_root == X:
    model_rate[tau] = subject reach and timing surface at tau
  else:
    model_rate[tau] = composed carrier-to-X timing convolved with subject span timing

emit:
  model_midpoint
  model_fan_* / model_bands
  optional model_curve_* epistemic overlay
```

Invariants:

- Model overlays are not evidence fields.
- The model-only surface does not patch missing selected A-clock evidence.
- The overlay reads unconditioned runtime surfaces; it does not re-resolve carrier or subject semantics.

## A.11 Row Projection

Input:

- selected-Cohort E+F rate draws;
- selected A-clock evidence aggregate when available;
- identity-carrier `engine_cohorts` observed prefixes when applicable;
- model overlays;
- runtime completeness.

Semantic pseudo-code:

```text
for each row tau:
  row.midpoint, row.fan_* = quantiles(selected-Cohort E+F rate draws at tau)

  if population_root == X:
    row.evidence_x, row.evidence_y = aggregate identity-carrier observed prefixes
    row.rate = row.evidence_y / row.evidence_x if row.evidence_x > 0 else None
  else if selected A-clock evidence aggregate exists at tau:
    row.evidence_x = aggregate.evidence_x
    row.evidence_y = aggregate.evidence_y
    row.rate = aggregate.rate
    row.coverage = aggregate.coverage
  else:
    row.evidence_* = absent
    row.rate = absent

  row.model_midpoint, row.model_fan_* = model-only overlay at tau
  # scalar p@infinity / completeness@frontier are emitted by the scalar reducer,
  # not by cohort_maturity rows
```

Invariants:

- `_project_runtime_rows` is a chart-row projection. It does not re-decide carrier, subject span, admission, scalar `p@infinity`, or evidence binding.
- Active evidence-named fields read only from selected A-clock evidence; if that machinery is absent, the fields are absent.
- Public scalar moments come from the scalar reducer over resolved runtime/bundle surfaces, not from the final row's midpoint by convention.

**Implementation note:** window and `cohort(A = X)` evidence display still reads frame-derived `engine_cohorts` observed prefixes. The later Atom 2 design in [`cohort-maturity-evidence-coverage-design.md`](../cohort-maturity-evidence-coverage-design.md) intends to unify identity-carrier evidence onto the selected-evidence substrate, but that is not the current code path.

## A.12 Provenance, Identity, And Cache Boundaries

Input:

- runtime object;
- conditioned primitives;
- composed spans;
- response row list.

Semantic pseudo-code:

```text
attach first-row metadata:
  population_root
  denominator_node
  subject_end
  carrier_span provenance
  subject_span provenance
  numerator_representation
  admission_policy
  primitive registry summary
  conditioning provenance
  selected A-clock evidence provenance when present

cache identities:
  prefix arrival map identity =
    request root + context/regime/asat + source preference + parameter fingerprint
  primitive posterior identity =
    transition + role + prior identity + evidence identity + algorithm parameters
  composed subject identity =
    subject primitive identities + subject arrival-map identity
  composed carrier identity =
    carrier primitive identities + carrier arrival-map identity
```

Invariants:

- Caller labels such as `scenario_id` are not mathematical identity unless they actually slice priors or evidence.
- Provenance is the diagnostic surface; consumers must not scrape lower-level labels to infer runtime roles.
- Cache identity follows the mathematics of binding, priors, evidence, and timing. It is not a display concern.

Implementation notes:

- `PrefixArrivalIdentity` and `DrawFamilyKey` canonical strings now avoid treating `scenario_id` / `scenario_seed` as mathematical identity by themselves.
- Primitive posterior cache keys include the resolved model, prior source, options, and the admitted weighted row tuples including both `observed_date` and `retrieved_at`.
- The request primitive registry key still includes `PrimitiveScope`, whose scope fields include scenario context; this is broader than the pure mathematical identity ideal.
- The composed-span cache is process-local and currently keys partly on primitive object identity. That is acceptable as a memoisation implementation detail, but it is not the stable mathematical identity described above and must not be treated as a portable cache contract.
- Row metadata is intentionally compact by default. Large selected A-clock evidence diagnostics are emitted only under diagnostic mode to avoid oversized response payloads.
