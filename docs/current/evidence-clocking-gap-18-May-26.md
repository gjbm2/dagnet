# Evidence Clocking Gap

**Date**: 18-May-26  
**Status**: Investigation note  
**Scope**: `cohort(a, 1-Apr:1-Apr).from(b).to(c)` as the minimal case for carrier/subject evidence clocking, with implications for `window()` and multi-hop generalisation.

> **Correction from later same-session inspection**: the live row amplitude
> path has already moved on from `SelectedAClockEvidence.aggregate_by_tau`.
> Strict `evidence_x`, `evidence_y`, and `rate` now come from
> `model_span_spine.project_selected_cohort_rows(...)`, specifically the
> empirical carrier and subject spans. A focused prime-valued toy test at
> `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py` confirms that,
> when the empirical spine is supplied correctly clocked typed candidates, the
> core `a -> b` then `b -> c` date-reference algebra is reproduced. The
> remaining defect search should therefore focus on production candidate /
> envelope / seed construction feeding the empirical spans, not on
> `SelectedAClockEvidence` as the strict evidence amplitude authority.

## Summary

Window evidence is not intrinsically wrong. In the spreadsheet discipline, `a[x]`, `b[x]`, and `c[x]` are just dated arrival arrays. A `window()` row is valid raw material for local edge behaviour.

The gap is not "window evidence bad". The gap is that the current runtime appears to normalise evidence into local rates and then reapply those rates to a selected incipient mass object. That is exact only when the incipient mass divided out is the same object as the incipient mass multiplied back in, or when stationarity makes the substitution harmless.

For active `cohort(A != X)`, that equivalence is not automatic.

## Target Clock Discipline

For:

```text
cohort(a, 1-Apr:1-Apr).from(b).to(c)
```

The intended evidence objects are:

- Carrier: `a -> b`
- Subject: `b -> c`
- Displayed rate: `y / x`, not `y / a`

In date-reference terms:

```text
x_tau = carrier evidence mass at b, placed on the selected a[1] clock
```

For a uniform 10-day `a -> b` latency and one-day buckets, this becomes a weighted sum of dated `b[...]` cells. For example:

```text
tau=1:
x_tau = 0.05*b[1] + 0.05*b[2]
```

The subject numerator must be placed on the composed selected-cohort clock:

```text
y_tau = subject evidence mass at c, placed on the selected a[1] clock
```

For a uniform 10-day `a -> b` carrier and a uniform 5-day `b -> c` subject, this becomes a weighted sum of dated `c[...]` cells. For example:

```text
tau=1:
y_tau = 0.003333*c[1] + 0.006667*c[2]
```

The rate-normalisation form is valid as an algebraic rewrite:

```text
x_tau = (carrier_pass_mass / selected_a_incipient_mass) * selected_a_incipient_mass

y_tau = (subject_pass_mass / selected_b_incipient_mass) * selected_b_incipient_mass
```

But the cancellation is only exact if the denominator and multiplier are the same clocked incipient mass object.

## What The Current Code Implies

The relevant code surfaces are:

- `graph-editor/lib/runner/primitive_evidence.py`
- `graph-editor/lib/runner/model_span_spine.py`
- `graph-editor/lib/runner/prefix_arrival.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/runner/request_envelope.py`

### Primitive Binding

`bind_primitive_evidence` in `primitive_evidence.py` takes admitted candidate rows and multiplies each row by `arrival_weights.weight_on(observed_date)`. It also records `root_day_shares`.

That means primitive evidence is converted into a clock-weighted local view:

```text
n_weighted = n * arrival_weight
k_weighted = k * arrival_weight
```

This is the "divide by incipient mass / local rate" substrate. It is not, by itself, wrong. It is a useful generalisation if the downstream reapplication uses the right selected incipient mass.

### Carrier Binding

In `model_span_spine.py`, carrier primitives use:

```text
carrier_arrival_map.nodes[carrier_source]
```

For active cohort mode, `request_envelope.py` builds this carrier map rooted at the selected anchor `A`. That part matches the desired carrier clock: `a -> b` evidence is weighted on the `a` clock.

### Subject Binding

Subject primitives use an X-rooted subject arrival map. In active mode, the request envelope builds the subject root support from carrier arrivals at X. In `window()` mode, subject primitives use local identity weights.

This is also not intrinsically wrong. It means subject primitives are conditioned as local subject operators. The question is whether selected-row evidence later re-applies them onto the selected `A` clock correctly.

## The Carrier Gap

The selected evidence cell amplitude for `x_tau` is not directly read from re-clocked empirical `a-b.k`.

In `cohort_forecast_v3.py`, `_build_selected_a_clock_evidence_from_runtime` emits `x_at_query_x` from:

```text
x_prefix.value_at(anchor_day, tau)
```

`x_prefix` is `_CarrierOnlyDenominatorPrefix`, built by `_build_carrier_only_denominator_prefix`.

That prefix is sourced from `runtime.selected_source_day_mass`, which is built by `_build_selected_source_day_mass` using `runtime.source_layer_transitions` and `compose_timing_span_from_transition_primitives`.

So the current `x_tau` amplitude is effectively:

```text
x_tau = N_cohort(anchor) * G_model_or_prior(a -> b, tau)
```

Observed carrier evidence affects cell presence and coverage through the carrier observed surface, but the amplitude is not simply:

```text
weighted dated a-b.k references
```

This is the first gap relative to the spreadsheet discipline.

## The Subject Gap

The selected evidence cell amplitude for `y_tau` is not directly read as re-clocked empirical `b-c.k` on the composed `a-b * b-c` clock.

In `cohort_forecast_v3.py`, `_build_rate_attributed_subject_prefix` builds `Y_prefix` by reading per-source-day `n/k` buckets and multiplying a rate by `selected_source_day_mass`.

The shape is:

```text
y_tau = sum_over_source_days(
  M_select(b, anchor, source_day)
  * local_rate_b_c(source_day, age)
)
```

where:

```text
local_rate_b_c = b-c.k / b-c.n
```

So the current subject path is:

```text
y_tau = selected_b_incipient_mass * local/window b-c rate
```

not:

```text
y_tau = selected A-clock placed b-c.k mass
```

Those are equivalent only if:

```text
local/window b-c.n == selected_b_incipient_mass
```

on the same clock, or if stationarity makes the substitution safe.

For active `cohort(a, 1-Apr).from(b).to(c)`, that equality is not guaranteed. The selected `b` incipient mass is carrier-clocked from `a[1]`; the local `b-c.n` row is a dated local `b` population. They are compatible raw ingredients, but not the same object until explicitly re-clocked.

## Window Evidence Is Valid, But Needs Placement

The code frequently treats `WINDOW_SUBJECT_HELPER` as the admitted evidence role. That is not automatically a defect.

A window row for `b-c` is a valid local dated observation:

```text
b[date] -> c[date + age]
```

The problem is not the row family. The problem is whether the runtime turns that row into the selected query clock:

```text
cohort(a, 1-Apr) clock for active cohort queries
```

The current code does this by turning the row into a rate and applying selected mass. That is a stationarity-style bridge unless the incipient mass cancellation is exact.

## Multi-Hop Implication

For multi-hop `cohort(A, X -> Z)`, the same pattern generalises:

- each primitive can read local/window evidence as raw material
- each primitive's `k/n` can be used as a local rate
- the rate must be multiplied by the selected incipient mass at that primitive's source node on the selected clock

The current code attempts this through `M_select(U, C, u)` for each subject source node `U`.

The risk is that `M_select` is built from the runtime timing/model composition, while the local evidence rate is built from local/window evidence rows. That gives a model-clock selected mass times a local empirical rate. It is not a direct date-reference re-clocking of the empirical `k` arrays.

## Concrete Gap Statement

Expected exact cohort evidence algebra:

```text
x_tau = selected A-clock placement of carrier k(a-b)

y_tau = selected A-clock placement of subject k(b-c)
```

Current runtime shape:

```text
x_tau = model/prior selected carrier prefix

y_tau = selected source-day mass * local/window subject rate
```

Expanded:

```text
y_tau =
  (local/window b-c.k / local/window b-c.n)
  * selected A-clock b mass
```

This is not the same as:

```text
y_tau =
  (selected A-clock b-c.k / selected A-clock b mass)
  * selected A-clock b mass
```

unless the two denominators are the same clocked object.

## Why This Matters

The visible row fields are named like evidence:

- `evidence_x`
- `evidence_y`
- `rate`

If those fields are intended to be selected empirical evidence, then the current amplitude path is suspect:

- `x` is model/timing-prefix amplitude gated by evidence support
- `y` is selected mass times local empirical rate

That may be a useful forecast or stationarity approximation, but it is not the pure selected date-reference evidence algebra captured by the spreadsheet.

## Open Questions

1. Should `SelectedAClockEvidence` represent strict empirical selected evidence, or a rate-attributed selected projection?
2. If strict empirical selected evidence is required, should `x_tau` use observed carrier `k` mass rather than `N_cohort * G_carrier`?
3. If strict empirical selected evidence is required, should `y_tau` be built by re-clocking subject `k` mass directly onto the selected A-clock, rather than by applying local `k/n` to `M_select`?
4. If the current rate-attribution route is intentional, where is the stationarity or denominator-equivalence assumption explicitly documented and surfaced in provenance?

