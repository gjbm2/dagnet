# Test fixture ownership — shared synth graphs silently invalidate everyone's oracles

**Status**: Problem statement + survey findings + implementation plan
**Created**: 20-Apr-26
**Updated**: 20-Apr-26 (added survey findings and design proposal)
**Blocking**: doc 56 (Phase 4+), doc 50 truth-parity, bayes regression, daily-conversions baselines, v2-v3 parity. Any new oracle-based devtool.

## One-sentence summary

Multiple test harnesses, oracle baselines, parity scripts, and regression suites all read the same small set of `synth-*` and `cf-fix-*` graph fixtures out of the data repo, and multiple automations regenerate those same fixtures, so whichever run happens last silently invalidates every other suite's frozen reference output.

## Concrete incident (20-Apr-26)

During doc 56 Phase 3 verification, the byte-identical RNG-parity gate on `synth-mirror-4step` started failing immediately after the code cut-over. The failure looked exactly like a code-induced regression — a perturbed RNG call order inside the refactored runtime module. It wasn't. The actual cause: between baseline capture at 20:57 and the Phase 3 verification run at ~21:55, an unrelated automation re-ran `synth_gen` and rewrote `synth-mirror-4step.json` in place on the same git SHA. The graph's internal UUIDs, event counts, and parameter numbers changed. The migration baselines, keyed by node IDs precisely so they would survive UUID churn, survived the UUID churn but not the evidence churn — different events mean different cohort windows, different priors, different rate draws.

The code change was actually byte-identical in behaviour: three other topology fixtures whose files hadn't been regenerated since the baseline capture (synth-simple-abc, cf-fix-branching, cf-fix-diamond-mixed) matched the baselines exactly — zero delta on every scalar, byte-identical rate_draws hashes. The only failing fixtures were the three whose data files had been rewritten.

## Structural cause

The data repo's `graphs/`, `cohort_data/`, and `params/` directories are a de-facto shared workspace. Every suite that needs a "reference graph" points at the same filenames. Every automation that (re)generates reference graphs writes to those same filenames. Nothing announces that it's about to write, nothing checks whether anyone else's oracle depends on the current content, and the git SHA of the data repo does not change when `synth_gen` rewrites files in place — so there is no ambient signal of drift. The first symptom is always a parity test going red after a code change that had nothing to do with the failure.

This is a textbook shared-mutable-state bug, but at the fixture layer rather than the code layer. Everyone assumes the fixture they read is the fixture that was there yesterday. That assumption is wrong, and nothing in the current tooling enforces it.

## Why re-capturing is not the fix

The obvious short-term response to "baselines don't match" is to re-capture. That moves the fragility forward in time without addressing it: the next time any automation regenerates a shared graph, the newly captured baselines also go stale. It also defeats the entire purpose of baselines — they exist to prove that a code change is behaviour-neutral, and a baseline that gets silently re-captured whenever something upstream moves is not a baseline, it's a tautology.

## The principle the user stated

"Each test fixture must own its own whole truth. You can't safely share them."

*Whole truth* is the key. Today a "fixture" informally means "a graph JSON file". But every oracle depends on more than the graph: it depends on the cohort data the CLI hydrates, the promoted-model params on each edge, the event stream used by `compute_forecast_trajectory`, the latency parameters, and anything else the read path consumes before producing the number that the baseline captures. If any of that is shared, the baseline can drift. A properly owned fixture is the whole closure of inputs — graph, events, parameters, snapshot data, whatever — pinned together such that no outside agent can mutate them without the owning suite knowing.

## Blast radius

Every suite that has a frozen reference output is at risk. This includes at minimum: doc 56 runtime-migration baselines, doc 50 truth-parity deltas, the cohort-maturity v2-v3 parity harness, the conditioned-forecast parity test, the cohort-maturity model-parity harness, daily-conversions baselines, and any as-yet-unknown regression harnesses that read shared synth graphs. New oracle-based devtools cannot be trusted to add signal until this is fixed, because any failure they flag has two equally likely causes — a real code regression, or silent upstream fixture mutation — and telling them apart costs an hour of diagnosis every time.

## What success looks like

Stable devtooling means this: a baseline captured today, verified green today, and unchanged on disk, continues to verify green tomorrow regardless of what any other automation did in the interim. A failed baseline run always means "the code under test changed behaviour" — never "someone else regenerated my inputs". The only way that property holds is if each owning suite's inputs are isolated from every other suite's writers, either by naming, by directory, by copy, or by some combination. The shape of that isolation is a design question for a follow-on doc; this one is only about naming the failure mode so we can stop paying the cost of it.

## Survey findings (20-Apr-26)

A thorough survey of the codebase confirms the leading hypothesis — multiple test harnesses do redundantly regenerate the same canonical fixtures and silently invalidate one another's oracles — but with a sharper diagnosis than was first assumed. The picture is more nuanced and several adjacent root causes also surfaced.

### Writers and their contexts

There are five distinct writers that target the shared `synth-*` and `cf-fix-*` filenames in the data repo's `graphs/` directory. Four of them are parity scripts under `graph-ops/scripts/` — the conditioned-forecast parity test, the v2-v3 parity test, the multihop-evidence parity test, and the window-cohort-convergence test. Each unconditionally re-runs `synth_gen` against the same canonical filenames as part of its own setup. The fifth is the bayes test harness, which auto-bootstraps a regeneration whenever it deems a fixture "stale" by its own narrow criteria. None of the five coordinates with the others; none announces an intent to write; none checks whether any other suite's oracle currently depends on the existing file content.

The contexts those five writers pass are mostly identical — all of them ultimately resolve their parameters from the canonical truth file for the named graph, so the regenerated content *should* be byte-equivalent to the previous content. The drift comes not from divergent contexts but from the fact that `synth_gen` is itself non-deterministic in subtle ways (UUID assignment, internal ordering) and from the `--enrich` flag asymmetry described below. In practice the canonical context is a near-pure function of the truth file, but "near-pure" is not "pure", and the resulting churn is sufficient to invalidate every downstream oracle.

The one writer that genuinely uses different contexts is `stress_bg_degradation.py`, which dynamically synthesises truth files with sweep-varied traffic, n_days, and sparsity values. It writes to its own `stress-bg-*` namespace, however, so it does not currently collide with the shared canonical fixtures. It is a latent risk, not an active cause.

### Verdict on the hypothesis

Confirmed in shape, refined in detail. The hypothesis as originally stated — different test files commission `synth_gen` with different contexts and overwrite each other's expected inputs — is approximately correct in effect but inaccurate in mechanism. The real mechanism is: many writers redundantly regenerate the same canonical fixture using nominally identical contexts; the regeneration is non-deterministic enough at the byte level to invalidate frozen oracles; nothing prevents or warns about the redundant write; and no reader has any way to detect that its inputs have shifted under it.

### The `--enrich` flag asymmetry

A specific aggravating factor: the v2-v3 parity test calls `synth_gen` *without* `--enrich`, while the conditioned-forecast, multihop-evidence, and window-cohort-convergence tests all call it *with* `--enrich`. Whichever runs last leaves the fixture in a different state than the others expect. A reader that captured its baseline against an enriched fixture will silently fail when an unenriched regeneration runs in between, and vice versa. This is not a context disagreement in the parameters that go into the simulation — it is a disagreement about what the persisted fixture artefact actually represents.

### The staleness check is too coarse to catch what matters

`synth_gen`'s own freshness check examines whether the sidecar metadata exists, whether the `enriched` flag is set as expected, and whether row counts match the truth file. It does not compare node UUIDs, edge identity, or event identity against any prior known-good state. The doc 56 incident slipped through this gate cleanly: row counts were correct after regeneration, the enriched flag was as expected, but the internal UUIDs and event identities had churned, breaking every baseline that depended on them.

### The drift signal already exists but is unused

Every regenerated fixture carries a `.synth-meta.json` sidecar that records SHA256 hashes for the truth file and the graph file, along with row counts and per-edge hashes. This is, in principle, exactly the signal a reader would need to detect drift between baseline capture and verification. In practice no reader ever consults it. The information is collected and discarded. The drift-detection infrastructure is half-built and dormant.

### The data-repo git SHA is provably inert

Several baselines record the data repo's git SHA at capture time as a freshness gate. The survey confirms this is useless: `synth_gen` rewrites fixture files in place without committing, so the SHA does not advance when the content changes. A baseline that records the SHA and re-checks it on verification will always conclude "no drift" no matter how many times the fixture has been rewritten in the meantime. This is not a fixable check; it is a check that cannot work given how the data repo is used.

### The shared-mutable surface is narrower than feared

A useful negative finding: graph JSON is the *only* shared mutable surface. Cohort data is generated on the fly during each CLI run and not persisted to a shared location. The params directory in the data repo holds only real-world parameter packs, not synth-fixture parameters. Events are either inline in truth files or in named sidecar YAMLs that `synth_gen` does not rewrite. The blast radius of the design problem is therefore one file type in one directory, not a sprawling cross-cutting concern. This narrows the design space considerably.

### Reader blast radius

The oracles currently at risk from any of the five writers above are: the doc 56 RNG-parity baselines, the cohort-forecast truth-parity script, the doc 56 baseline-capture harness covering six fixtures, the v2-v3 parity pytest, and any future oracle-based devtool that consumes a shared fixture. The doc 56 RNG-parity failure on 20-Apr-26 was the first observed instance; the same failure mode is latent across every other reader on the list.

## Exhaustive current consumer inventory (20-Apr-26)

This inventory is based on code, not docstrings alone. It includes current tests, test helpers, parity scripts, harnesses, and Bayes tooling that either load synth graphs directly, discover them via `discover_synth_graphs`, or materialise them via `synth_gen`. Pure documentation references and tests that only use in-memory synthetic dicts are intentionally excluded from the migration surface.

### Shared named fixtures currently relied on

| Fixture / selection mechanism | Current consumers | Enriched requirement | Current mutation path |
|---|---|---|---|
| `synth-simple-abc` | `graph-editor/lib/tests/test_be_topo_pass_parity.py`, `test_temporal_regime_separation.py`, `test_conditioned_forecast_response_contract.py`, `test_v2_v3_parity.py`, `test_doc56_phase0_behaviours.py`, `test_doc31_parity.py` (preferred candidate), `test_forecast_state_cohort.py`, `bayes/tests/test_data_binding_adversarial.py`, `graph-ops/scripts/conditioned-forecast-parity-test.sh`, `asat-blind-test.sh`, `cf-topology-suite.sh`, `cf-truth-parity.sh`, `capture-doc56-baselines.sh` | Mixed, but many callers need enriched state | `graph-editor/lib/tests/conftest.py`, `bayes/test_harness.py`, `bayes/run_regression.py`, parity scripts with generate flags |
| `synth-mirror-4step` | `graph-editor/lib/tests/test_v2_v3_parity.py`, `test_doc56_phase0_behaviours.py`, `test_funnel_contract.py`, `graph-ops/scripts/v2-v3-parity-test.sh`, `multihop-evidence-parity-test.sh`, `window-cohort-convergence-test.sh`, `chart-graph-agreement-test.sh`, `conversion-rate-blind-test.sh`, `cohort-maturity-model-parity-test.sh`, `cf-topology-suite.sh`, `cf-truth-parity.sh`, `capture-doc56-baselines.sh` | Mixed, with several parity paths expecting enriched state | Same shared writer set as above, plus `--generate` asymmetry between enriched and unenriched scripts |
| `synth-diamond-test` | `graph-editor/src/services/__tests__/synthHashParity.test.ts`, special-case branches in `graph-ops/scripts/v2-v3-parity-test.sh` | Usually unenriched | Manual or script-driven `synth_gen`; no standard fixture resolver today |
| `synth-diamond-context` | `bayes/tests/test_data_binding_adversarial.py`, `bayes/tests/test_worker_phase2_dump.py` | Usually unenriched | Manual `synth_gen` or indirect harness bootstrap |
| `synth-context-solo-mixed` | `graph-ops/scripts/asat-blind-test.sh` | Unenriched | Manual pre-generation |
| `cf-fix-linear-no-lag`, `cf-fix-branching`, `cf-fix-diamond-mixed`, `cf-fix-deep-mixed` | `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`, `graph-ops/scripts/cf-truth-parity.sh`, `capture-doc56-baselines.sh`, `cf-topology-suite.sh` | Unenriched for current usage | Manual or script-driven `synth_gen` materialisation |
| `discover_synth_graphs(data_repo)` full truth inventory | `bayes/run_regression.py`, `bayes/regression_plans.py`, `bayes/tests/test_param_recovery.py` | Varies by downstream consumer | `run_regression.py` bootstraps stale/missing entries via `synth_gen --write-files` |

### Test helpers and direct test consumers

| File | Current role | Fixture selection | Enriched? | Auto-bootstrap today? | Notes for migration |
|---|---|---|---|---|---|
| `graph-editor/lib/tests/conftest.py` | `@requires_synth` decorator and bootstrap helper | Explicit graph name passed by test | Optional | Yes, via `verify_synth_data` then `python -m bayes.synth_gen --write-files [--enrich]` | Must become a thin wrapper over fixture resolution; this is the current Python mutation hot path |
| `graph-editor/lib/tests/test_be_topo_pass_parity.py` | Oracle parity | Hard-coded `synth-simple-abc` | Yes | Yes, via decorator | Good candidate for first migrated pytest caller |
| `graph-editor/lib/tests/test_temporal_regime_separation.py` | Oracle parity | Hard-coded `synth-simple-abc` | Yes | Yes | Same migration path as above |
| `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py` | Oracle parity | Hard-coded `synth-simple-abc` | Yes | Yes | Same migration path as above |
| `graph-editor/lib/tests/test_v2_v3_parity.py` | Oracle parity | `synth-simple-abc` via decorator; later reads `synth-mirror-4step` directly | Yes in practice | Partial | Important mismatch: one test file touches more than one synth fixture under one decorator |
| `graph-editor/lib/tests/test_doc31_parity.py` | Discovery-based oracle parity | `_discover_graph_with_data()` prefers `synth-*` graphs with data | Usually yes | No | Must stop discovering mutable shared graphs ad hoc and pin explicit digests |
| `graph-editor/lib/tests/test_doc56_phase0_behaviours.py` | Doc 56 oracle checks | Direct loads of `synth-simple-abc`, `synth-mirror-4step`, and `cf-fix-*` | Mixed | No | Reads fixed names from the data repo and drives CLI analysis; high-priority migration target |
| `graph-editor/lib/tests/test_funnel_contract.py` | Direct fixture consumer | `synth-mirror-4step.json` | No | No | Pure file read today; should resolve a materialised root |
| `graph-editor/lib/tests/test_forecast_state_cohort.py` | Direct enriched fixture consumer | `synth-simple-abc.json` | Yes | No | Currently expects enriched graph state without any fixture resolver |
| `graph-editor/src/services/__tests__/synthHashParity.test.ts` | TS parity test | `synth-diamond-test.json` | No | No | TS side needs the same fixture tool contract as Python |
| `bayes/tests/test_param_recovery.py` | Discovery-based regression test | `discover_synth_graphs(data_repo)` | No explicit enrichment | Indirect, via `run_regression.py` | Represents the "full truth inventory" consumer rather than a named single fixture |
| `bayes/tests/test_synth_freshness.py` | Freshness/integration tests | Temp fixtures plus real `synth-simple-abc` integration checks | Mixed | No | Must be adapted to the new validator/store contract |
| `bayes/tests/test_data_binding_adversarial.py` | Real pipeline consumer | Direct loads of `synth-simple-abc` and `synth-diamond-context` | No | No | Read-side integration coverage for FE CLI and binder |
| `bayes/tests/test_worker_phase2_dump.py` | Real graph consumer | Direct load of `synth-diamond-context` | No | No | Another direct reader of the shared graph root |

### Bayes tooling stack and oracle scripts

| File | Current role | Selection mechanism | Read-only or mutating today | Shared state touched |
|---|---|---|---|---|
| `bayes/synth_gen.py` | Canonical materialiser today | `--graph` or discovery via truth files | Mutating | Graph files, parameter/event/context files, DB rows, `.synth-meta.json` |
| `bayes/test_harness.py` | Harness preflight and optional bootstrap | `graph_name.startswith("synth-")` | Mutating when stale/missing | Shared graph files, DB rows, `.synth-meta.json` |
| `bayes/run_regression.py` | Discovery + bootstrap for regression | `discover_synth_graphs(data_repo)` | Mutating when stale/missing | Shared graph files, DB rows, `.synth-meta.json` |
| `bayes/regression_plans.py` | Discovery-based plan selection | `discover_synth_graphs(data_repo)` | Read-heavy; delegates to mutating runner | Discovery surface over full synth truth inventory |
| `bayes/param_recovery.py` | Single-graph recovery entrypoint | `--graph synth-*` | Indirectly mutating through harness/rebuild paths | Harness logs and, via harness, shared fixture state |
| `bayes/stress_bg_degradation.py` | Stress-only synth materialiser | Dynamic `stress-bg-*` naming | Mutating | Own truth files, graph artefacts, DB rows, meta sidecars |
| `graph-ops/scripts/conditioned-forecast-parity-test.sh` | Oracle verification script | Default `synth-simple-abc` | Mutating when `--generate` used | Shared graph files, DB rows, meta sidecars |
| `graph-ops/scripts/v2-v3-parity-test.sh` | Oracle verification script | Default `synth-mirror-4step` | Mutating when `--generate` used | Shared graph files, DB rows, meta sidecars |
| `graph-ops/scripts/multihop-evidence-parity-test.sh` | Oracle verification script | Default `synth-mirror-4step` | Mutating; self-ensures enriched synth | Shared graph files, DB rows, meta sidecars |
| `graph-ops/scripts/window-cohort-convergence-test.sh` | Oracle verification script | Default `synth-mirror-4step` plus other synth fixtures | Mutating; self-ensures enriched synth | Shared graph files, DB rows, meta sidecars |
| `graph-ops/scripts/chart-graph-agreement-test.sh` | Oracle verification script | Default `synth-mirror-4step` | Read-only if prerequisites already satisfied | Reads shared graph root and snapshot DB |
| `graph-ops/scripts/cohort-maturity-model-parity-test.sh` | Oracle verification script | `synth-mirror-4step` | Read-only if prerequisites already satisfied | Reads shared graph root and snapshot DB |
| `graph-ops/scripts/conversion-rate-blind-test.sh` | Oracle verification script | `synth-mirror-4step` | Read-only if prerequisites already satisfied | Reads shared graph root and snapshot DB |
| `graph-ops/scripts/asat-blind-test.sh` | Oracle verification script | `synth-simple-abc`, `synth-context-solo-mixed` | Read-only if prerequisites already satisfied | Reads shared graph root and snapshot DB |
| `graph-ops/scripts/capture-doc56-baselines.sh` | Oracle baseline capture | Hard-coded synth/cf-fix fixture matrix | Mutating | Writes committed baseline artefacts under `bayes/baselines/doc56/` |
| `graph-ops/scripts/cf-truth-parity.sh` | Oracle verification | Hard-coded synth/cf-fix fixture matrix | Read-only | Reads shared graph root and snapshot DB |
| `graph-ops/scripts/cf-topology-suite.sh` | Wrapper over parity matrix | Hard-coded synth/cf-fix matrix | Delegating | Inherits child-script behaviour |
| `graph-ops/scripts/hydrate.sh` | Enrichment wrapper | Graph name argument | Mutating | Rewrites graph JSON with hydrated/enriched state |
| `scripts/run-param-recovery.sh` | Batch helper | Discovers `synth-*.truth.yaml` | Indirectly mutating via recovery/harness stack | Logs and downstream shared fixture state |
| `scripts/hunt-phase2-pathology.sh` | Repeated harness runner | Default `synth-skip-context` | Indirectly mutating via harness stack | Harness logs and downstream shared fixture state |

### Mutation hotspots that must be eliminated first

The immediate shared-state writers that currently sit on verification or preflight paths are:

- `graph-editor/lib/tests/conftest.py`
- `bayes/test_harness.py`
- `bayes/run_regression.py`
- `graph-ops/scripts/conditioned-forecast-parity-test.sh`
- `graph-ops/scripts/v2-v3-parity-test.sh`
- `graph-ops/scripts/multihop-evidence-parity-test.sh`
- `graph-ops/scripts/window-cohort-convergence-test.sh`

These are the first callers that must be re-pointed at the fixture tool, because they are the places where "prepare to verify" currently means "rewrite the shared canonical fixture".

## Design proposal

The principle the user stated — *each test fixture must own its own whole truth* — still points at an ownership inversion, but the efficient form of that inversion is not "every suite gets a private copy of every fixture". That would indeed create a wasteful explosion of nearly-identical data. The correct move is: suites own references to immutable fixture materialisations, not private byte-for-byte copies.

Today the system has only one concept of identity: a mutable shared graph name such as `synth-mirror-4step`. That name is doing too much work. It is standing in for the template, the generated graph root, the DB rows, and the enrichment state. The proposal is to split those apart.

### Three-layer model

There are three distinct layers:

1. **Template layer**. `bayes/truth/` remains the shared, mutable authoring surface. It is where developers define topologies and variants. Templates are not oracle inputs.
2. **Materialisation layer**. A shared store holds immutable fixture materialisations keyed by digest. Each materialisation contains the whole input closure that the read path consumes: the repo-shaped graph root, the sidecar metadata, and the DB namespace containing the matching snapshot rows.
3. **Suite manifest layer**. Each oracle suite pins the digest it expects. The suite owns that reference. Changing the pinned digest is the re-bless operation.

This avoids the feared blow-up in data volume. If two suites need the same materialisation, they point at the same digest and share the same bytes and DB rows safely. New storage appears only when the actual fixture inputs differ. `enrich=true` versus `enrich=false` is one such difference, so it yields two materialisations rather than N private copies.

### Ownership means owning the reference, not the bytes

Under this model, "each suite owns its whole truth" means: each suite owns the right to say which immutable materialisation is its truth. It does **not** mean that each suite must duplicate all underlying files. The thing that must be private is the suite's pin, not the underlying artefacts.

Two suites may safely share a fixture if and only if they share the exact same immutable digest. The unsafe case is not sharing per se; it is sharing a mutable alias.

### Materialiser contract

`synth_gen` and any sibling writer must stop treating the shared data repo as the implied destination. A writer must either:

- accept an explicit target root and explicit DB namespace from the caller, or
- accept a higher-level "materialise this digest" request and resolve the destination from the store.

A writer invoked without an explicit target should refuse to bless anything, or write only to an unmistakable scratch location. The current default — silently rewriting the canonical shared file under the data repo — is the proximate enabler of the whole problem.

The materialiser should be idempotent in the strong sense: if the requested digest already exists and validates, it returns the existing root and namespace without rewriting them.

### Minimal store shape

Each materialisation entry needs to record enough information to make its identity explicit and auditable. At minimum the store metadata should capture:

- the fixture digest itself;
- the source truth digest and truth name;
- the declared variant fields, including enrichment state and any generator-affecting options that change the emitted artefacts;
- the digests of any context or supporting files whose bytes affect FE interpretation;
- the materialised root location;
- the DB namespace derived for that materialisation;
- the resulting file digests and row-count metadata needed for validation.

The digest recipe must be based on the full set of inputs that determine the materialised bytes and rows, not just the truth YAML. If FE canonicalisation rules, context-definition bytes, or enrichment state can change oracle behaviour, they are part of fixture identity.

### Minimal suite manifest shape

Each oracle suite then needs only a small manifest that records:

- the logical fixture role within the suite;
- the required materialisation digest;
- the expected variant label, where a human-readable name is useful;
- the baseline artefacts captured against that digest;
- any audit metadata needed for re-bless history.

### Defence in depth via the existing content hashes

The `.synth-meta.json` sidecar already contains much of the raw information needed for drift detection. Under the store model it becomes part of the materialisation metadata rather than an advisory note attached to a mutable shared file. A baseline no longer says "I expect the shared graph named X to still look roughly like it did before". It says "I expect digest Y". Verification first resolves the pinned digest, re-checks the materialised bytes and namespace against that digest, and only then runs the oracle.

A mismatch becomes a hard, distinct failure saying that the fixture drifted or the materialisation is incomplete, not that the code under test regressed. Ownership is the structural fix; digest verification is the alarm that fires when the structure is violated.

### Retire regenerate-the-shared-canonical-root

The four parity scripts that currently call `synth_gen` as part of their own setup must stop rewriting the shared canonical filenames. A verification run should ask for the exact pinned digest and either:

- resolve the already-existing materialisation from the store, or
- materialise that digest into the store if it is genuinely missing.

What it must not do is silently overwrite the asset whose behaviour it is claiming to verify. Re-materialising the exact same digest is fine. Mutating a blessed digest in place is not.

This also resolves the `--enrich` asymmetry cleanly. `enrich=true` and `enrich=false` are not temporary moods of one graph. They are distinct fixture variants with distinct digests. Suites that need one variant share that variant; suites that need the other share the other one.

### Drop the inert git-SHA freshness gate

Baselines that record the data repo's git SHA as a freshness signal should stop doing so. The signal is provably useless against the failure mode it was meant to catch. The fixture digest and its validated materialisation metadata are the correct replacements.

### The stress harness needs no changes

`stress_bg_degradation.py` already writes to its own namespace and currently has no readers consuming its outputs as oracle inputs. It can continue unchanged for exploratory work. If a future suite wants to baseline one of its outputs, that output should be promoted into the same immutable-store model and pinned by digest from day one.

### Implementation plan

The implementation will be delivered as one canonical fixture tool and one canonical fixture store. Every oracle caller will resolve fixtures through that tool. No verification path will call `synth_gen` directly and no verification path will write to the shared canonical graph names in the data repo.

#### Phase 1 — establish fixture identity and storage

Create a new fixture package under `bayes/fixtures/` and make it the single source of truth for fixture identity, materialisation, validation, and suite-manifest loading. Add a committed manifest tree at `bayes/fixtures/manifests/`. Each manifest identifies a suite, the fixture roles it depends on, the pinned digest for each role, and the baseline artefacts that were captured against those digests.

Add a local, git-ignored materialisation store at `debug/fixture-store/`. Each materialisation lives under its digest and contains three things: a repo-shaped `root/` that the FE CLI can load directly; a validation metadata file that records the full input closure and the validated output closure; and a readiness marker that distinguishes complete materialisations from interrupted builds. The store is shared across suites on one machine, but the entries are immutable once marked ready.

Make the fixture digest versioned and deterministic. It will be computed from the truth bytes, the declared variant fields, the enrichment state, the relevant generated-supporting-definition bytes that affect FE interpretation, and an explicit materialiser-version string. Volatile timestamps and other non-semantic bookkeeping fields must be stripped or canonicalised before validation so that semantically identical fixtures do not churn just because a run happened later in the day. This is a load-bearing requirement; without it, the store cannot be reliable.

Derive the snapshot DB namespace directly from the fixture digest rather than from repo and branch identity. The namespace is part of the materialisation contract. Equal digests mean equal namespace, equal rows, and safe reuse. Different digests mean distinct namespaces, even when the underlying truth files share most of their structure.

Materialisation must be concurrency-safe and crash-safe. Each digest gets a lock. Builds happen in a temporary location. Validation runs before the entry is marked ready. Incomplete or failed builds are never treated as reusable fixtures. This makes the green path reliable and the failure path diagnosable.

#### Phase 2 — make writers target an explicit root and namespace

Teach `bayes/synth_gen.py` to write to an explicit target root and explicit DB namespace supplied by the fixture tool. The current behaviour of implicitly resolving the shared data repo remains acceptable only as a temporary manual mode; oracle tooling must stop using it entirely. `synth_gen` becomes a low-level engine, not the caller-facing orchestration surface.

Move enrichment onto the same contract. The current `hydrate.sh` path hardcodes the data repo and is therefore not acceptable as the programmatic fixture interface. Add an explicit-root enrichment entrypoint and route both the fixture tool and any retained shell wrappers through it. The fixture tool must be able to materialise both unenriched and enriched variants into the store without touching the shared canonical filenames.

Refactor freshness validation around materialised fixtures rather than shared graph names. `verify_synth_data` should evolve into a validator that accepts a concrete root and a concrete namespace and answers a binary question: is this materialisation complete and trustworthy for its pinned digest? It should stop trying to infer correctness from the state of a mutable shared graph in the data repo.

#### Phase 3 — add one read path for callers and remove shared-root mutation from verification

Add one caller-facing command for ensuring fixtures and one caller-facing command for re-blessing suites. The ensure command resolves a suite manifest, validates the pinned digests, materialises anything missing into the local store, and returns concrete root and namespace locations for the caller. The re-bless command is the only workflow allowed to replace a pinned digest or recapture baselines.

Update `graph-editor/lib/tests/conftest.py`, `bayes/test_harness.py`, and every oracle shell script in `graph-ops/scripts/` to use the fixture tool rather than calling `synth_gen` directly. `requires_synth` becomes a thin adapter over fixture resolution. The harness freshness gate stops repairing shared canonical graphs and instead resolves the declared fixture variant it needs. The parity scripts stop accepting "regenerate the shared graph" as part of normal verification. Verification becomes read-only with respect to blessed fixtures and baseline metadata.

The concrete first-wave callers for this phase are the current mutation hotspots: `graph-editor/lib/tests/conftest.py`, `bayes/test_harness.py`, `bayes/run_regression.py`, `graph-ops/scripts/conditioned-forecast-parity-test.sh`, `graph-ops/scripts/v2-v3-parity-test.sh`, `graph-ops/scripts/multihop-evidence-parity-test.sh`, and `graph-ops/scripts/window-cohort-convergence-test.sh`. Until these are migrated, the old failure mode remains live.

The concrete second-wave callers are the direct-read oracle and parity consumers that currently assume the shared data repo is already in the right state: `graph-editor/lib/tests/test_doc31_parity.py`, `test_doc56_phase0_behaviours.py`, `test_funnel_contract.py`, `test_forecast_state_cohort.py`, `graph-editor/src/services/__tests__/synthHashParity.test.ts`, `graph-ops/scripts/chart-graph-agreement-test.sh`, `cohort-maturity-model-parity-test.sh`, `conversion-rate-blind-test.sh`, `asat-blind-test.sh`, `cf-truth-parity.sh`, and `capture-doc56-baselines.sh`.

Exploratory tools and regression plans may continue to materialise fixtures on demand, but they must do so through the same store and namespace logic. This gives them the same reliability properties without requiring them to maintain suite manifests unless they also own frozen baselines.

#### Phase 4 — migrate existing suites without accidental re-blessing

Migrate the current oracle suites in a fixed order: doc 56 baselines first, then doc 50 truth-parity, then the v2-v3 parity harnesses, then conditioned-forecast, multihop-evidence, window-cohort-convergence, and daily-conversions. Each migration creates a committed suite manifest, imports or materialises the suite's currently blessed fixture state into the store, records the resulting digest, and rewires the suite to resolve that digest rather than a shared graph name.

In file terms, the doc 56 tranche covers `graph-ops/scripts/capture-doc56-baselines.sh`, `graph-ops/scripts/cf-truth-parity.sh`, and `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`. The parity tranche covers `graph-ops/scripts/v2-v3-parity-test.sh`, `graph-editor/lib/tests/test_v2_v3_parity.py`, `graph-editor/lib/tests/test_be_topo_pass_parity.py`, `graph-editor/lib/tests/test_temporal_regime_separation.py`, and `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`. The blind/analysis tranche covers `graph-ops/scripts/chart-graph-agreement-test.sh`, `cohort-maturity-model-parity-test.sh`, `conversion-rate-blind-test.sh`, `asat-blind-test.sh`, and `graph-editor/lib/tests/test_doc31_parity.py`. The regression tranche covers `bayes/run_regression.py`, `bayes/regression_plans.py`, `bayes/param_recovery.py`, and `bayes/tests/test_param_recovery.py`.

Migration follows one of two explicit paths. If a suite is currently green on trusted inputs, freeze that current fixture state into the store and pin it without regenerating from truth. If a suite is already suspect or red because its shared fixture has drifted, do a deliberate full re-bless from truth and capture the new digest openly. There is no third path. What must never happen is an implicit "just regenerate today's truth and hope it is equivalent" migration.

Once a suite is migrated, remove any flag or code path that rewrites the shared canonical graph during routine verification. In particular, current `--generate` style behaviour in parity scripts is retired. The only mutation path after migration is an explicit re-bless command.

#### Phase 5 — harden the devtooling and lock in the invariant

Add focused tests for the fixture tool itself. The critical cases are digest stability, canonicalisation of volatile fields, explicit-root materialisation, enriched-versus-unenriched variant separation, concurrent requests for the same digest, interrupted build recovery, and validation failures when a materialised root or namespace is corrupted. These tests belong with the fixture tooling, not spread indirectly across downstream suites.

Add operator-visible progress output to every long-running path. The materialiser, enricher, and validator must report what digest they are working on, what stage they are in, and whether they are reusing an existing ready entry or building a new one. The output must make it obvious whether a verification run stayed read-only, reused cache, or performed a local materialisation.

Finally, make the invariant enforceable in code review and CI: no oracle verifier may invoke `synth_gen` against the shared data repo, no verifier may modify a suite manifest, and every baseline metadata file must record the fixture digest it was captured against. At that point the old failure mode is structurally closed rather than socially discouraged.

## First-principles refinement (20-Apr-26)

The survey above correctly identified shared mutable state, but a closer code read sharpens the actual load-bearing unit. The thing an oracle depends on is not a single graph JSON file. It is a materialised graph root, a snapshot namespace, and a declared variant. In the current codebase the read path can already load from arbitrary graph roots, but the write, enrich, and freshness paths still resolve the shared data repo by default. That distinction matters because it tells us both what must change and what can stay.

### The real input closure

A synth oracle reads a repo-shaped directory tree: `graphs/`, `nodes/`, `events/`, `contexts/`, `parameters/`, plus any optional supporting files that the FE loader consults. It also reads snapshot DB rows keyed by the materialised graph identity. `--enrich` then mutates that same tree again by writing `model_vars`, promoted latency values, and posterior blocks back onto disk. Any design that isolates only `graphs/*.json` while leaving the rest shared will recreate the same failure mode under a different name.

This is the most important refinement to the earlier proposal. The fixture is not "the graph". The fixture is the whole closure of files and rows that the read path consumes.

### `enrich=true` is not a flag, it is a different fixture variant

Base and enriched graphs are not the same fixture in two temporary moods. They are two different materialised states with different persisted artefacts and different read-time behaviour. One is a pre-topo-pass materialisation. The other is a post-topo-pass materialisation. The same logic applies to context-definition changes: if a context YAML changes, the FE sees a different fixture even if the graph filename is unchanged.

That means the system must stop treating enrichment as an in-place toggle on a canonical shared graph. The toggle is itself a variant boundary.

### Sharing is safe only when the thing shared is immutable

The user principle — "each fixture must own its whole truth" — is directionally right, but the deeper rule is stricter: the system must never let a mutable shared name stand in for fixture identity. Two suites may safely share a fixture only when they are both pointing at the exact same immutable materialisation. If one suite needs a different variant, it needs a different materialisation identity, not a write to the old one.

Put differently: the bug is not merely "sharing". The bug is "sharing a mutable alias".

### Reader code must stop healing shared state

A verification run should never rewrite the asset it is claiming to verify. Auto-bootstrap on read is acceptable only when it resolves the exact pinned digest from the immutable store, or materialises a missing digest into a store or scratch location without changing any already-blessed digest. Auto-bootstrap that rewrites the shared canonical root destroys oracle meaning, because the act of verification changes the subject being verified.

This changes how to think about helpers like `requires_synth` and the harness freshness gate. Their job is not "make the canonical graph look right". Their job is "resolve or materialise the exact fixture variant this reader declared".

### Consequence for the architecture

The directory-only proposal above is a good start but is not sufficient on its own. Private directories solve path-level fights, but snapshot rows are still namespaced today by data-repo git identity rather than by fixture identity. A correct design therefore needs both an explicit fixture root and an explicit fixture namespace for DB writes and freshness checks.

Private copies without private namespace would still leave one class of shared mutable state in place.

### Recommended model

Keep `bayes/truth/` as shared templates only. Introduce a content-addressed store of immutable fixture materialisations, each produced from a template plus a variant spec. That variant spec includes at minimum the enrichment state, the exact context-definition bytes, any other generator-affecting options, and the snapshot namespace to write under. Baselines pin the digest of that full materialisation rather than the moving name of a canonical graph.

Suite-owned private copies remain a possible fallback or migration step, but they are not the preferred end-state because they pay the full storage cost even when the materialisations are identical. The preferred end-state is shared immutable materialisations with suite-owned pins.

### Practical implication

The encouraging part is that the FE CLI already reads from arbitrary graph roots, so read-side isolation is mostly a solved problem. The missing work is concentrated on the write side: `synth_gen`, `hydrate`, `verify_synth_data`, and the harness bootstrap paths need to accept an explicit target root and explicit namespace instead of silently resolving the shared data repo.

That is a much narrower implementation problem than the original incident suggested. We do not need to redesign graph loading. We need to stop hardcoding the writer's destination and namespace.

### Minimal safe rules

Truth files are templates, not fixtures. A fixture is the whole materialised root plus its DB namespace. `enrich=true` and `enrich=false` are distinct variants. Suites own pinned fixture digests, not private copies of bytes. Readers do not mutate blessed fixtures in place. Baselines record and verify fixture digests before asserting behaviour. Re-bless is the only operation allowed to replace a fixture reference.

### Definition of done

This work is done when the following statements are all true.

Every oracle suite resolves fixtures through a committed suite manifest and a pinned fixture digest. No oracle suite names `synth-*` or `cf-fix-*` as mutable shared inputs.

Every blessed fixture lives in the immutable local store, with a validated root and a digest-derived DB namespace. Enriched and unenriched variants are represented as distinct digests.

No verification script rewrites the shared data repo as a side effect of preparing to run. Verification may populate the local store for a pinned digest, but it may not modify shared canonical graphs, suite manifests, or baseline artefacts.

Every baseline metadata record stores the fixture digest it was captured against, and verification fails distinctly when the fixture digest or its validated materialisation no longer matches.

Running two suites in any order on the same machine cannot invalidate one another's baselines. If both need the same fixture digest they share it safely. If they need different variants they resolve different digests and different namespaces.

Re-blessing is a single explicit workflow that materialises the new digest, validates it, recaptures baselines, and updates the suite manifest atomically with an audit trail. There is no casual "generate on the side" path that can silently move a suite's truth.
