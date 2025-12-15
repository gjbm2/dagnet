
# stats-fixes.md

Date: 12-Dec-25

## Context (not yet implemented)

This note captures a set of issues observed while comparing cohort-based analyses over different horizons on the same graph configuration. This is **diagnostic** and describes **known gaps** in the current behaviour (work still pending). The focus is the interaction between:

- **`p.evidence`**: observed conversion rate in the selected cohort window.
- **`p.forecast`**: baseline/asymptotic conversion probability derived from window-based baseline data.
- **`p.mean`**: the probability used for graph calculations, intended to incorporate latency awareness for immature cohorts.
- **Latency maturity**: long-lag edges (high `t95`) mean recent cohorts are structurally immature.

## Observations

- **Start→success differs materially between short vs longer cohort windows** when using the `p.mean` layer.
- Several **latency-enabled edges** show:
  - non-trivial lag (`t95` ≈ 7–17 days; e.g. registration→success `t95` ≈ 13.1 days),
  - large swings in `p.mean` and/or `p.evidence` between horizons,
  - and in some cases `p.evidence` can be near-zero in short windows even when `p.forecast` is non-zero.

## Why this is suspicious

For long-lag edges, a short cohort window is expected to be immature. The intended behaviour (per the LAG design) is that immature cohorts should not systematically drag overall conversion down *below what the evidence already implies*, and should not overpower the baseline forecast unless the evidence is strong and mature.

Key “sanity” expectations that should hold for cohort-mode latency edges:

- **Immaturity should not create spurious collapse**: if cohorts are immature, the model should lean towards baseline forecasts for eventual conversion (rather than towards raw partial observations).
- **Conditionals must be respected**: if an edge has conditional probability cases, analysis should apply the appropriate conditional branch in the relevant contexts, rather than collapsing everything to an unconditional scalar.
- **No cross-layer mutation**: the forecast layer should not be implicitly rewritten as a side-effect of mean-layer operations (rebalancing, aggregation, etc.).

## Working hypotheses (what to check / implement)

### 1) Baseline forecast derivation may be biased for long-lag edges

For latency edges, a “baseline” derived from `window()` data must avoid including an immature tail of exposures (or must explicitly correct for it). Otherwise, the stored forecast can be biased low even if it is “recency-weighted”.

**Checkpoints**
- Confirm whether stored forecast is computed from “mature-only” data (or corrected), especially for edges with `t95` in the 10–20 day range.
- Verify whether forecast storage is accidentally equal to a raw window mean on latency edges.

### 2) Cohort-mode `p.mean` should be computed via completeness-weighted blending (no “Formula A”)

For immature cohorts, raw `p.evidence.mean = Σk/Σn` is a partial observation and will be biased low. The system should therefore lean on the baseline forecast when completeness is low.

Design stance (Phase 1+2 target):

- `p.mean` is computed via the canonical **completeness-weighted blend** of `p.evidence.mean` (narrow query cohort set) and `p.forecast.mean` (baseline window slice).
- Phase 2 strengthens the completeness calculation by applying the “t95 tail constraint” so the CDF used for completeness does not contradict the authoritative `t95`.
- Phase 2 explicitly deletes the “Formula A / tail substitution” construct to avoid ambiguity and duplicated estimators.

**Checkpoints**
- Ensure cohort-mode `p.mean` leans towards forecast when completeness is low and towards evidence when completeness is high.
- Ensure weighting uses the correct population (`p.n` where present, otherwise evidence `n`), and uses baseline-window `n` for the forecast prior strength.

### 3) Conditional probability handling can change the effective evidence view of success

Edges with conditional cases (e.g. a conditional applied when `visited(gave-bds-in-onboarding)`) can materially change the overall conversion. Any “single scalar” evaluation of such edges can be misleading.

**Checkpoints**
- Confirm that the analysis path being used (and any “overall” success computation) applies conditional branches correctly.

## Run outputs (verbatim)

### Run A output

```
e.switch-registered-to-post-registration-failure.p.mean: 0.306
e.switch-registered-to-post-registration-failure.p.forecast.mean: 0.306
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.mean: 0.6246
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.stdev: 0.0197773462324954
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.evidence.mean: 0.4256
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.evidence.stdev: 0.0197773462324954
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.forecast.mean: 0.6246
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.completeness: 1
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.t95: 5
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.median_lag_days: 0.0008546016607074589
e.86469c9f-2f83-49ca-a154-589231be5511->addb99b6-5773-482c-a437-4661c8433ff7.p.mean: 0.4716
e.86469c9f-2f83-49ca-a154-589231be5511->addb99b6-5773-482c-a437-4661c8433ff7.p.forecast.mean: 0.4716
e.switch-registered-to-switch-success.p.mean: 0.694
e.switch-registered-to-switch-success.p.stdev: 0
e.switch-registered-to-switch-success.p.evidence.mean: 0
e.switch-registered-to-switch-success.p.evidence.stdev: 0
e.switch-registered-to-switch-success.p.forecast.mean: 0.694
e.switch-registered-to-switch-success.p.latency.completeness: 5.243998075776801e-7
e.switch-registered-to-switch-success.p.latency.t95: 13.115223155653922
e.switch-registered-to-switch-success.p.latency.median_lag_days: 6.397812283446865
e.household-created-to-household-delegated.p.mean: 0.5284218399401646
e.household-created-to-household-delegated.p.stdev: 0.009653562245302725
e.household-created-to-household-delegated.p.evidence.mean: 0.5284218399401646
e.household-created-to-household-delegated.p.evidence.stdev: 0.009653538207859165
e.gave-bds-in-onboarding-to-no-recommendation-sent.p.mean: 0.2119
e.gave-bds-in-onboarding-to-no-recommendation-sent.p.forecast.mean: 0.2119
e.mobile-or-broadband-first-rec-to-post-recommendation-failure.p.mean: 0.93
e.mobile-or-broadband-first-rec-to-post-recommendation-failure.p.forecast.mean: 0.93
e.mobile-or-broadband-first-rec-to-switch-registered.p.mean: 0.07
e.mobile-or-broadband-first-rec-to-switch-registered.p.stdev: 0
e.mobile-or-broadband-first-rec-to-switch-registered.p.evidence.mean: 0
e.mobile-or-broadband-first-rec-to-switch-registered.p.evidence.stdev: 0
e.mobile-or-broadband-first-rec-to-switch-registered.p.forecast.mean: 0.07
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.completeness: 0.06846535184903607
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.t95: 17.25468880046142
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.median_lag_days: 7.109118964174457
e.household-delegated-to-mobile-or-broadband-first-rec.p.mean: 0.1982
e.household-delegated-to-mobile-or-broadband-first-rec.p.stdev: 0.0054085565612678145
e.household-delegated-to-mobile-or-broadband-first-rec.p.evidence.mean: 0.043170559094125975
e.household-delegated-to-mobile-or-broadband-first-rec.p.evidence.stdev: 0.005406796457011201
e.household-delegated-to-mobile-or-broadband-first-rec.p.forecast.mean: 0.1982
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.completeness: 0.4271103300773067
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.t95: 6.910560895052514
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.median_lag_days: 2.5
e.household-delegated-to-no-recommendation-sent.p.mean: 0.2968
e.household-delegated-to-no-recommendation-sent.p.forecast.mean: 0.2968
e.gave-bds-in-onboarding-to-energy-rec.p.mean: 0.7881
e.gave-bds-in-onboarding-to-energy-rec.p.stdev: 0.027358978128039182
e.gave-bds-in-onboarding-to-energy-rec.p.evidence.mean: 0.2744360902255639
e.gave-bds-in-onboarding-to-energy-rec.p.evidence.stdev: 0.027360096802091404
e.gave-bds-in-onboarding-to-energy-rec.p.forecast.mean: 0.708
e.gave-bds-in-onboarding-to-energy-rec.p.latency.completeness: 0.49192595720796123
e.gave-bds-in-onboarding-to-energy-rec.p.latency.t95: 4.919209135322717
e.gave-bds-in-onboarding-to-energy-rec.p.latency.median_lag_days: 2.003889944856854
e.energy-rec-to-post-recommendation-failure.visited(gave-bds-in-onboarding).p.mean: 0.637
e.energy-rec-to-post-recommendation-failure.exclude(gave-gave-bds-in-onboarding).p.mean: 0.804
e.energy-rec-to-post-recommendation-failure.p.mean: 0.8197
e.energy-rec-to-post-recommendation-failure.p.forecast.mean: 0.8197
e.household-delegated-to-viewed-coffee-screen.p.mean: 0.3048
e.household-delegated-to-viewed-coffee-screen.p.stdev: 0.013221317149823643
e.household-delegated-to-viewed-coffee-screen.p.evidence.mean: 0.4451521585279547
e.household-delegated-to-viewed-coffee-screen.p.evidence.stdev: 0.013221176752106599
e.household-delegated-to-viewed-coffee-screen.p.forecast.mean: 0.3048
e.viewed-coffee-screen-to-energy-rec.p.mean: 0.2272
e.viewed-coffee-screen-to-energy-rec.p.stdev: 0.016719073658549386
e.viewed-coffee-screen-to-energy-rec.p.evidence.mean: 0.2256
e.viewed-coffee-screen-to-energy-rec.p.evidence.stdev: 0.016719073658549386
e.viewed-coffee-screen-to-energy-rec.p.forecast.mean: 0.2272
e.viewed-coffee-screen-to-energy-rec.p.latency.completeness: 0.4343056992324322
e.viewed-coffee-screen-to-energy-rec.p.latency.t95: 6.910560895052514
e.viewed-coffee-screen-to-energy-rec.p.latency.median_lag_days: 2.5
e.viewed-coffee-screen-to-no-recommendation-sent.p.mean: 0.1482
e.viewed-coffee-screen-to-no-recommendation-sent.p.forecast.mean: 0.1482
e.energy-rec-to-switch-registered.visited(gave-bds-in-onboarding).p.mean: 0.36257309941520466
e.energy-rec-to-switch-registered.visited(gave-bds-in-onboarding).p.stdev: 0.03676333723816272
e.energy-rec-to-switch-registered.exclude(gave-gave-bds-in-onboarding).p.mean: 0.1964573268921095
e.energy-rec-to-switch-registered.exclude(gave-gave-bds-in-onboarding).p.stdev: 0.015943834875444898
e.energy-rec-to-switch-registered.p.mean: 0.1803
e.energy-rec-to-switch-registered.p.stdev: 0.007412096485605581
e.energy-rec-to-switch-registered.p.evidence.mean: 0.01834862385321101
e.energy-rec-to-switch-registered.p.evidence.stdev: 0.0074217532684460255
e.energy-rec-to-switch-registered.p.forecast.mean: 0.165
e.energy-rec-to-switch-registered.p.latency.completeness: 0.0006088919072612892
e.energy-rec-to-switch-registered.p.latency.t95: 11.933639521699034
e.energy-rec-to-switch-registered.p.latency.median_lag_days: 8.304757248066533
e.household-delegated-to-energy-rec.p.mean: 0.2002
e.household-delegated-to-energy-rec.p.stdev: 0.006971900058435617
e.household-delegated-to-energy-rec.p.evidence.mean: 0.0782198246797033
e.household-delegated-to-energy-rec.p.evidence.stdev: 0.006972708753993969
e.household-delegated-to-energy-rec.p.forecast.mean: 0.2002
e.household-delegated-to-energy-rec.p.latency.completeness: 0.4217262989240945
e.household-delegated-to-energy-rec.p.latency.t95: 6.910560895052514
e.household-delegated-to-energy-rec.p.latency.median_lag_days: 2.5
n.household-created.entry.entry_weight: 1
```

### Run B output

```
e.switch-registered-to-post-registration-failure.p.mean: 0.2848
e.switch-registered-to-post-registration-failure.p.forecast.mean: 0.2848
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.mean: 0.4873
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.stdev: 0.009847306867381061
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.evidence.mean: 0.43836155966916107
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.evidence.stdev: 0.009847212129158834
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.forecast.mean: 0.4873
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.completeness: 1
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.t95: 5
e.viewed-coffee-screen-to-gave-bds-in-onboarding.p.latency.median_lag_days: 0.0008546016607074589
e.86469c9f-2f83-49ca-a154-589231be5511->addb99b6-5773-482c-a437-4661c8433ff7.p.mean: 0.4708
e.86469c9f-2f83-49ca-a154-589231be5511->addb99b6-5773-482c-a437-4661c8433ff7.p.forecast.mean: 0.4708
e.switch-registered-to-switch-success.p.mean: 0.7152
e.switch-registered-to-switch-success.p.stdev: 0.023529215025825737
e.switch-registered-to-switch-success.p.evidence.mean: 0.44966442953020136
e.switch-registered-to-switch-success.p.evidence.stdev: 0.023529044850054654
e.switch-registered-to-switch-success.p.forecast.mean: 0.694
e.switch-registered-to-switch-success.p.latency.completeness: 0.6032414791916322
e.switch-registered-to-switch-success.p.latency.t95: 13.115223155653922
e.switch-registered-to-switch-success.p.latency.median_lag_days: 6.397812283446865
e.household-created-to-household-delegated.p.mean: 0.5291551678091339
e.household-created-to-household-delegated.p.stdev: 0.004709559253945147
e.household-created-to-household-delegated.p.evidence.mean: 0.5291551678091339
e.household-created-to-household-delegated.p.evidence.stdev: 0.004709583980415417
e.gave-bds-in-onboarding-to-no-recommendation-sent.p.mean: 0.1074
e.gave-bds-in-onboarding-to-no-recommendation-sent.p.forecast.mean: 0.1074
e.mobile-or-broadband-first-rec-to-post-recommendation-failure.p.mean: 0.8943
e.mobile-or-broadband-first-rec-to-post-recommendation-failure.p.forecast.mean: 0.8943
e.mobile-or-broadband-first-rec-to-switch-registered.p.mean: 0.1057
e.mobile-or-broadband-first-rec-to-switch-registered.p.stdev: 0.006366542624025584
e.mobile-or-broadband-first-rec-to-switch-registered.p.evidence.mean: 0.038419319429198684
e.mobile-or-broadband-first-rec-to-switch-registered.p.evidence.stdev: 0.006368079987441264
e.mobile-or-broadband-first-rec-to-switch-registered.p.forecast.mean: 0.07
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.completeness: 0.8480281959625248
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.t95: 17.25468880046142
e.mobile-or-broadband-first-rec-to-switch-registered.p.latency.median_lag_days: 7.109118964174457
e.household-delegated-to-mobile-or-broadband-first-rec.p.mean: 0.1444
e.household-delegated-to-mobile-or-broadband-first-rec.p.stdev: 0.0040210535494858415
e.household-delegated-to-mobile-or-broadband-first-rec.p.evidence.mean: 0.10743801652892562
e.household-delegated-to-mobile-or-broadband-first-rec.p.evidence.stdev: 0.004021679509540667
e.household-delegated-to-mobile-or-broadband-first-rec.p.forecast.mean: 0.1444
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.completeness: 0.863042047356399
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.t95: 6.910560895052514
e.household-delegated-to-mobile-or-broadband-first-rec.p.latency.median_lag_days: 2.5
e.household-delegated-to-no-recommendation-sent.p.mean: 0.2456
e.household-delegated-to-no-recommendation-sent.p.forecast.mean: 0.2456
e.gave-bds-in-onboarding-to-energy-rec.p.mean: 0.8926
e.gave-bds-in-onboarding-to-energy-rec.p.stdev: 0.014358307144038714
e.gave-bds-in-onboarding-to-energy-rec.p.evidence.mean: 0.6320921985815603
e.gave-bds-in-onboarding-to-energy-rec.p.evidence.stdev: 0.014358370772330604
e.gave-bds-in-onboarding-to-energy-rec.p.forecast.mean: 0.708
e.gave-bds-in-onboarding-to-energy-rec.p.latency.completeness: 0.8801678723842894
e.gave-bds-in-onboarding-to-energy-rec.p.latency.t95: 4.919209135322717
e.gave-bds-in-onboarding-to-energy-rec.p.latency.median_lag_days: 2.003889944856854
e.energy-rec-to-post-recommendation-failure.visited(gave-bds-in-onboarding).p.mean: 0.637
e.energy-rec-to-post-recommendation-failure.exclude(gave-gave-bds-in-onboarding).p.mean: 0.804
e.energy-rec-to-post-recommendation-failure.p.mean: 0.7435
e.energy-rec-to-post-recommendation-failure.p.forecast.mean: 0.7435
e.household-delegated-to-viewed-coffee-screen.p.mean: 0.3918
e.household-delegated-to-viewed-coffee-screen.p.stdev: 0.00642505191101359
e.household-delegated-to-viewed-coffee-screen.p.evidence.mean: 0.43203230148048455
e.household-delegated-to-viewed-coffee-screen.p.evidence.stdev: 0.0064251094114040445
e.household-delegated-to-viewed-coffee-screen.p.forecast.mean: 0.3918
e.viewed-coffee-screen-to-energy-rec.p.mean: 0.4087
e.viewed-coffee-screen-to-energy-rec.p.stdev: 0.009829585544085973
e.viewed-coffee-screen-to-energy-rec.p.evidence.mean: 0.4322834645669291
e.viewed-coffee-screen-to-energy-rec.p.evidence.stdev: 0.0098295407016348
e.viewed-coffee-screen-to-energy-rec.p.forecast.mean: 0.4087
e.viewed-coffee-screen-to-energy-rec.p.latency.completeness: 0.860389106592498
e.viewed-coffee-screen-to-energy-rec.p.latency.t95: 6.910560895052514
e.viewed-coffee-screen-to-energy-rec.p.latency.median_lag_days: 2.5
e.viewed-coffee-screen-to-no-recommendation-sent.p.mean: 0.104
e.viewed-coffee-screen-to-no-recommendation-sent.p.forecast.mean: 0.104
e.energy-rec-to-switch-registered.visited(gave-bds-in-onboarding).p.mean: 0.36257309941520466
e.energy-rec-to-switch-registered.visited(gave-bds-in-onboarding).p.stdev: 0.03676333723816272
e.energy-rec-to-switch-registered.exclude(gave-gave-bds-in-onboarding).p.mean: 0.1964573268921095
e.energy-rec-to-switch-registered.exclude(gave-gave-bds-in-onboarding).p.stdev: 0.015943834875444898
e.energy-rec-to-switch-registered.p.mean: 0.2565
e.energy-rec-to-switch-registered.p.stdev: 0.0065405122674685266
e.energy-rec-to-switch-registered.p.evidence.mean: 0.14589769996567112
e.energy-rec-to-switch-registered.p.evidence.stdev: 0.0065404695199582545
e.energy-rec-to-switch-registered.p.forecast.mean: 0.165
e.energy-rec-to-switch-registered.p.latency.completeness: 0.8015923760760675
e.energy-rec-to-switch-registered.p.latency.t95: 11.933639521699034
e.energy-rec-to-switch-registered.p.latency.median_lag_days: 8.304757248066533
e.household-delegated-to-energy-rec.p.mean: 0.2182
e.household-delegated-to-energy-rec.p.stdev: 0.004960447207411728
e.household-delegated-to-energy-rec.p.evidence.mean: 0.18969105170481831
e.household-delegated-to-energy-rec.p.evidence.stdev: 0.004960357600827143
e.household-delegated-to-energy-rec.p.forecast.mean: 0.2182
e.household-delegated-to-energy-rec.p.latency.completeness: 0.8622896238499133
e.household-delegated-to-energy-rec.p.latency.t95: 6.910560895052514
e.household-delegated-to-energy-rec.p.latency.median_lag_days: 2.5
n.household-created.entry.entry_weight: 1
```


