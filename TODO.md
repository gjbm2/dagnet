# TODO


- ## Snapshot DB — CRITICAL missing integration vs design (2-Feb-26)
-
- **Design intent (explicit):** `docs/current/project-db/completed/snapshot-db-design.md` §2  
- **Core principle:** **Frontend resolves everything** (DSL parse, slice plan, MECE verification, signature set) and **Python only queries DB + derives**.
-
- **What we discovered:** the core wiring is missing in production UI:
-   - `AnalyticsPanel.tsx` always calls `graphComputeClient.analyzeSelection()` / `analyzeMultipleScenarios()` (scenario-based graph analysis).
-   - It does **not** build or send `snapshot_query` (no `param_id`, no `slice_keys`, no `core_hash`, no `as_at`).
-   - `graphComputeClient.analyzeSnapshots()` exists (posts `/api/runner/analyze` with `snapshot_query`) but has **no call sites**.
-   - `AnalyticsPanel.tsx` currently tracks only **selected nodes**, not **selected edges**, so it cannot even identify the parameter edge to analyse from DB.
-   - Python `get_available_analyses` is DSL-driven (`runner/analysis_types.yaml`), and **does not advertise** snapshot analyses (`lag_histogram`, `daily_conversions`) as normal DSL analyses; yet the UI lists them as “snapshot-based analyses”.
-
- **Impact:** core architecture deviates from the snapshot DB design; snapshot analytics UI can’t be “real” because it never exercises the DB-backed path. Any confidence from UI usage is illusory.
-
- **Required implementation (minimal, design-conformant):**
-   - **Selection plumbing:** capture selected edge UUID(s) in `AnalyticsPanel.tsx` (from `dagnet:querySelection`) and resolve to the parameter objectId / edge.
-   - **Central service (NOT UI logic):** build `snapshot_query` coordinates:
-     - `param_id` = `${repo}-${branch}-${objectId}`
-     - `slice_keys` = MECE slice plan from context definition + parameter file slices (front end decides).
-     - `core_hash` (optional) = computed from the same query signature mechanism used on write.
-     - `anchor_from/anchor_to` and optional `as_at`.
-   - **Analytics dispatch:** when `analysis_type` is `lag_histogram` or `daily_conversions`, call `graphComputeClient.analyzeSnapshots()` instead of scenario analysis.
-   - **Availability gating:** snapshot analyses must be enabled/disabled based on *edge selection + snapshot inventory coverage*, not DSL matching from `runner/available-analyses`.
-   - **Multi-slice safety:** ensure Python derivations are MECE-safe when multiple `slice_keys` are queried together (deltas must be per-slice).
-
- **Acceptance criteria:**
-   - Selecting an edge with snapshot history and choosing `lag_histogram` / `daily_conversions` results in a request containing `snapshot_query` (not `scenarios`).
-   - Python returns derived results from DB for the provided `slice_keys` and date range.
-   - Works for MECE union (4 channel slices) and supports successive-day `as_at` compositing without double counting.
-
- ### Status of the real-Amplitude E2E we built (NOT yet run)
-
- **Test file:** `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts`
-
- **What it currently does (intended coverage):**
-   - **MECE-only snapshotting**: fetches only 4 channel context slices (no explicit uncontexted slice), for both:
-     - `window(1-Nov-25:20-Nov-25).context(channel:paid-search|influencer|paid-social|other)`
-     - `cohort(1-Nov-25:20-Nov-25).context(channel:paid-search|influencer|paid-social|other)`
-   - **Serial “daily cron” simulation**:
-     - Run 1: fixed `retrieved_at = 20-Nov-25` (via `Date` constructor override) + `bustCache: true`
-     - Run 2: fixed `retrieved_at = 21-Nov-25` + `bustCache: false` + forced small `path_t95 = 7` to try to ensure incremental tail refresh
-   - **DB assertions (write-path correctness):**
-     - Run 1 expects **160 rows** (\(20 days × 4 channels × 2 modes\)).
-     - Run 2 expects **0 < rows < 160** (incremental subset, not full replay).
-     - Confirms two distinct `retrieved_at` timestamps and records per-run row counts.
-   - **Python read-side compositing assertions (DB → derived analytics):**
-     - Calls `/api/runner/analyze` with `snapshot_query.as_at` for 20-Nov vs 21-Nov.
-     - Passes **all 4 cohort slice keys** (MECE union) and verifies:
-       - `rows_analysed` increases on the later as-at date, but
-       - `total_conversions` does **not** double-count across snapshots.
-   - **Persistence for manual inspection / future replay:**
-     - Writes `graph-editor/debug/snapshot-e2e-*.json` containing:
-       - fetch results, DB rows, Python derived results
-       - **raw Amplitude HTTP recordings** (auth redacted) keyed by a stable request hash for future “mock-only-HTTP” replay.
-
- **Defects fixed while building this test:**
-   - Python derivations were **not MECE-safe** when multiple `slice_keys` are queried together; deltas were mixing slices.
-     - Fixed by grouping deltas per `(anchor_day, slice_key)` in:
-       - `graph-editor/lib/runner/daily_conversions_derivation.py`
-       - `graph-editor/lib/runner/histogram_derivation.py`
-     - Added Python unit tests:
-       - `graph-editor/lib/tests/test_daily_conversions.py` (`*_multi_slice_mece_safe`)
-       - `graph-editor/lib/tests/test_histogram_derivation.py` (`*_multi_slice_mece_safe`)
-   - Python snapshot analysis now honours `snapshot_query.as_at` (needed for cron/as-at simulation).
-
- **What is still missing / unknown until we run it:**
-   - **Not executed yet**: needs a real run to validate planning + DB writes.
-   - **Environment requirements to run:**
-     - `DAGNET_RUN_REAL_AMPLITUDE_E2E=1`
-     - repo-root `.env.amplitude.local` with Amplitude creds
-     - Python dev server on `localhost:9000` with `DB_CONNECTION` set
-   - **Incremental behaviour is an assumption**: Run 2 will only be “subset” if planner + cache rules refetch a tail window as expected.
-   - **Test hygiene**: Amplitude HTTP recorder restores `global.fetch` at the end; if the test fails early, it may not restore (wrap in `try/finally` when stabilising).
-   - **Does not prove UI wiring**: even if this passes, the app UI still isn’t wired to call `snapshot_query` (see section above).
-
- Log mirrorring isn't working properly -- only some entries are captured and returned

- Auto-retry if fetch fail on automated chron

- Reason through possiblity of storing data in a dbs (leaving slice headers within param files) -- see docs/current/project-db/initial-thinking.md

- ## CRITICAL — Signature gating disabled for release safety (20-Jan-26)
+
### What happened / why this is here
- **Business-critical workflow broken**: After a Retrieve All (which writes contexted MECE slices) the WindowSelector planner was frequently reporting `Outcome: not_covered` and `needs_fetch missing=Xd` **even when cache coverage was FULL**.
  - Session logs repeatedly showed the contradiction:
    - `IMPLICIT_UNCONTEXTED: using MECE partition (key=channel, complete=true)`
    - `SLICES: ✓ 1-Nov-25 → 15-Dec-25 (FULL)` (for the MECE component slices)
    - but planner items still came out as `NEEDS_FETCH (COVERED)` with `missingDates=Xd`.
- The root cause class is **signature enforcement drift**:
  - We introduced/strengthened `query_signature` “signature isolation” so stale cache entries don’t satisfy a changed query.
  - In practice, the planner began **rejecting MECE cache generations** due to mismatched signature computation and/or differing context-definition resolution.
  - This is subtle because:
    - “Coverage” logging in `COVERAGE_DETAIL` is **not signature-aware** (it inspects raw file values), while the FetchPlan builder uses signature-filtered values for actual planning.
    - Different parameters can diverge (`1 covered, 9 need fetch`) if only some happen to match the planner’s computed signature set.

### Timeline / key corrective work attempted (high-signal)
- **Canonical target enumeration** (fixed): introduced `fetchTargetEnumerationService.ts` so all planners enumerate the same fetchable universe, including `conditional_p`, and canonical case IDs (`node.case.id`).
- **Planner connection detection** (fixed): corrected production connection checks to look at **param-slot** connections (`edge.p.connection`, etc.), preventing “unfetchable” misclassification.
- **Header-based FULL coverage alignment** (fixed): planner now treats FULL header coverage as zero missing days (avoids per-day sparsity false negatives).
- **MECE aggregation correctness** (fixed): MECE coverage for cohort/window now honours aggregate header bounds across MECE slices.
- **Signature isolation** (partially fixed, but still failing in prod):
  - Removed sentinel-based signature filtering that rejected everything when any signatures existed.
  - Added planner signature computation (`plannerQuerySignatureService.ts`) to match executor.
  - Made signatures **context-value independent** (context definition affects signature, not the selected value).
  - Added multi-candidate planner signatures for implicit-uncontexted fulfilment (MECE key candidates).
  - Added workspace-scoped context hashing to avoid cross-workspace context confusion in IndexedDB.
  - Despite this, production logs still show the “COVERED but needs_fetch” contradiction in real graphs (example logs around `cohort(10-Nov-25:13-Nov-25)` and `cohort(19-Nov-25:20-Nov-25)`).

### Current diagnosis (where we are right now)
- The system is in a state where **signature enforcement can incorrectly reject valid MECE cache** and thereby **block normal fetch flows** (users see fetch required; fetch behaviour becomes unpredictable).
- It is unclear whether the remaining production mismatch is due to:
  - legacy signatures written under older semantics (requiring a full Retrieve All to rewrite), and/or
  - remaining signature-shape drift (e.g. `edge.query` canonicalisation, composite query normalisation), and/or
  - subtle context definition resolution differences (workspace scoping, cache priming timing).

### Release decision (explicit)
- **We are disabling signature checking and signature writing for release** so that:
  - cached data is used based on slice isolation + MECE + header coverage only, and
  - fetching is never blocked by signature mismatch.
- This is implemented via `graph-editor/src/services/signaturePolicyService.ts`:
  - `SIGNATURE_CHECKING_ENABLED = false`
  - `SIGNATURE_WRITING_ENABLED = false`

### Follow-up work (to re-enable signatures safely)
- Re-enable signatures only after:
  - verifying a single canonical signature definition across planner + executor,
  - proving MECE implicit-uncontexted fulfilment selects the correct signed generation deterministically,
  - adding hard integration tests that reproduce the real production workflow using real graph/schema and minimal mocking,
  - ensuring signature mismatch **never prevents fetching** (at worst triggers refetch), and
  - adding session-log diagnostics that explicitly report signature matching counts per item (so “COVERED but filtered out” is visible).


- Dark mode on user devices looks ugly (as only some elements are re-colouring)

## Pull latest issues
- clients update their graph files after a fetch
- this looks like a conflict on next git pull
- we need to defend against this to prevent lots of conflicts on fetch...

## Outstanding issues (sequencing + live share parity) — updated 15-Jan-26

- **Normal vs live share: material analysis deltas (suspected sequencing defect)**
  - POSS: need a far more thorough e2e approach here with deep business data and do serious TDD to ensure conformance
  - **Symptom**: The *same* chart/scenario DSLs can yield materially different outputs between authoring (normal app) and live share.
    - Example: **Bridge chart** reach differs materially (e.g. ~2.1% vs ~2.7%) even when DSL windows and (apparently) param YAML match.
    - Secondary symptom: Bridge steps differ (e.g. `household-created` present vs absent) due to thresholding interacting with the reach delta.
  - **Belief (per session-log investigation)**: Differences are most plausibly driven by **ordering/sequencing** in the hydrate → stage‑2 (LAG/inbound‑n) → scenario regen → analysis pipeline, causing different slices to be selected/merged and different enhancements to be attached.
      - analysis method has been to compare session logs between "normal" and "live share" modes
  - **Primary invariants (must hold)**
    - Given **identical repo inputs** (graph + params + contexts + settings) and identical scenario DSLs, the analysis output must converge between:
      - authoring app (normal mode)
      - live share first-load boot
      - live share F5 reload (cache-hit)
      - live share explicit refetch/recompute
  - **Concrete repro (current workflow)**
    - In normal mode, run: `await window.dagnetDebug.refetchFromFiles('param read repro')`
      - Expected: refresh Current-from-files and recompute open chart artefacts (mirror live share).
    - In live share, compare:
      - first load (“boot”)
      - then F5 (“cache-hit” load)
      - then any dev refetch/recompute path (if used)
    - Capture session logs and compare for first divergence (look for DSL, contexts, stage‑2):
      - `tmp.log` (boot)
      - `tmp2.log` (F5)
  - **Known high-risk surfaces / likely root causes**
    - **Current DSL authority**
      - If `GraphStoreContext.currentDSL` is empty at the wrong moment, code can fall back to `graph.currentQueryDSL` (historic record), changing query semantics.
      - Also watch for mismatched “Current DSL” sources: chart payload vs graph store state vs graph file field.
      - **Assurance (rule-out drift cause)**:
        - Add a single “DSL authority snapshot” mark in both normal + live share runs, captured immediately before any Stage‑2 or analysis compute:
          - Assert equality of: payload current DSL (if share), GraphStore `currentDSL`, graph file `currentQueryDSL`, and the effective DSL passed into `fetchItems()` / analysis.
        - Add an outcome-oriented parity test that fails if the effective DSL differs between normal and live share when given the same intended DSL (treat as a hard defect, not a warning).

    - **Relative / open-ended DSL date resolution (clock/timezone)**
      - Relative/open-ended DSLs (e.g. `-60d:` or missing `.end`) resolve against “today”; if normal vs live share resolve differently (clock skew, TZ boundary), the effective query window differs.
      - **Assurance (rule-out drift cause)**:
        - During parity runs, log a single “resolved DSL window” snapshot (start/end, plus the derived “today” in `d-MMM-yy`) at the same mark point in both modes; assert exact equality.
        - In parity tests, prefer explicit windows (no relative/open-ended) unless the test is explicitly about relative-date semantics; if testing relative semantics, freeze the reference date (single injected “as-of day”) and assert both pathways use it.

    - **Context + settings hydration timing (MECE + slice-family selection)**
      - Even with identical param files, results can diverge if context definitions or repo settings are not hydrated into FileRegistry/IDB before slice selection and MECE implicit-uncontexted resolution.
      - **Assurance (rule-out drift cause)**:
        - Add a “deps ready” barrier assertion that must pass before scenario regeneration / Stage‑2 / analysis:
          - contexts file(s) present and parsed; settings file present; connection capabilities present.
        - Add a parity test that records and compares the “slice universe” used for the compute:
          - which sliceDSL entries were selected for each edge (including whether implicit MECE was used, and which key/value universe).

    - **Scenario regeneration ordering / stale scenario state**
      - Live share has explicit “hydrate Current → regenerate scenarios → compute analysis”; normal mode may rely on React/store sequencing.
      - **Assurance (rule-out drift cause)**:
        - Introduce a deterministic “sequencing contract” trace (single log op with ordered child steps) and assert the step order is identical across normal/live share for the same scenario set.
        - Add a parity test that asserts scenario graphs are byte-equivalent (or structurally equivalent) immediately before analysis compute (same scenario IDs, same DSL subtitles, same composed param packs).

    - **Fetch permissions / mode differences (from-file-only vs network-permitted)**
      - Live share commonly forbids source fetches; normal mode may fetch gaps/refresh stale slices, which mutates caches and changes results.
      - **Assurance (rule-out drift cause)**:
        - During parity runs, enforce the same policy in both modes (“cache-only”) and assert no network fetch occurred (planner outcome must be “covered” and execution must not call source boundaries).
        - Add a parity test that fails if either run performs any write to parameter files during the “compute-only” window (treat as drift contamination).

    - **Analysis graph construction inputs (visibility mode, scenario list/order)**
      - The analysis runner can vary based on scenario order/visibility state (e.g. F/E/F+E mode), and on whether What‑If is applied.
      - **Assurance (rule-out drift cause)**:
        - At analysis entry, log and compare: visibility mode, active scenario IDs + order, hide_current state, colours, and any What‑If DSL applied.
        - Add a parity test that builds the analysis graph in both modes and asserts equivalence of the serialised graph payload sent to the compute client (not just the final rendered chart).
    - **Contexts availability / slice selection**
      - Observed divergence patterns include `context(channel:other)` showing up in one run but not another.
      - Context presence must be stable across boot vs reload; context definitions affect MECE partitioning + “otherPolicy” behaviour.
      - Verify contexts are present BOTH in IndexedDB and in FileRegistry at compute time (some registry paths only consult FileRegistry).
    - **Stage‑2 determinism**
      - Stage‑2 enhancements (LAG topo pass + inbound‑n) must run identically regardless of environment and UI toast/batch presentation flags.
      - If stage‑2 runs a different number of times, `t95Days`/`maturityDays` and downstream `forecastMean`/`blendedMean` can diverge materially.
    - **Repo settings parity (forecast basis)**
      - Live share must source forecasting knobs from repo `settings/settings.yaml`, not defaults (already implemented, but confirm it is consistently applied on cache-hit reload as well).
  - **Where to look in code (entrypoints)**
    - Live share boot/cache: `graph-editor/src/contexts/TabContext.tsx` (`loadFromURLData` live-mode path)
    - Live chart orchestration: `graph-editor/src/hooks/useShareChartFromUrl.ts`
    - Live bundle orchestration: `graph-editor/src/hooks/useShareBundleFromUrl.ts`
    - Repo boot fetch: `graph-editor/src/services/liveShareBootService.ts`
    - Refresh fetch/seed: `graph-editor/src/services/liveShareSyncService.ts`
    - Dependency barrier: `graph-editor/src/services/liveShareHydrationService.ts` (`waitForLiveShareGraphDeps`)
    - Fetch/stage‑2: `graph-editor/src/services/fetchDataService.ts`
    - Context resolution: `graph-editor/src/services/contextRegistry.ts` (+ `graph-editor/src/lib/das/buildDslFromEdge.ts`)
    - Scenario regen + recompute: `graph-editor/src/contexts/ScenariosContext.tsx`
    - Graph store DSL bootstrap logic: `graph-editor/src/contexts/GraphStoreContext.tsx`
  - **Next concrete work items (handoff-ready)**
    - Build a “deep business data” **parity e2e** that computes the same named chart in:
      - authoring mode (seed repo-like files into workspace DB)
      - live share mode (boot from the same fixture repo boundary)
      - Assert **analysis_result equality** (not just “chart opened”).
    - Add a deterministic “sequencing contract” test:
      - Ensure ordering is: deps seeded → Current hydrated → stage‑2 → scenarios regenerated → analysis computed → chart persisted.
      - Fail loudly if step ordering changes (this is the suspected root of material deltas).
    - Identify and remove any remaining implicit fallbacks to `graph.currentQueryDSL` where `currentDSL` should be authoritative.
    - Confirm stage‑2 execution is not coupled to `suppressBatchToast` / UI batch mode.
  - **Known risk surface**:
    - **Current DSL authority**: If `currentDSL` is empty at the wrong moment, code can fall back to `graph.currentQueryDSL` (historic record), changing query semantics.
    - **Context leakage**: Unexpected `context(channel:other)` / MECE(channel) behaviour can appear when contexts are not correctly hydrated/available at evaluation time, or when cached state leaks across reloads.
    - **Stage‑2 coupling**: Ensure stage‑2 execution is not accidentally gated by UI batching/toast concerns (must be deterministic and identical across environments).
  - **Required outcome**: One deterministic “view of truth” — given identical repo inputs + DSLs, normal and live share must converge to identical analysis results.

- **Live share: multi-tab/bundle mode still defective (tests pass, app doesn’t behave)**
  - **Symptom**: Multi-tab share/bundle URLs can fail to open/restore the correct set of tabs (graph + charts), or end up blank/partial despite automated tests passing.
  - **Likely causes**: ordering/race issues in bundle bootstrap (GraphStore/Scenarios readiness vs tab materialisation), and gaps in test coverage (tests assert internal hooks/events but do not reflect real multi-tab user behaviour).
  - **Required outcome**: Multi-tab live share works reliably under real browser conditions; tests must reproduce the actual failure modes (not just unit expectations).
  - **Concrete repro / debugging checklist**
    - Use a bundle link that should open graph + chart(s) in dashboard mode and check:
      - tabs materialise reliably on first load
      - F5 reload preserves/open tabs correctly
      - scenario colours/IDs/visibility are stable
    - When it fails, capture:
      - browser console mirroring stream + marks (`debug/tmp.browser-console.jsonl`)
      - session log mirroring stream + marks (`debug/tmp.session-log.jsonl`)
      - and the share-scoped DB name in console (`DagNetGraphEditorShare:*`)
  - **Where to look in code**
    - UI bootstrap: `graph-editor/src/components/share/ShareBundleBootstrapper.tsx`
    - Hook orchestration: `graph-editor/src/hooks/useShareBundleFromUrl.ts`
    - Live-mode file seeding: `graph-editor/src/contexts/TabContext.tsx` (live path)
    - Chart share boot: `graph-editor/src/components/share/ShareChartBootstrapper.tsx` + `graph-editor/src/hooks/useShareChartFromUrl.ts`
  - **Next concrete work items (handoff-ready)**
    - Make a single “multi-tab truth” E2E that asserts the real user-visible outcomes:
      - correct number of tabs
      - correct active tab
      - chart(s) render and are not blank
      - scenario view state is correct (hide_current, colours, order)
    - Identify any remaining bootstrap races where the chart/bundle runner can fire before:
      - graph is seeded into share DB
      - dependent files are hydrated into FileRegistry
      - ScenariosContext is ready with correct graph


## Consider a live db server for data blobs (data for each slice) so we can store daily histograms, pass pointers to data etc. into analytics, charting, etc.  and reduce file size
- i.e. re-architect app data handling so we retain slices headers etc. in git, but move actual data blobs into a dbs.


- **Performance (not critical path; likely debug-heavy)**: In live share, route all GitHub API calls through a **same-origin proxy** (e.g. `/api/github-proxy/...`) so the browser never calls `api.github.com` directly. This should eliminate most CORS preflight (OPTIONS) overhead and materially speed up boot/refresh, but will require careful debugging across dev/prod and test stubs.

- Investigate Forecast calcs (now that we think evidence is semi-stable; not at all sure forecast is behaving itself when blending...)
- Forecast mode appears misleading/broken in two ways:
  - Forecasts often come from persisted `edge.p.forecast.mean`, so recency half-life / related knobs may not take effect unless forecasts are recomputed.
  - Outgoing sibling forecast values can sum > 1; residual edges then get 0 in F mode (R=max(0,1-S)), making residual pathways appear to have no flow.
- Think about a DB server for data blobs inside slices -- would make it possible to store e.g. daily snapshots without killing git (for histograms, etc.); also more portable/less client-side datawang...
- Share linkes should carry Sankey status
- idiotic choice of mini icons for graphs (look like charts!!! also why not lucide??)
- check that live share includes dependent image files in repo scope
 
- Work on case files:
  docs/current/case-lag-updates.md

## Immediate triage

- this shouldn't be a warning:
  {
    "fileId": "nous-conversion-main-graph-conversion-flow-account-success-v2",
    "severity": "warning",
    "category": "sync",
    "message": "Graph ↔ parameter drift for p.switch-registered-to-switch-success.p (paramId=registration-to-success) at \"latency.path_t95\" (graph=37.61 vs file=30.16). Direct fetch uses graph; versioned fetch uses parameter file.",
    "field": "edges[3].p.latency.path_t95",
    "edgeUuid": "370dce1d-3a36-4109-9711-204c301478c8"
  }

## Investigation pointer (updated 9-Jan-26)

See `investigate/investigation-delegation-vs-registration-1-Nov-25.md`.

- More testing of conditional_p logic under what-if scenarios
- Let's make Current scenario visible at all times

## Test suite hygiene (micro-test shrapnel) — 7-Jan-26
  - **Context**: `npm test` currently has **247** Vitest files; **~100** are “micro candidates” (≤2 tests or ≤120 lines). Audit reports: `debug/tmp.vitest-test-audit.tsv`, `debug/tmp.vitest-test-audit.v2.tsv`.
  -
  - **Goal**: Reduce test-file proliferation and “one-off shrapnel” while **preserving** regression coverage and keeping the suite navigable.
  -
  - **Non-goals**:
  - - No weakening/loosening of assertions.
  - - No broad refactors of test utilities unless needed for consolidation.
  -
  - **Policy (balanced)**:
  - - Keep **micro regression tests** when they are the best expression of a sharp invariant (especially subtle DSL edge-cases).
  - - Consolidate when a file is (a) a single assertion that clearly belongs to an existing suite, or (b) part of a cluster where the *topic* is fragmented across many tiny files.
  - - Quarantine “research / debug / repro / local-only” so they do not pollute the main suite surface area.
  -
  - **Proposed actions (staged)**:
  - - **Stage A — Quarantine obvious shrapnel (low risk)**:
  -   - Standardise *local-only* naming and location: keep these under a single pattern (e.g. `*.local.*`) and/or folder.
  -   - Candidates already flagged by name/content:
  -     - `graph-editor/src/services/__tests__/amplitudeSingleEvent.segmentation.local.research.test.ts`
  -     - `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts`
  - - **Stage B — Merge “repro/debug/research/tmp/temp/csvDriven” into the nearest owning suite OR move out of `npm test`**:
  -   - Examples:
  -     - `graph-editor/src/services/__tests__/crud_repro.test.ts`
  -     - `graph-editor/src/services/__tests__/reachProbabilitySweep.*`
  -     - `graph-editor/src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts`
  - - **Stage C — De-fragment the biggest micro clusters (medium risk, high payoff)**:
  -   - Consolidate into one “home” suite per module (keep the existing file as the home where it already exists):
  -     - `analysisEChartsService.*.test.ts` → merge into a single `analysisEChartsService.test.ts`
  -     - `graphIssuesService.*.test.ts` → merge into `graphIssuesService.test.ts`
  -     - `integrityCheckService.*.test.ts` → merge into `integrityCheckService.test.ts` (keep the larger drift tests as-is if they’re already good homes)
  -     - `EdgeBeads.*.test.tsx` → merge into `EdgeBeads.test.tsx`
  - - **Stage D — Stop-gap guardrail**:
  -   - When adding a new test, default to “add to existing suite”; only create a new test file when there is no sensible existing home.
  -
  - **Process**:
  - - For each stage, prepare a small PR-sized patch set: consolidate + delete redundant files + keep test names/describe blocks clear.
  - - Only apply edits to existing tests with explicit approval (per `.cursorrules`); batch the diffs for review first.

- For result cards in analytics: add a 'expand / contract' toggle to right of each card which shows all stats vs. key stats [and we may need to feed that through from analysis to flag which are key are which are ancillary)
- context fixes: /home/reg/dev/dagnet/docs/current/project-lag/context-fix.md
- Refactor: /home/reg/dev/dagnet/docs/current/src-slimdown.md

- use Amplitude latency histograms to translate lognormals: /home/reg/dev/dagnet/docs/current/project-lag/histogram-fitting.md
- grouping / ungrouping nodes (zoom in to complexity)
- show current (dates range) in dashboard mode
- are we overfitting to lognormal when most latency edges NEVER start immediately? COULD we use histogram data to shift the start point & fit a better distro? What improvements on lognormal might we consider in general, if that's causing us lots of issues (and we acutally have: histo data, t95 clamps, median && mean, which should be enough for a much better analytic shape...)
- latency variance?
- PgDn / up / home / end /arrows should work in md viewer, etc.
- Store vars to arbitary precision; display to only 2/4dp
- Check fetch logic properly -- some odd behaviour
- (LAG optimisation follow-up) Before retrieving each slice, if cached data already exists for that exact slice DSL, derive a best-guess `t95`/`path_t95` (no network fetch) and use it to bound the subsequent “optimised” cohort/window cut for that slice.
- on F5, we're trying to fetch before files have loaded and failing. Need a guard to hold back fetch until after files are available

- we really have to re-factor the 3x god files (dataOperationsService, UpdateManager and GraphCanvas) -- cf. src-slimdown.md
- Confidence band rendering in LAG view needs checking & improving (design and polish; semantics now centralised but visuals may lag)

# Project-lag

### Edge cases to consider
- upstream visited() calls to Amplitude need to query on the right cohort window for the edges we actually care about NOT the upstream start window

### Semantic linting / data depth health

- Add a **semantic linting** pass to Graph Issues that checks **data depth/health** for latency edges:
  - Flag edges where `p.forecast` is based on too few mature cohorts (low effective sample size)
  - Flag edges where `completeness` is persistently low for the active DSL (window/cohort)
  - Surface a **data health indicator** in the Graph Issues panel (e.g., "data shallow", "no mature cohorts yet")
  - Treat this like other graph viewer issues: informational by default, with toggles to enable/disable
## LAG semantics (deferred requirement)

- (16-Dec-25) `ParameterSection.tsx` currently contains inline “commit ⇒ set *_overridden=true” logic for latency fields (`t95`, `path_t95`, `anchor_node_id`, `latency_parameter`). `AutomatableField` doesn’t own override semantics (it only renders/clears), so this should be centralised behind a hook/service to keep UI as access-point only.

- Add an explicit toggle for **“HAS completed”** (as-of now; allow conversions after `window.end` / `cohort.end`) vs **“completed by window end”** semantics.
  - This is deferred because it complicates Phase 1 semantics/regression repair, and it may not be trivial to derive “events occurred within the window” from the current Amplitude return shapes without additional query structure.

- (15-Dec-25) Completeness is currently **model-derived** from the lag CDF and cohort ages; it does not directly consult realised conversions (`p.evidence.k/n`). This can be counter-intuitive in edge cases (e.g. `evidence.k > 0` while completeness is ~0). Consider adding an evidence-informed completeness floor/blend (design needed; defer until after Phase 1).


## Major components
- Bayesian modelling
- Cyclic graphs...
- Port to server version (for simplicity)

---

- Edge bead tooltips: add hover tooltips explaining each bead (latency: median lag + completeness; probability; costs)

- Ensure integrity checker sensibly configured to support dual slice integrity checks

- Structural ambiguity about analysis dsl over conditional_p journeys -- can we cover absent scenarios?

## E2E Test Coverage for Repository Operations (CRITICAL)
Basic repo ops (switch repo, clear, pull) lack E2E tests and keep breaking. See `docs/current/project-contexts/e2e-test-plan.md`


## Graph issues panel

- Ideally we'd have deep linking from viewer > graph objects, but that has proven a _WORLD_ of pain because of the complexity of trying to reach into renderflow via rc dock and all KINDS of complexity. So for now...we don't have it.

- Add to Graph Issues checker some semantic issues as well as syntactic ones (with suitable toggles in the viewer):
   - pmfs not summing to 1
   - p by variant weights not summing to 1
   - condition_p pmgs not summing to 1
   - terminal node type not assigned properly
   - strange number of start nodes or start nodes and weight 
   - conditional p groups have different conditions
   - orphaned nodes not connected to graph
   - missing query string
   - etc. etc. etc. -- make a long, creative list and add checks
   - informational: overridens applied


## Orphaned Scenarios Problem (DESIGN NEEDED)

**Problem:** Scenarios can become orphaned and persist in IndexedDB with no way to clear them except `File > Clear`:
- Tab closed but scenarios remain (stored by `fileId`, not `tabId`)
- Graph deleted but scenarios not cascade-deleted
- URL scenarios created then user navigates away
- Multiple tabs for same graph cause visibility confusion

**Proposed Solutions:**
1. **Cascade delete:** Delete scenarios when graph file is deleted (`deleteOperationsService.deleteGraphFile`)
2. **User control:** Add "Clear All Scenarios" button to ScenariosPanel footer
3. **Garbage collection:** On startup, scan for scenarios whose `fileId` doesn't exist and delete them

**Priority:** High - Causes confusing UX and data buildup
**Related:** `ScenariosContext.tsx`, `deleteOperationsService.ts`, `ScenariosPanel.tsx`

---

## URL Parameter Management (DESIGN NEEDED)

**Problem:** URL parameter handling is fragmented and inconsistent:
- `TabContext` cleans `?graph=` after loading, but `useURLScenarios` needs it for matching
- No clear ownership of which component cleans which params
- Params are cleaned immediately, making URLs non-shareable
- Second visit to same URL with `?scenarios=` adds duplicate scenarios instead of deduping

**Issues:**
1. `?graph=` is cleaned before `useURLScenarios` can use it for tab matching
2. Revisiting a URL like `?graph=sample-graph&scenarios=window(-10d:)` should either:
   - Clear existing scenarios and create fresh ones (daily dashboard use case)
   - OR dedupe: skip creating scenarios that already exist with same DSL string
3. No general strategy for URL state management

**Proposed Solution:**
1. Centralise URL param handling in a single service/hook
2. Don't clean params immediately - keep URLs shareable
3. For scenarios: dedupe by DSL string (don't create if one with same `queryDSL` exists)
4. Consider: should `?scenarios=` replace all scenarios or add to existing?

**Priority:** Medium - Affects daily dashboard use case
**Related:** `useURLScenarios.ts`, `TabContext.tsx` loadFromURLData

---

## Vite dynamic import chunk failures (DEPLOY CACHE ISSUE)

- (17-Dec-25) Intermittent prod error: **“Failed to fetch dynamically imported module”** for the Vite chunk behind `../lib/das/compositeQueryExecutor` (triggered by composite queries / inclusion–exclusion). Likely stale cached entrypoint / SW after deploy → chunk hash 404s. Add a small resilience layer: retry once; if still failing, show a “new version deployed — hard refresh” prompt (and/or trigger reload), so data fetch doesn’t fail with an opaque error.

## Keyboard jamming issue

Now when the bug happens:
Try to type - if something is calling preventDefault, you'll see:
   🚨 KEYBOARD BUG DETECTED! Something blocked input. Stack: [stack trace showing WHO blocked it]
Run window.debugKeyboard() - this creates a raw HTML test input at the top of the screen:
If you CAN type in the test input but NOT in app inputs → React rendering issue
If you CANNOT type in test input either → something blocking at document level
The stack trace will show exactly which file/function called preventDefault.

When the keyboard stops working:
Open browser DevTools Console
Try pressing any key - you should see [KEYBOARD DIAGNOSTIC] logs showing where events are going
Run window.debugKeyboard() in console - this will show:
What element currently has focus
Any potential blocking overlays
Z-index elements
The diagnostic logs will show:
targetTag / activeElementTag - what element is receiving/holding keyboard focus
defaultPrevented - if something is blocking the event
isInput - whether an input should be receiving the keystroke
This will help identify whether:
Events are reaching the document (if no logs → something outside React is blocking)
Events are going to wrong element (if logs show unexpected activeElementTag)
Something is calling preventDefault (if defaultPrevented: true)
Reproduce the issue and share the console outpu

## What-If Compositing Centralization (REFACTOR)

**Problem:** What-If DSL compositing logic is duplicated across multiple files:
- `GraphCanvas.tsx` - 7+ direct calls to `computeEffectiveEdgeProbability`
- `buildScenarioRenderEdges.ts` - inline case variant logic
- `AnalyticsPanel.tsx` - builds graphs with What-If
- `CompositionService.ts` - `applyWhatIfToGraph` (partial implementation)

**Solution:** All What-If compositing should be centralized in `CompositionService`:
1. Create `getEffectiveEdgeProbability(layerId, edgeId, graph, params, whatIfDSL)` that:
   - For 'current': calls `computeEffectiveEdgeProbability` with whatIfDSL
   - For scenarios: uses composed params + case variant weights
   - Replaces the 3-way pattern that appears 4+ times in the codebase

2. Consolidate case variant weight application
3. Single source of truth for layer probability resolution

**Docs:** See `docs/current/refactor/GRAPH_CANVAS_ARCHITECTURE.md` for full analysis

- Tooltip Redesign (Future)

#

## Background Fetch Queue (DESIGN SKETCH)

**Problem:** Batch fetch operations (Get All for Slice, All Slices) block the UI for minutes due to rate limiting (3s between Amplitude API calls). With 20 items, that's 1+ minute of blocked modal.

**Solution:** Background fetch queue with non-blocking progress.

### Architecture Sketch

```
FetchQueueService (singleton)
├── queue: FetchJob[]           // Pending jobs
├── currentJob: FetchJob | null // Currently executing
├── state: 'idle' | 'running' | 'paused'
└── Events: progress, complete, error, cancelled

FetchJob = {
  id: string
  items: FetchItem[]           // What to fetch
  options: { bustCache, slice, ... }
  progress: { done: number, total: number, errors: number }
  onProgress?: (job) => void
  onComplete?: (job) => void
}
```

### UI Changes

1. **Modals submit & close immediately**
   - "Get All for Slice" → submits job → closes modal
   - Shows toast: "Fetching 20 items in background..."

2. **Progress indicator (non-blocking)**
   - Small floating widget in corner (like download manager)
   - Shows: "Fetching: 5/20 (2 errors) [Cancel]"
   - Expandable to see item-by-item progress
   - Can be minimised

3. **Toast notifications**
   - On complete: "✓ Fetched 18/20 items (2 failed)"
   - On rate limit: "⏳ Rate limited, waiting 30s..."
   - Clickable to expand progress widget

### Implementation Steps

1. Create `FetchQueueService` with job queue management
2. Integrate with existing `rateLimiter` service
3. Create `FetchProgressWidget` component (floating, draggable)
4. Update `BatchOperationsModal` to submit jobs, not execute inline
5. Update `AllSlicesModal` similarly
6. Add cancel/pause capability

### Alternative: Worker Thread

Could use Web Worker for true background execution:
- Pro: Completely non-blocking, survives tab changes
- Con: Complex (serialisation, IDB access from worker, etc.)
- Decision: Start with main-thread queue, upgrade to Worker if needed

**Priority:** Medium - Annoying UX but not blocking
**Effort:** ~8-12 hours

---

## Analytics Implementation (Phase 1 Complete ✅)

**Current Status:** See `docs/current/ANALYTICS_IMPLEMENTATION_STATUS.md` for full details

### Phase 1: Core Foundation ✅ COMPLETE
- ✅ AnalyticsPanel with Monaco DSL editor
- ✅ Multi-scenario analysis support
- ✅ 13 analysis types defined
- ✅ Card-based UI rendering
- ✅ Backend integration (graphComputeClient)
- ✅ Semantic result schema

### Phase 2: Tabular Datasets (CURRENT PRIORITY)
**Goal:** Add table views for 1-2 key analyses

#### Next Steps:
1. **[DOING]** Create `AnalyticsTable` component
   - Sortable columns
   - Multi-scenario delta columns (% change)
   - Conditional formatting (green/red)
   - Export to CSV
   
2. **[TODO]** Implement table view for Conversion Funnel
   - Stage-by-stage breakdown
   - Show all scenarios side-by-side
   - Calculate and display deltas between scenarios
   
3. **[TODO]** Implement table view for Branch Comparison
   - Side-by-side branch metrics
   - Sortable by probability, cost, conversion
   - Toggle between scenarios

**Estimated Effort:** 12-16 hours total

### Phase 3: Charts & Visualizations (BACKLOG)
- [ ] Integrate Recharts library
- [ ] Bar charts for branch/outcome comparisons
- [ ] Line charts for time-series with window aggregation
- [ ] Probability heatmaps for complex branching

**Estimated Effort:** 20-24 hours


### Auto-scenarios (requires 'scenario from dsl query' feature)

- let's add a right click context menu to context chips in e.g. dsl query selector on graph in window component AND we can add same feature to contexts in side nav (they'll need to get current graph tab):
  "Create [x] scenarios by value"
  where x is the number of values for this context key
  then use existing 'snapshot all' codepath to create x new scenarios, one for each key=value


### Form Field Duplicate ID Warnings
**Issue:** Multiple form editors (parameters, events, etc.) open in different tabs generate identical DOM element IDs, causing browser warnings about duplicate IDs. This is a violation of HTML spec where IDs must be unique across the entire document.

**Affected Components:** 
- Parameter editor forms
- Event editor forms  
- Any other forms using `react-jsonschema-form`

**Root Cause:** `react-jsonschema-form` generates field IDs based solely on the schema field names (e.g., `root_id`, `root_name`, etc.) without any instance-specific prefix. When multiple forms with the same schema are rendered simultaneously (in different tabs), they produce duplicate IDs.

**Severity:** HIGH - While functionally working currently, this could cause:
- Screen reader/accessibility issues
- Form validation problems
- JavaScript errors when trying to target elements by ID
- Potential data corruption if form libraries cache by ID

**Proposed Solution:** Add unique tab-specific prefixes to all form field IDs. Options:
1. Fork/extend `react-jsonschema-form` to accept an ID prefix prop
2. Use schema transformations to add prefixes dynamically
3. Ensure only one form instance per schema is mounted at a time (hide instead of unmount inactive tabs)

**Priority:** Should be fixed before production release

---

## Major components
- Bayesian modelling (...is expected?)
- Asynch / api updates
- Cyclic graphs

- download CSV built from selected funnel (or generate Google spreadsheet?)
- node renaming, file renaming -- need to handle globally
- systematically review that DELETE graph changes  go through UpdateManager

### Analytics / Model Fitting (Future)
- speed of chevron animation scale on log lag

### Medium 
- Persist scenarios to graph?
- Hooks for every menu item; clear up menus in general, they're a mess....
- Session / tab state not reliably persisting on reload (annoying)
- let's add a 'Create [x] scenarios' on right click context menu on context chips in window component AND within context drop-down which: creates one scenario for each value in the key clicked  -- e.g. if I had browser-type, it would create one scenario [snapshot all mode] for each of the values in browser-type. As always, ensure the logic for this is NOT expressed in the menu file, but in a generalised location
- Orphaned rc windows at times
- Some of our files (UpdateManager, GraphEditor, etc.) are becoming very long; we need to re-factor them down to be more manageable
- **PMF Overflow/Underflow Policies** - Longer-term enhancement to rebalancing logic
  - Current: Edges with parameter references are excluded from auto-rebalancing (implemented)
  - Future: Add graph-level policy (overrideable at node level) to control PMF overflow/underflow behavior
  - Policy options: strict (error on imbalance), absorb (adjust free edges), ignore (allow imbalance)
  - Would provide fine-grained control over probability mass distribution
- need some 'check graph integrity' and 'check for orphansed image files', etc. admin features
- we need to be careful about overrides -- if user 'puts to file' I wonder whether we sohuld clear overrides so that file is now master as appropriate?
- confidence internals on Sankey view
- Events that can fire several times we may need to build Amplitude funnels further one step further upstream in order to ensure we know that it's this specific event we care about 
- Zap drop down menu:
  - 'Connection settings' on zap drop down menu isn't working
  - Sync status' on zap drop down should show last sync, source, etc. from files/graph
- Edit: copy & paste
- Graph integrity checker report
- Minus autocomplete not working in query/selector
- 'Clear overrides' at context & Data menu level  
- Let's add a rename on File menu, nav bar context menu which (a) renames the file (b) reviews registry and updates any ids in any graphs/files to match
- Polish "Get from Source" UX (success feedback, animations -- apply to graph elements as well as sidebar)
- docs to cover: MSMDC, connections
- **FormEditor UI Schemas (Class-Specific Layouts)**
  - Context: FormEditor auto-generates forms from JSON schemas, but layout isn't always optimal
  - Current: Have class-specific overrides for credentials
  - Need: UI schemas for other object classes (parameters, cases, graphs, connections)
  - UI schema specifies: field order, grouping, descriptions, widgets, conditional visibility
  - Example: Parameter FormEditor should group related fields, show better labels, use appropriate widgets
  - Pattern: `ui-schemas/parameter-ui-schema.json`, `ui-schemas/case-ui-schema.json`, etc.
  - Benefit: Better UX without changing underlying data schemas
- Edit > Undo broken; add Undo to right click context menus on graph (standardise context menu implmenetations)
- generalise props panel implementation
- Date windows in viewer
- Selected objects show query/selector string
- copy / paste param packs
- 'view param packs)
- GIT_BATCH_OPERATIONS_MD
- Turn 'Path analysis' into a proper rc floating dock at the bottom left, but movebale (and re-dockable)
- Allow snapshotted 'delta analysis' views within what if panel; show colour-coded overlayed edges
- **Per-Tab Data Overlays (WhatIf Extension)**
  - Context: Current design has window/context at GRAPH level (synced across all tabs)
  - This prevents viewing same graph with different contexts side-by-side
  - Future: Extend WhatIf overlay system to support per-tab data fetch contexts
  - Would allow: Tab 1 shows "Mobile users", Tab 2 shows "Desktop users" for same graph
  - Requires: Overlay state management separate from base graph
  - See: `PROJECT_CONNECT/CURRENT/EXTERNAL_DATA_SYSTEM_DESIGN.md` section 4.1
- **Drag & Drop from Navigator to Graph** - See [DRAG_DROP_PROPOSAL.md](./DRAG_DROP_PROPOSAL.md) for full spec
  - Drag nodes/cases/parameters from navigator and drop on canvas to create/connect
  - Estimated: 36-48 hours full implementation, 28-38 hours MVP
- Nodal levels in the editor (some nodes are 'tall') & Sankey L-R mode with dyanmic node sizes
- auto-re-route doesn't start automatically (needs kicking)
- Post-its (and sort object selection properly)
  - Let's add a new graph object type, 'post-it'
  - These should be rendered with a missing top right corner
  - They should be resizeable. 
  - They should render atop nodes, labels, etc.
  - Should be possible to edit text within them, ideally in-line
  - Create is right click > context > Add post-it
  OR
  - Object > Add post-in (under node)
  - both should have same code path for creation
  - Context menu on post-in should have 'delete' and colour picker (selection of 6x standard pastels)
  - Drag to move
  - We should extend graph schema to accommodate.
  - These are not data objects -- only displayed not used for calculation, of course

### Low Priority
- three different types of ">" indicator on menus (!!)
- Check we load right querydsl on graph load
- Missing terminal node type on node file
- Keyboard short cuts, generally
- Clean up dead / misleading menu items
- add '?' icons to components, which link to relevant help docs 
- Image Undo/Redo Broken 
- bead labels aren't updating when values change e.g. on data retrieval, revbalances, etc. 
- make 'overridden' icons brighter
- add icons to collapsed beads?
- playing with edges resets edge_id! 
- clicking beads -- make hotspot larger
- whatif layer: prob needs is own layer in the palette really for clarity...
- auto-reroute still stubborn
- let's change the paramster keycolour to pink and nodes from blue to...something else that isn't orange or bright blue...cyan? That will help oragne and blue for dirty/open.
- put outbound probs. left aligned in edge; arriving prob mix. right aligned in edge
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
- somewhere along the line we lose animations on edge width changes, which is sad
- Sankey mode and normal view use diff code paths for mass infernece; hence sankey requires start node to work -- weird glitch
- all tests in weird places in the codepath; centralise



Post Its:

Need some mild 'is selected' state visual treatment
let's have text inside the post-it in a script font 
but not the text inside the Text field on the Post It props panel (there is hould be normal sans serif)
Let's add font size for Post Its S M L XL; default to Medium which should be a bit smaller than what we currently have. We can expose that on Post It props
handle needs to be dragable
a light drop shadow prob. appropriate

