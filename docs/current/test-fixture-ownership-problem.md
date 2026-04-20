# Test fixture ownership — shared synth graphs silently invalidate everyone's oracles

**Status**: Problem statement + survey findings + design proposal (no implementation yet)
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

## Design proposal

The principle the user stated — *each test fixture must own its own whole truth* — points unambiguously at one structural change: invert the ownership relation between fixtures and suites. Today, fixtures are canonical objects in a shared namespace and suites are second-class consumers. The proposal is to make suites the owners and fixtures their private property.

### Inversion of ownership

Each oracle suite gets its own directory containing the entire input closure that determines its baseline: the graph JSON, the truth file used to generate it, any sidecar event YAMLs, the parameter pack reference, the snapshot parameters, and any other artefact the read path consumes before producing the number that the baseline captures. No other suite reads from this directory. No automation outside the owning suite writes to it. The fixture filenames inside an owned directory may collide with those in other owned directories — that is fine; they are no longer canonical, they are local.

The shared `synth-*` and `cf-fix-*` files in the data repo's `graphs/` directory are demoted from canonical test inputs to *templates*. They exist to seed a new suite's inputs when one is first created. After seeding, the suite owns its copy and the template's subsequent state is irrelevant to the suite.

### Generators must accept an output target

`synth_gen` and any sibling generator must take an explicit output location from the caller. The current behaviour of always writing to a hardcoded path under the data repo's `graphs/` directory is the proximate enabler of the entire problem. Once generators write where they are told and only where they are told, suite-owned regeneration becomes a routine operation and accidental cross-suite invalidation becomes impossible by construction.

A generator invoked without an explicit target should refuse to run, or should write to a clearly-marked scratch area that no oracle reads from. The current default — silently rewriting the canonical shared file — should be removed.

### Defence in depth via the existing content hashes

The `.synth-meta.json` sidecar already records the hashes that drift detection needs. The proposal is to make every baseline record, at capture time, the hashes of every input file in the suite's owned directory; and to make every verification run re-hash the current input files and compare them to the recorded values before running the oracle. A mismatch becomes a hard, distinct failure with a message that names the input that changed and explicitly says the failure is *not* a code regression. This eliminates the diagnostic ambiguity that costs an hour per incident today.

This check has value even after ownership is inverted. Ownership is the structural fix; hash verification is the alarm that goes off if some future automation (or operator error) violates the structural rule. The two layers protect different failure modes.

### Retire the redundant regenerate-before-test pattern

The four parity scripts that currently call `synth_gen` as part of their own setup must stop doing so. They consume the suite-owned fixture directly, exactly as captured. Regeneration becomes a deliberate, infrequent operator action — a re-blessing of the suite — performed by a single command that updates both the suite's inputs and its baselines atomically. There should be no everyday code path that touches both at once.

This change has a useful side effect: the `--enrich` asymmetry resolves itself. Each suite's truth file pins whether its fixture is enriched or not, and the persisted artefact reflects that pinning. No other writer is in a position to disagree.

### Drop the inert git-SHA freshness gate

Baselines that record the data repo's git SHA as a freshness signal should stop doing so. The signal is provably useless against the failure mode it was meant to catch. The per-input content hashes from the previous section are the correct replacement and they detect exactly what the SHA was supposed to detect.

### The stress harness needs no changes

`stress_bg_degradation.py` already writes to its own namespace and currently has no readers consuming its outputs as oracle inputs. It should continue to be allowed to use a generator with an explicit output target (per the rule above), but no structural change to its behaviour is required. If a future suite ever decides to baseline a stress-fixture output, it would adopt the ownership-inverted pattern from day one.

### Open design questions

A handful of decisions remain open and should be settled before implementation:

The first is *where owned fixture directories live*. The natural candidates are: alongside each suite's baseline directory under `bayes/baselines/<suite>/inputs/`; alongside each script under `graph-ops/scripts/<suite>/inputs/`; or in a new top-level fixtures tree organised by suite. The choice affects discoverability and the ergonomics of the re-bless workflow but not the correctness of the fix.

The second is *how to migrate existing baselines*. Some current baselines are tied to specific past fixture content whose generation is not reproducible byte-for-byte from the current `synth_gen`. A naive migration that simply copies today's fixture into each suite's directory would silently re-bless every baseline against current content, defeating the point. The migration plan needs to distinguish suites where today's content is the intended truth (re-bless openly) from suites where the previous content was load-bearing (capture from a known-good prior state, or accept that the baseline must be regenerated and re-validated from first principles).

The third is *the operator workflow for re-blessing*. When a suite owner deliberately changes their fixture — to expand coverage, add a new topology variant, or absorb an upstream behavioural change — the re-bless command must update inputs and baselines as a single atomic operation, fail loudly if either half does not succeed, and produce an audit record that names the operator and the reason. Re-blessing is the correct response to intentional change and the wrong response to mystery drift, so the workflow should make it slightly inconvenient by design.

The fourth is *whether the canonical templates stay alive at all*. If every suite owns a copy and the templates are only ever read at suite-creation time, the templates may not earn their keep. Retiring them removes one persistent source of confusion (the question "is this template the same as the suite's copy?") at the cost of a less obvious starting point for new suites. The decision can wait until the inversion is done; either answer is workable.

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

A verification run should never rewrite the asset it is claiming to verify. Auto-bootstrap on read is acceptable only when it materialises into a private scratch root or an owned fixture root. Auto-bootstrap that rewrites the shared canonical root destroys oracle meaning, because the act of verification changes the subject being verified.

This changes how to think about helpers like `requires_synth` and the harness freshness gate. Their job is not "make the canonical graph look right". Their job is "resolve or materialise the exact fixture variant this reader declared".

### Consequence for the architecture

The directory-only proposal above is a good start but is not sufficient on its own. Private directories solve path-level fights, but snapshot rows are still namespaced today by data-repo git identity rather than by fixture identity. A correct design therefore needs both an explicit fixture root and an explicit fixture namespace for DB writes and freshness checks.

Private copies without private namespace would still leave one class of shared mutable state in place.

### Recommended model

Keep `bayes/truth/` as shared templates only. Introduce a separate concept of a materialised fixture root, produced from a template plus a variant spec. That variant spec includes at minimum the enrichment state, the exact context-definition bytes, any other generator-affecting options, and the snapshot namespace to write under. Baselines then pin the digest of that full materialisation rather than the moving name of a canonical graph.

There are two workable physical implementations of this rule. The simpler one is suite-owned fixture roots. The stronger one is a content-addressed immutable store of fixture materialisations, with suites pointing at digests. Either satisfies the invariant. The important part is that fixture identity becomes explicit and immutable.

### Practical implication

The encouraging part is that the FE CLI already reads from arbitrary graph roots, so read-side isolation is mostly a solved problem. The missing work is concentrated on the write side: `synth_gen`, `hydrate`, `verify_synth_data`, and the harness bootstrap paths need to accept an explicit target root and explicit namespace instead of silently resolving the shared data repo.

That is a much narrower implementation problem than the original incident suggested. We do not need to redesign graph loading. We need to stop hardcoding the writer's destination and namespace.

### Minimal safe rules

Truth files are templates, not fixtures. A fixture is the whole materialised root plus its DB namespace. `enrich=true` and `enrich=false` are distinct variants. Readers do not mutate blessed fixtures in place. Baselines record and verify fixture digests before asserting behaviour. Re-bless is the only operation allowed to replace a fixture reference.

### Refined open questions

Where fixture roots live is now a secondary ergonomics decision. The primary open questions are how fixture namespaces are encoded, whether materialisations are suite-owned copies or entries in an immutable store, and how to migrate today's baselines without accidentally re-blessing them against whatever happens to be in the shared root at migration time.
