# Invariants Ledger

A flat list of things that must always be true in DagNet. These are the rules whose violation produces silent wrong answers, lost data, or hard-to-debug regressions. Most have been broken in production at least once and recorded as anti-patterns.

This is a reference list, not an introduction. For first-time readers, see [DOMAIN_PRIMER.md](DOMAIN_PRIMER.md).

For the underlying anti-patterns, see [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md).

---

## State and persistence

### I-1: Use `db.getDirtyFiles()` for git ops, never `fileRegistry.getDirtyFiles()`

IDB is the source of truth for dirty files. FileRegistry is an in-memory cache, empty on page reload. Commit flows must scan IDB and filter by workspace prefix. AP 4. See [INDEXEDDB_PERSISTENCE_LAYER.md](INDEXEDDB_PERSISTENCE_LAYER.md).

### I-2: Every IDB write must update both records

Files are stored twice in IDB: unprefixed (`graph-foo`) for FileRegistry lookup and prefixed (`repo-branch-graph-foo`) for workspace operations. Updating only one produces zombie files or stale reads. AP 12. See [INDEXEDDB_PERSISTENCE_LAYER.md](INDEXEDDB_PERSISTENCE_LAYER.md).

### I-3: Setting state requires a new object reference

React reconciliation depends on reference equality. `setGraph(graph)` after in-place mutation does nothing visible. Use `structuredClone(graph)` or a UpdateManager method that returns a new graph. AP 3.

### I-4: Clearing data requires touching all four layers

Parameter file (IDB), graph edge projected value, stashed slices (`_posteriorSlices`), React render tree. Clearing layer 1 doesn't cascade. Cleanup must be idempotent — work even when source data is already absent. AP 1, AP 5. See [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md).

### I-5: `isInitializing` absorbs normalisation; `completeInitialization` must fire

During init, all edits update both `data` and `originalData` without marking dirty. If `completeInitialization()` is never scheduled (or fails), the file appears clean forever. AP 10. See [FILE_REGISTRY_LIFECYCLE.md](FILE_REGISTRY_LIFECYCLE.md).

### I-6: FileRegistry lookups by raw `db.files.get(unprefixedId)` silently miss

Workspace-loaded files are keyed by prefixed ID. Use `fileRegistry.restoreFile(fileId, workspaceScope)` which handles both. AP 12.

---

## Mutation

### I-7: All graph mutations go through UpdateManager

UpdateManager is the only sanctioned mutation path. Direct `setGraph(modifiedGraph)` bypasses sibling rebalancing, override-flag checks, audit log, and conditional probability cascades. AP 41. See [GRAPH_MUTATION_UPDATE_MANAGER.md](GRAPH_MUTATION_UPDATE_MANAGER.md).

### I-8: `_overridden` flags are field locks, not semantic signals

`field_overridden: true` only prevents UpdateManager from overwriting that field. It does not encode "user prefers manual" or any other higher-level meaning. Read the field's value, not the flag.

### I-9: UUIDs are immutable for `edge.from` and `edge.to`

Renaming a node's human-readable ID updates many references; `edge.from`/`edge.to` are UUIDs and never change. Token replacement on query strings uses word-boundary regex to avoid partial matches.

### I-10: Edge ID resolution is uuid-first

`getEdgeId(edge)` returns `edge.uuid || edge.id` — uuid first. All call sites that interact with `computeInboundN`, `activeEdges`, or `getEffectiveP` must use the same key derivation. Mixing uuid-first with id-first produces silently wrong sibling populations. AP 35.

---

## Hashing and signatures

### I-11: One canonical hash codepath

`computeQuerySignature` → `serialiseSignature` → `computeShortCoreHash`. CLI and tests must call this real FE code, not hand-roll a parallel implementation. Duplicate implementations diverge and produce hash mismatches between write and read paths. AP 28.

### I-12: Signatures derive from stored slice topology, not graph config

Read paths that compute plausible hashes (e.g. snapshot inventory) must enumerate context key-sets from `parameterFile.data.values[].sliceDSL`, not from `graph.dataInterestsDSL`. The graph config may include all dimensions while individual fetches used only one. AP 11. See [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md).

### I-13: YAML loaders for hashing must use JSON_SCHEMA

`js-yaml` defaults convert ISO dates to `Date` objects, which `normalizeObjectKeys` treats as `{}`. Use `YAML.load(raw, { schema: YAML.JSON_SCHEMA })` in any path that hashes YAML content. AP 23.

### I-14: Hash level vs slice level filtering are distinct

Context **dimension** changes the `core_hash`. Context **value** lives in `slice_key`. Both must be filtered for context-specific views; either alone returns wrong rows. AP 27.

### I-15: Connection name is part of the hash canonical

`edge.p.connection || graph.defaultConnection || 'amplitude'` is the resolution chain. All FE call sites must follow it. Hardcoded fallbacks that don't read `graph.defaultConnection` produce hash divergence. AP 46.

---

## Sync and rendering

### I-16: ReactFlow is controlled mode; functions in `node.data` are unreliable

ReactFlow round-trips nodes through its internal store and may strip or reset functions in `data`. Pass interaction callbacks via module-level singletons (e.g. `syncGuards.ts`), not through ReactFlow node data. See [REACTFLOW_CONTROLLED_MODE.md](REACTFLOW_CONTROLLED_MODE.md).

### I-17: ReactFlow owns inline z-index — DOM order controls paint

Setting `zIndex` on node objects is overwritten on every render. To control paint order, control DOM order via the nodes array. Append canvas analyses last to render them on top. See [CANVAS_RENDERING_ARCHITECTURE.md](CANVAS_RENDERING_ARCHITECTURE.md).

### I-18: Bidirectional sync uses 500ms suppression + content-revision guard

Store→File sync sets `suppressFileToStoreUntilRef = Date.now() + 500`. File→Store sync also checks `writtenStoreContentsRef` (content → revision) for stale-echo rejection — the time guard alone is insufficient under rapid mutations. AP 9. See [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md).

### I-19: Layout transactions use cooldown windows, not just flags

Layout transactions set both `sankeyLayoutInProgressRef` (boolean) and `effectsCooldownUntilRef` (timestamp). The timestamp window is what survives when effects fire after the transaction completes. See [SYNC_ENGINE_GUARD_STATE_MACHINE.md](SYNC_ENGINE_GUARD_STATE_MACHINE.md).

### I-20: `type:'reset'` changes clobber concurrent batches

In ReactFlow's `applyNodeChanges`, if any change has `type: 'reset'`, it replaces the entire node array with the reset items. During active resize/drag, filter out `type: 'reset'` changes in `onNodesChange` to prevent SelectionConnectors-style updates from clobbering interaction state.

---

## Statistical / forecasting

### I-21: Route latency-edge logic on `latency_parameter`, not `sigma > 0`

`sigma` is a fitted output, not a feature flag. Promoted sigma can appear on non-latency edges (sibling-slice fallback) and can be zero on latency edges (fit failure). Use `edge.p.latency.latency_parameter === true`. AP 36, AP 50.

### I-22: Window and cohort are distinct distributions, not views of one rate

The Bayes compiler maintains separate posteriors. Don't reuse one as a prior for the other without explicit cross-mode logic. See [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

### I-23: Cohort-mode `anchor_median_lag_days` is A→X, NOT A→Y

This is the single most important semantic distinction in the snapshot field model. A→X latency feeds Fenton-Wilkinson composition; using A→Y double-counts the edge's own latency. See [SNAPSHOT_FIELD_SEMANTICS.md](SNAPSHOT_FIELD_SEMANTICS.md).

### I-24: `analytics_dsl` (subject) and `effective_query_dsl` (temporal) are distinct

Top-level `analytics_dsl` describes the subject (path) and is constant across scenarios. Per-scenario `effective_query_dsl` describes the temporal window and varies. Conflating them produces multi-scenario charts where every scenario gets the same time bounds. AP 19, AP 20.

### I-25: Don't add layer-1 (`model_vars`) values as priors with layer-2 (current-answer) evidence

Layer-1 `analytic` source is already query-scoped (Jeffreys posterior from `total_k, total_n`). Using it as a prior for a conjugate update with the same scoped evidence double-counts. Check `ResolvedModelParams.alpha_beta_query_scoped` — True for analytic, False for bayesian/manual. AP 47.

### I-26: When CF returns `conditioned: false`, the unconditioned prior is the answer

Indicates no observed evidence applied (no rows for the regime in the query window). Surface diagnostically; don't treat as failure.

### I-27: Use `cohort_alpha`/`cohort_beta` in cohort mode, not `alpha`/`beta`

Both encode the posterior on the same edge rate but from different evidence sets. The model resolver branches on `temporal_mode`. Test assertions and consumers must follow the same convention. AP 47.

### I-28: Heuristic dispersion uses closed-form Beta σ from `α_pred, β_pred`, not MC stds

`p_sd` and `p_sd_epistemic` are derived from the resolved α/β pair, not from `np.std(rate_draws)`. IS-conditioning on observed evidence collapses MC stds to epistemic posterior width regardless of how diffuse the predictive prior was. Closed form is the only way to expose predictive dispersion distinctly.

---

## Bayes / inference

### I-29: New compiler branches require synthetic builders

Any new branch in `bayes/compiler/` must add a corresponding synthetic builder in `bayes/tests/synthetic.py`. Without this, the regression suite tests only the old shape; the new branch is untested until it crashes in production. CLAUDE.md §4. See [TESTING_STANDARDS.md](TESTING_STANDARDS.md).

### I-30: Updating posterior types requires `_build_unified_slices` updates

Adding fields to `PosteriorSummary` or `LatencyPosteriorSummary` is not enough. Fields must also be added to `_build_unified_slices` in `worker.py` (both window and cohort dicts) and to `bayesPatchService.ts` projection. AP 14.

### I-31: JAX backend with Pytensor gradient is the production setting

`gradient_backend='pytensor'` is required — JAX's reverse-mode AD hits NaN on join-node erfc/softplus chains. Default since 13-Apr-26. See [BAYES_REGRESSION_TOOLING.md](BAYES_REGRESSION_TOOLING.md).

### I-32: Concurrency cap is 2 for parallel Bayes runs

JAX parallelises across CPU cores per graph. `--max-parallel 2` is the safe ceiling; higher causes scheduler thrash and OOM. Hard-capped in `run_regression.py`.

### I-33: Bayes posteriors flow through atomic webhook commits, not direct file writes

The Modal worker fires a webhook → `api/bayes-webhook.ts` writes a patch file → atomic git commit. Pending patches scan on boot for unapplied results. Don't bypass this with synchronous result handling.

---

## Devtools and infrastructure

### I-34: Devtool actions never silently delete diagnostic data

Log files, trace outputs, recovery results, and harness logs are primary evidence. No keybinding, "clear" function, monitor helper, or cleanup script may `rm` these files. Display operations work on display state only. AP 37, AP 38. See [DEVTOOL_ENGINEERING_PRINCIPLES.md](DEVTOOL_ENGINEERING_PRINCIPLES.md).

### I-35: Long-running Python scripts use `python3 -u` (unbuffered)

Python buffers stdout when piped to a file. Without `-u`, no output appears until the process exits — making long background runs appear frozen.

### I-36: Test fixtures must show their reasons for regen

`@requires_synth` and the Bayes sidecar fixture must print the precise reason any time they trigger a rebuild — truth hash drift, fingerprint mismatch, missing param file, etc. "Just regenerates sometimes" is unacceptable.

### I-37: Per-subject failures must not abort the scenario

In the snapshot-envelope analysis dispatcher, a per-subject derivation failure must append a failure entry to `per_subject_results` and continue. Raising aborts the entire scenario including completed sibling subjects. AP 48.

### I-38: Run BE/FE servers with auto-reload; don't blame staleness without checking

Both dev servers expose `/__dagnet/server-info` for boot timestamp + PID. Run `scripts/dev-server-check.sh <file>` before claiming code didn't reload. AP 6.

---

## Documentation and discipline

### I-39: Don't reveal private repo names in chat, docs, or code

Use `DATA_REPO_DIR` / `MONOREPO_DIR` config vars or generic descriptions. The pre-commit hook enforces this. See CLAUDE.md.

### I-40: UK English in user-facing prose, `d-MMM-yy` dates

`colour`, `behaviour`, `centre`, `organisation`, `realise`, `analyse`. Code identifiers may follow external API conventions. Date format `d-MMM-yy` (`1-Dec-25`).

### I-41: Briefing receipt before Edit/Write on scoped paths

Scoped paths (`bayes/**`, certain services) require a briefing receipt as a standalone message before edits. The receipt enumerates which warm-start docs were read, key invariants extracted, and call sites identified. See CLAUDE.md "Context-enforcement gate".

### I-42: Pre-flight checks on Bash commands gate destructive operations

Git writes, file/db deletion, package installs, memory-system writes, Bayes regression runs all require explicit per-message permission. "Yes earlier" does not carry over. See CLAUDE.md "Pre-flight Checks".

---

## Cross-references

Most invariants here trace back to:

- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) — historical incidents that produced these rules
- [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md) — state propagation
- [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md) — hashing
- [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) — statistical layer separation
- [TESTING_STANDARDS.md](TESTING_STANDARDS.md) — test discipline
- CLAUDE.md — agent discipline rules
