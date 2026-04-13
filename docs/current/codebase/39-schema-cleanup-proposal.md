# 39 — Edge Schema Cleanup: Qualified Scalars

**Date**: 13-Apr-26
**Status**: Proposal — for review before implementation
**Motivation**: clean up the edge latency schema before v2.0 sets it
in stone. Organic growth across ~5 months of LAG, Bayes, and forecast
work has left 30+ flat fields mixing configuration, promoted values,
computed values, and uncertainty — with dispersion (`_sd`) fields
bolted on as siblings of the scalars they qualify.

---

## Design Principle

Every numeric scalar that carries uncertainty should be a qualified
object:

```ts
{ value: number; sd?: number }
```

`sd` is the standard deviation of the estimate — heuristic or
Bayesian. It qualifies the scalar, not a separate concept. There is
no "dispersion object"; there are scalars with optional uncertainty.

This already exists in two places:
- `ModelVarsProbability` (Python): `{ mean, stdev }` — the pattern
  we are generalising
- `completeness` (TS): `number | { value: number; stdev?: number }`
  — a transitional union that should become the clean object form

---

## Current State

`LatencyConfig` (edge.p.latency) has 30+ flat fields mixing four
concerns:

1. **Configuration** — user-editable inputs (latency_parameter,
   anchor_node_id, t95, path_t95, onset_delta_days, each with
   `_overridden` flags)
2. **Promoted** — winning model's output values written by
   `applyPromotion` (10 flat `promoted_*` fields carrying the same
   scalars plus their SDs)
3. **Computed** — topo pass derived values (median_lag_days,
   mean_lag_days, completeness, mu, sigma, path_mu, path_sigma,
   path_onset_delta_days, plus undeclared bare `mu_sd`, `sigma_sd`
   etc. written by `statisticalEnhancementService`)
4. **Posterior** — projected from file-level Bayesian fit
   (`LatencyPosterior`)

The `_sd` fields appear in three separate interfaces with different
naming conventions:

| Interface | Point estimate | Uncertainty | Convention |
|-----------|---------------|-------------|------------|
| `ModelVarsEntry.latency` | `mu` | `mu_sd` | siblings |
| `LatencyConfig` | `mu` | `promoted_mu_sd` | prefixed sibling |
| `LatencyPosterior` | `mu_mean` | `mu_sd` | `_mean`/`_sd` suffix |
| `SlicePosteriorEntry` | `mu_mean` | `mu_sd` | `_mean`/`_sd` suffix |

Four different conventions for the same semantic relationship.

---

## Target State

### Shape: `QualifiedScalar`

```ts
interface QualifiedScalar {
  value: number;
  sd?: number;
}
```

Python equivalent:

```python
class QualifiedScalar(BaseModel):
    value: float
    sd: Optional[float] = Field(None, ge=0)
```

### Affected fields on `LatencyConfig`

**Before → After**:

```
mu?: number                    → mu?: QualifiedScalar
sigma?: number                 → sigma?: QualifiedScalar
t95?: number                   → (no change — user input, no sd)
onset_delta_days?: number      → onset_delta_days?: QualifiedScalar
completeness?: number|{...}    → completeness?: QualifiedScalar
path_mu?: number               → path_mu?: QualifiedScalar
path_sigma?: number            → path_sigma?: QualifiedScalar
path_onset_delta_days?: number → path_onset_delta_days?: QualifiedScalar
path_t95?: number              → (no change — user input, no sd)

promoted_t95?: number              ─┐
promoted_path_t95?: number          │
promoted_onset_delta_days?: number  │
promoted_mu_sd?: number             │  promoted?: {
promoted_sigma_sd?: number          │    t95?: QualifiedScalar
promoted_onset_sd?: number          ├─→  path_t95?: QualifiedScalar
promoted_onset_mu_corr?: number     │    onset_delta_days?: QualifiedScalar
promoted_path_mu_sd?: number        │    mu?: QualifiedScalar
promoted_path_sigma_sd?: number     │    sigma?: QualifiedScalar
promoted_path_onset_sd?: number    ─┘  }
```

The 10 flat `promoted_*` fields collapse into a `promoted` sub-object
whose fields are themselves `QualifiedScalar`. The `_sd` is no longer
a naming convention — it is a structural property of the value.

**Fields that do NOT change** (they have no uncertainty to qualify):
- `latency_parameter`, `anchor_node_id` (configuration, non-numeric)
- `*_overridden` flags (booleans)
- `median_lag_days`, `mean_lag_days` (display-only, no sd computed)
- `t95`, `path_t95` (user-editable input constraints — the promoted
  versions carry sd, these do not)

### `onset_mu_corr` — the outlier

`onset_mu_corr` is a correlation coefficient between onset and μ,
not an sd on a scalar. It does not fit `QualifiedScalar`. Options:

1. Place it on `promoted` as a standalone field:
   `promoted.onset_mu_corr?: number`
2. Place it on a diagnostics sub-object alongside quality metrics

Recommendation: option 1 — it is already written/read alongside
promoted values and consumed for identifiability diagnostics.

### `p_sd` — probability uncertainty

`p_sd` currently lives as a bare field on `LatencyConfig` (written
by `statisticalEnhancementService`, undeclared in the TS interface).
Under the new scheme it belongs on the probability side, not latency:

```
edge.p.probability: number → edge.p.probability: QualifiedScalar
```

or equivalently on `ProbabilityParam`. This is a separate, smaller
migration — noted here for completeness but could be deferred.

### Affected fields on `ModelVarsEntry.latency`

Same pattern. Currently:

```
mu, sigma, t95, onset_delta_days, path_mu, path_sigma, ...
mu_sd, sigma_sd, onset_sd, onset_mu_corr, path_mu_sd, ...
```

Becomes:

```
mu: QualifiedScalar
sigma: QualifiedScalar
t95: QualifiedScalar
onset_delta_days: QualifiedScalar
path_mu?: QualifiedScalar
path_sigma?: QualifiedScalar
path_t95?: QualifiedScalar
path_onset_delta_days?: QualifiedScalar
onset_mu_corr?: number           // correlation, not sd
```

`ModelVarsProbability` already has `{ mean, stdev }` — rename to
`{ value, sd }` for consistency with `QualifiedScalar`, or keep as-is
if the churn is not justified (the shape is isomorphic).

### Affected fields on `LatencyPosterior`

Currently uses `mu_mean`/`mu_sd` naming. Becomes:

```
mu: QualifiedScalar              // .value replaces mu_mean, .sd replaces mu_sd
sigma: QualifiedScalar
onset?: QualifiedScalar          // replaces onset_mean/onset_sd
path_mu?: QualifiedScalar
path_sigma?: QualifiedScalar
path_onset?: QualifiedScalar
```

HDI bounds (`hdi_t95_lower/upper`, `onset_hdi_lower/upper`) remain
as standalone fields — they describe a credible interval, not a
point-estimate qualification.

### Affected fields on `SlicePosteriorEntry`

Same as `LatencyPosterior` — `mu_mean`/`mu_sd` → `mu: QualifiedScalar`.

---

## Impact Assessment

### Scale

| Scope | Source files | Test files | Notes |
|-------|-------------|------------|-------|
| `mu`, `sigma` | ~40 TS+PY each | ~30 each | Deepest — compiler, stats engine, topo pass, UI |
| `t95`, `path_t95` | ~25 each | ~25 each | Wide UI + planner reach |
| `onset_delta_days` | ~35 | ~20 | Touches Bayes evidence binding |
| `completeness` | ~25 | ~15 | Already has union type |
| `path_mu`, `path_sigma` | ~20 each | ~8 each | Moderate |
| `path_onset_delta_days` | ~15 | ~5 | Narrow |
| `promoted_*` (10 fields) | ~16 total | ~10 | Contained — 4 writers, 16 readers |
| `p_sd` | ~7 | ~5 | Barely consumed |
| Posterior types | ~20 | ~15 | `LatencyPosterior` + `SlicePosteriorEntry` |

**Total estimated touch points**: ~80–100 source files, ~60 test
files, across TypeScript, Python, and YAML schemas.

### High-risk areas

1. **Bayes compiler** (`bayes/compiler/`): `model.py`,
   `inference.py`, `evidence.py`, `types.py` all use bare `mu`,
   `sigma`, `onset_delta_days` extensively. The compiler builds
   PyMC models from these values — any breakage here is silent until
   MCMC runs produce wrong posteriors.

2. **Stats engine** (`runner/stats_engine.py`): the FE/BE parity
   contract compares field-by-field. Both sides must migrate in
   lockstep or parity tests will fail (which is actually a useful
   gate — see below).

3. **Topo pass** (`statisticalEnhancementService.ts`,
   `beTopoPassService.ts`): writes all computed latency fields.
   Currently writes undeclared bare `mu_sd` etc. — the migration
   must both fix the type declarations and update write sites.

4. **Cascade/projection** (`mappingConfigurations.ts`): maps
   file-level posteriors to graph-edge `LatencyPosterior`. Field
   name changes here affect every UI consumer.

5. **YAML schemas** (`public/param-schemas/`): parameter file
   schemas must match the new shape or file validation breaks.

### Low-risk areas

- **UI components** (`ModelCard`, `ParameterSection`,
  `BayesPosteriorCard`, `ConversionEdge`): mechanical `.value`
  access changes. TypeScript will catch every missed site at
  compile time.
- **CLI** (`analyse.ts`): single file, straightforward.

---

## Sequencing

### Phase 0: Infrastructure

1. Define `QualifiedScalar` type (TS) and Pydantic model (Python)
2. Add a `qs()` helper: `(value, sd?) => QualifiedScalar` to reduce
   verbosity at write sites
3. Add a `qsv()` accessor: `QualifiedScalar | undefined → number |
   undefined` for read sites during migration (extracts `.value`)

### Phase 1: `promoted_*` → `promoted` sub-object

Smallest blast radius, proves the pattern.

1. Add `PromotedLatency` interface using `QualifiedScalar` fields
2. Migrate `applyPromotion` writers (4 sites) to write `promoted.*`
3. Migrate readers (16 sites) to read from `promoted.*`
4. Remove flat `promoted_*` fields
5. Update Python `LatencyConfig` model
6. Update YAML schemas

**Gate**: all existing tests pass. `statsParity.contract.test.ts`
confirms FE/BE field-level agreement.

### Phase 2: Computed scalars on `LatencyConfig`

`mu`, `sigma`, `completeness`, `path_mu`, `path_sigma`,
`onset_delta_days`, `path_onset_delta_days`.

1. Change type declarations (TS + Python)
2. Migrate writers: `statisticalEnhancementService` (main writer),
   `beTopoPassService`, `fetchDataService`, `fileToGraphSync`
3. Migrate readers: `localAnalysisComputeService`,
   `windowFetchPlannerService`, `lagHorizonsService`,
   `forecastingParityService`, UI components, CLI
4. Drop `completeness` union type — becomes plain `QualifiedScalar`
5. Drop `completeness_stdev` from Python model (absorbed into `.sd`)

**Gate**: parity tests pass (`statsParity.contract.test.ts`,
`test_stats_engine_parity.py`). Snapshot a real graph's topo-pass
output before and after — assert field-by-field equality (values
moved into `.value`, no data lost or altered).

### Phase 3: `ModelVarsEntry.latency`

1. Change type declarations (TS + Python `ModelVarsLatency`)
2. Migrate `applyPromotion` (already done in Phase 1 — verify
   it reads the new shape correctly)
3. Migrate `modelVarsResolution`, `bayesPatchService`,
   `posteriorSliceResolution`, `fileToGraphSync`
4. Decide on `ModelVarsProbability` alignment (`mean`/`stdev` →
   `value`/`sd`) — execute or defer

**Gate**: `bayesPosteriorRoundtrip.e2e.test.ts` and
`bayesPatchServiceMerge.integration.test.ts` pass. Bayes compiler
reads model_vars correctly.

### Phase 4: Posterior types

`LatencyPosterior` and `SlicePosteriorEntry`.

1. Replace `mu_mean`/`mu_sd` with `mu: QualifiedScalar` etc.
2. Migrate cascade projection (`mappingConfigurations.ts`)
3. Migrate all UI consumers of posterior fields
4. Migrate Python writer (`worker.py` `_build_unified_slices`)

**Gate**: `bayesPosteriorRoundtrip.e2e.test.ts`,
`asatPosteriorResolution.integration.test.ts`,
`bayesChartAxisConsistency.integration.test.ts` pass.

### Phase 5: Cleanup

1. Remove `qs()`/`qsv()` migration helpers if no longer needed
2. Update `SCHEMA_AND_TYPE_PARITY.md` parity pairs
3. Update `docs/current/codebase/` docs that reference old field names
4. Run full test suite as final gate

---

## Risk Management

### Primary risk: silent numeric breakage

A field that was `edge.p.latency.mu = 0.5` becoming
`edge.p.latency.mu = { value: 0.5, sd: 0.1 }` will not throw at
runtime in JavaScript — it will silently coerce to `NaN` in
arithmetic. TypeScript catches this at compile time, but Python
`Optional[float]` fields receiving a dict will fail at Pydantic
validation (which is good — it's a hard error, not a silent one).

**Mitigation**: TypeScript strict mode is the primary safety net.
After each phase, compile the full project — every missed read site
will be a type error. For Python, Pydantic validation serves the
same role.

### Secondary risk: file format migration

Parameter files on disk store `model_vars` with the old flat shape.
Changing `ModelVarsLatency` means existing files won't validate
against the new Pydantic model.

**Mitigation**: Phase 3 must include a file migration step or a
backward-compatible reader that accepts both shapes during
transition. This is the only place where backward compatibility
matters — it's a persistence boundary, not an in-memory convention.

### Tertiary risk: FE/BE parity drift

The FE and BE topo passes must produce identical field shapes. If
one side migrates before the other, parity tests will fail.

**Mitigation**: this is a feature, not a bug. The parity tests
(`statsParity.contract.test.ts`, `test_stats_parity_contract.py`)
are the gate. Migrate both sides within the same phase.

### Regression gate (per phase)

Before starting each phase, snapshot the full topo-pass output for
a real graph. After completing the phase, re-run and assert
field-by-field equality (accounting for the structural change).
This is the parity test described in the testing standards and is
the only gate for proceeding to the next phase.

---

## What this does NOT cover

- **Probability schema** (`edge.p.probability`): `p_sd` should
  eventually qualify the probability scalar, but that is a separate
  migration on `ProbabilityParam`, not `LatencyConfig`.
- **`onset_mu_corr`**: kept as a standalone field (correlation, not
  uncertainty on a scalar). Moves into `promoted` sub-object in
  Phase 1.
- **HDI bounds**: remain as standalone fields on posterior types
  (they are interval bounds, not point-estimate qualifications).
- **`median_lag_days`, `mean_lag_days`**: no sd computed for these
  currently; remain as bare numbers. Could be qualified later if
  uncertainty estimates are added.

---

## Cross-references

- Doc 19 — promoted fields rationale (circular dependency avoidance)
- Doc 29 — completeness with uncertainty (first use of sd on a
  latency scalar)
- Doc 34 — latency dispersion background (kappa_lat, BetaBinomial)
- `SCHEMA_AND_TYPE_PARITY.md` — schema parity checklist
- `graph_types.py` — Python mirror of the schema
- `heuristic-dispersion-design.md` — heuristic sd derivation
