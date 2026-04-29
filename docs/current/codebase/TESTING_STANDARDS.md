# Testing Standards

## Philosophy: fewer tests, real boundaries, zero tolerance for mock-driven false confidence

A test exists to prove **the system works**, not to prove **the code runs**. "The code runs" means a function returns something when called. "The system works" means when a user performs an action, the correct outcome occurs end-to-end. The first can be proven with mocks. The second cannot.

**The strategic default is zero mocks.** Load real files, hit real servers, use real data. A test that requires the Python server running on localhost is not a problem — it is a prerequisite, just like a test that requires `fake-indexeddb`. Mark it and move on.

**Fewer, better tests.** Three integration tests that exercise real code paths across real boundaries are worth more than thirty unit tests with mocked everything. Do not write tests to increase count. Write tests to catch bugs that would otherwise reach the user.

**A mock that hides a bug is worse than no test at all.** It creates false confidence, wastes investigation time when the bug surfaces in production, and teaches the agent that passing tests mean working code. They do not.

## The Mock Budget

Every test gets a **mock budget of zero by default**. Each mock introduced must pass this gate:

1. **Name the assumption**: what behaviour does this mock encode? (e.g. "the inventory endpoint returns a matched family for this core_hash")
2. **Name the risk**: what bug could this assumption hide? (e.g. "if the real endpoint doesn't match because the core_hash format is wrong, the test still passes")
3. **Justify why the real thing is impractical**: not "it's easier to mock" — a concrete reason like "requires Amplitude API credentials and rate-limited external calls"

If you cannot complete all three steps, do not add the mock.

**What to mock** (the only legitimate cases):
- External third-party APIs (Amplitude, GitHub) where hitting the real service is impractical or rate-limited
- Browser APIs not available in Node (e.g. `window.location`, `navigator`) — use the narrowest possible shim

**What to NEVER mock**:
- The Python server on localhost — it's part of our system, start it as a test prerequisite
- `computeQuerySignature`, `computeShortCoreHash`, or any hash/signature function — these are where format mismatches hide
- `getBatchInventoryV2`, `querySnapshotRetrievals`, `getBatchRetrievals` or any snapshot service function — mock the `fetch` boundary if you must, never the service
- FileRegistry, IDB, GraphStore — `fake-indexeddb` exists, use it
- Any function in the code path you are testing — that is testing the mock, not the system

## Parity Tests (MANDATORY when replacing a code path)

When a new implementation replaces an existing working one (e.g. batched version of a per-item function), the agent MUST write a **parity test** before claiming done:

1. **Call both paths** with identical inputs
2. **Assert identical outputs** — field by field, not just `success: true`
3. **Use real data** — load actual graph/event/parameter files from the data repo
4. **Hit the real server** — if the code path makes HTTP calls, those calls must reach the real Python server
5. **Mock nothing** — if the parity test passes with mocks but fails in the real UI, the test is wrong

The parity test is the **only** gate for switching to the new path. If it fails, the new path is not ready. If it passes with mocks, it has not been tested.

## Test Design Gate (MANDATORY before writing test code)

Before writing any `describe()` or `it()` blocks, the agent must produce a brief **prose test design** covering:

- **What real bug would this test catch?** — name a specific failure mode, not "it should work"
- **What is real vs mocked and why?** — apply the mock budget (above). Default: everything real.
- **What would a false pass look like?** — describe a scenario where the test passes but the system is broken. If you can describe one, your test design has a gap.

## Blind Tests

Write tests from the **contract**, not from the implementation. Tests shaped by reading the code mirror its assumptions, including its bugs.

- **New functionality**: design tests from the spec/plan *before* reading the implementation.
- **Bug fixes**: write a failing test reproducing the reported behaviour *before* reading the fix.
- **Code path replacement**: write the parity test from the *function signature and return type*, not from the implementation body.

## Assertion Standards

**Assert on observable outcomes at real boundaries**, not on intermediate state or mock return values.

**Banned**:
- `expect(result).toBeDefined()`, `expect(result).toBeTruthy()`, `expect(fn).not.toThrow()` as primary assertions
- Asserting that a mock was called with specific arguments — this tests the mock wiring, not the system
- Asserting on values that the test itself configured (circular)

**Required**:
- Assert on **specific values** that would change if the behaviour broke
- For multi-subsystem operations, assert state in **each affected subsystem**
- For parity tests, assert **field-by-field equality** between old and new paths

## Test Names as Specification

- ❌ `it('should work')`, `it('handles the edge case')`, `it('returns correct result')`
- ❌ `it('calls the service')`, `it('updates state')`
- ✅ `it('should propagate dirty flag from IDB to FileRegistry when file content changes')`
- ✅ `it('batched path produces identical coverage to per-edge path on real graph data')`
- ✅ `it('should use computeShortCoreHash not parseSignature.coreHash for DB lookups')`

## Test Infrastructure Must Track Feature Domains (STRATEGIC — NOT OPTIONAL)

**This is the most important testing rule in the project and the most expensive one to violate.**

Individual test rules (mock budgets, parity tests, blind tests) govern how to write *a* test. This rule governs whether the **test infrastructure exists at all** for the domain you are working in.

**The failure pattern**: the agent builds an entire new competence domain (contexted evidence, Phase 2 modelling, per-slice hierarchical priors) across multiple sessions. Every code change is validated by running expensive end-to-end cycles (3-minute MCMC, 30-minute regression suites). No fast synthetic test infrastructure is built. Eventually a trivial bug (`NameError`, `UnboundLocalError`, wrong variable scope) crashes every single production run. The user discovers it after wasting 30 minutes of compute. The agent then offers to write "a test" — but the problem was never one missing test. The problem was an **entire untested domain**.

**The rule**: when you are building or extending a capability that introduces a new *category* of inputs, data shapes, or code paths, you must build the test infrastructure for that category alongside the production code. This means:

1. **Synthetic data builders** that produce the new data shape (e.g. sliced evidence with `has_slices=True`, MECE context groups, Phase 2 frozen priors). These go in the relevant test fixtures module (e.g. `bayes/tests/synthetic.py`).
2. **Pipeline smoke tests** that call through the full code path with synthetic data and assert it completes without crashing. These catch `NameError`, `KeyError`, wrong variable names — the bugs that actually happen when code is written but never executed.
3. **Recovery/correctness tests** that assert the output is numerically reasonable (posterior means near truth, convergence diagnostics within bounds).

Layer 1 (builders) is a prerequisite for layers 2 and 3. Layer 2 is cheap and catches the most common bugs. Layer 3 is more expensive but proves the system works.

**When this rule applies**: any time you notice that the existing test builders don't cover the data shape your new code handles. If every builder in `synthetic.py` produces bare evidence and your code handles sliced evidence, you cannot test your code with the existing infrastructure. Building the builder is part of the work — not a follow-up, not "we should add tests later", not the user's job to commission.

**Current known gaps** (update this list as gaps are filled):
- Contexted/sliced evidence builders (`has_slices=True`, `slice_groups` populated) — MISSING
- Phase 2 frozen-prior pipeline (Phase 1 → moment-match → Phase 2) — MISSING
- MECE aggregation through `bind_evidence` / `bind_snapshot_evidence` — MISSING
- `summarise_posteriors` with per-slice extraction — MISSING
- Per-slice latency inheritance (sigma, onset from edge-level) — MISSING

## Synth Graph Test Fixtures

Tests that depend on synth graphs from the data repo use the `@requires_synth` decorator (defined in `graph-editor/lib/tests/conftest.py`). This replaces the copy-pasted boilerplate that was previously in every test file.

**Usage:**

```python
from conftest import requires_synth, requires_db, requires_data_repo

@requires_db
@requires_data_repo
class TestMyAnalysis:
    @requires_synth("synth-simple-abc", enriched=True)
    def test_cohort_maturity_output(self):
        # Synth graph is guaranteed fresh + enriched.
        ...
```

**What it does:**
- Runs `verify_synth_data()` with comprehensive v2 freshness checks (truth hash, graph hash, event hashes, core_hash integrity, param files, enrichment state)
- If stale or missing: auto-bootstraps via `synth_gen.py --write-files`
- If `enriched=True` and not enriched: auto-enriches via `synth_gen.py --enrich` (requires Python BE on localhost:9000)
- If no data repo or DB: skips cleanly
- Session-scoped: regen happens at most once per graph per session

**Shared fixtures also available:**
- `requires_db` — skip marker when `DB_CONNECTION` not set
- `requires_data_repo` — skip marker when data repo unavailable
- `_resolve_data_repo_dir()` — returns `Path` to data repo or `None`
- `_resolve_db_url()` — returns DB connection string or `''`

**Key rule:** Do NOT copy-paste data repo resolution or DB markers into test files. Import from `conftest` instead.

**`synth_gen.py` flags for manual use:**
- `--write-files` — generate graph + simulation + hashes + DB + param files
- `--enrich` — also run hydrate (topo pass + promotion) after generation
- `--bust-cache` — skip freshness check, regenerate unconditionally

## Wallclock invariance for date-DSL tests

Tests that exercise query DSL with relative date forms (`window(-90d:)`, `cohort(-Nd:)`, `cohort(<anchor>,-Nd:)`, `asat(-Nd)`) **drift as wallclock advances**. The relative form resolves at request time against the BE's `date.today()`, so what was "the last 90 days of fixture data" when authored becomes "a 90-day window that no longer overlaps fixture data" once enough wallclock has passed. The test then either silently slides into vacuity (assertions pass against zero-evidence posterior-only curves — AP17) or starts failing for reasons unrelated to the regression it was meant to catch.

The audit and per-test ledger for this work live at `docs/current/test-wallclock-flakiness-audit.md`. The canonical hardening pattern below is the strategy applied against that ledger.

### The hardening toolkit (in order of preference)

1. **Re-author drift-coupled assertions.** If the assertion reads `max(curve)`, `last(rows)`, chart length, forecast horizon, or any quantity that grows with `sweep_to` / `eval_age`, rewrite it to express the test's intent without that coupling — e.g. assert at named τ anchors (`τ ∈ {0, 7, 14, 30, 60}`), or by anchor day. This is the cheapest fix when the test's *intent* is drift-stable but its *expression* isn't. Don't naively assert on `tau_max` — that's dangerous, even after pinning.
2. **Pin DSL scope absolutely** to the today's-resolution at pin date. Convert `window(-90d:)` → `window(<today − 90d>:<today>)`, e.g. `window(29-Jan-26:29-Apr-26)` for a pin date of 29-Apr-26. Encode the pin date in a comment so a future reader can reconstruct the rationale. **Do NOT** pin to the synth's full data span — that widens the `sweep_to` range (anchor_from earlier → wider sweep → ~75% runtime increase) for no test-value gain on symmetric assertions. **Do NOT** pin to authoring-time today — usually a few days off from current today; cosmetic difference but makes the ledger inconsistent. Today's-resolution is the default.
3. **Modify the synth fixture** if the test's premise requires a fixture shape (different `base_date`, `n_days`, `retrieved_at` distribution) the existing synth doesn't provide. The synth machinery is fully under our control; if a `-1d:` test needs "1 day of real evidence at the fixture tail", the right fix may be to ensure the synth has that data, not to bend the test around the gap.
4. **Add `.asat(<date>)`.** Reserved for tests whose intent is genuinely "as of date X" — the existing `test_asat_blind` pattern. **Risky** for general wallclock-freeze use because asat triggers six confounding code paths in the BE (admission filter, scope hash, sweep cap, SQL filter, cache key, eval_age compute — see `DATE_MODEL_COHORT_MATURITY.md` §1.5). Adding asat to make a test deterministic makes the test's outcome dependent on asat being defect-free; if asat has a bug, your "stable" test inherits it.
5. **Wallclock-freeze in the test process.** `freezegun`-style. Works for in-process tests trivially. For daemon-routed tests, would require threading a frozen-today through FE+BE+DB+synth-regen — large surface and a separate audit cost. Not worth the operational complexity for current scope.

### The symmetric-assertion principle

When a test compares two same-DSL-shape calls (window vs cohort, v2 vs v3, parity across CLI surfaces), both sides see the same wallclock-derived inputs. Their delta is wallclock-invariant in result regardless of where the window happens to be looking. For these tests, **scope-pin alone is sufficient invariance** — `sweep_to` / `eval_age` drift cancels because both sides see it identically. No `.asat()` needed; adding it just buys cache-hash and code-path complications.

The test value loss from drift in such a symmetric test isn't pass/fail flipping — it's the test silently moving from exercising the population model to exercising the posterior-only fallback path. Pin scope → exercise the same evidence regime forever → preserve test value indefinitely.

### Synth fixtures are content-deterministic

The pinning approach assumes synth fixtures don't drift underneath the pin. They don't:

- `bayes/synth_gen.py` hardcodes per-graph `base_date` and uses `seed=42` (DEFAULT_SIM_CONFIG line). RNG is `np.random.default_rng(42)` — every random draw reproducible.
- `verify_synth_data` checks only content hashes (truth SHA256, graph SHA256, param hashes, FE-parity probe). **No wallclock-based staleness criterion**; the synth never regenerates "because it got old".
- `enriched_at` and `generated_at` in synth-meta are wallclock-stamped but consumed only by self-tests of the synth machinery, not by the analysis pipeline.
- Snapshot DB rows have `retrieved_at = base_date + fetch_night` — deterministic, not wallclock.

A pinned absolute window stays valid through any number of regenerations as long as `base_date` and `n_days` are unchanged in source.

### The deferred case: `-1d:` and other narrow-window forms

Tests using `window(-1d:)` / `cohort(-1d:)` need a per-test design decision before pinning, because there are two possible authoring intents and the existing DSL is ambiguous between them:

- **Vacuous-by-design**: the test wants zero evidence (e.g. testing posterior-only fallback). Replace with an explicitly out-of-fixture absolute window, e.g. `window(1-Jan-30:2-Jan-30)`, and add a comment that the empty window is deliberate.
- **Narrow-real-evidence**: the test wants 1-2 days of real fixture evidence (e.g. testing low-evidence cohort behaviour). Replace with an absolute narrow window inside the fixture tail, e.g. `window(20-Mar-26:21-Mar-26)`. The assertion may need re-tuning if the test was previously passing trivially against zero evidence; that's the test design defect surfacing, not a regression caused by the pin.

When the authoring intent is ambiguous from code alone, surface to the user — don't pick one silently.

## CLI-driven Python tests run through a daemon by default

Pytest tests under `graph-editor/lib/tests/` that exercise
`analyse.sh` / `param-pack.sh` route through a long-lived `tsx` daemon
by default — see `GRAPH_OPS_TOOLING.md` §"Long-lived daemon mode" for
the full design. The cached helpers `_run_analyse_cached` /
`_run_param_pack_cached` lazy-start the daemon on first call and tear
it down via `atexit`. This amortises the ~1.2s Node + tsx +
module-graph startup over the session and gives a ~2× wall-time
reduction on test files that fire many CLI calls.

The daemon honours per-request `--no-cache` and `--no-snapshot-cache`
identically to the subprocess path, so the cache-bypass guarantee
tests rely on is preserved. To bisect a daemon-specific suspicion, set
`DAGNET_USE_DAEMON=0` and the helpers fall back to per-call
`subprocess.run` (each invocation gets a fresh Node process — full
isolation, no shared state). The parity script
`graph-editor/lib/tests/_daemon_parity_check.py` runs representative
tuples through both paths and asserts byte-equal JSON; run it after
any change to `src/cli/bootstrap.ts`, `src/cli/daemon.ts`, or any
service they import.

## Cache-bypass discipline for outside-in CLI tests

Tests that drive the CLI must pass **both** `--no-cache` (disk bundle
cache, fingerprinted on source-file mtime) **and** `--no-snapshot-cache`
(BE Python `snapshot_service._cache`, a 15-min TTL keyed on
`(fn_name, args)`) on every analyse and param-pack invocation. Both
caches are deterministic and safe in production, but neither is
fingerprinted against BE source code: a dev workflow that edits BE
Python and re-runs a test inside the TTL window can otherwise be
satisfied by a stale cached result.

`paramPack.ts` accepts `--no-snapshot-cache` (added so tests can
bypass the BE TTL on every param-pack call — `analyse.ts` already
had it). The flag sets `globalThis.__dagnetComputeNoCache` which
`graphComputeClient.ts` threads into the request body as
`no_cache: true`. The BE wraps the handler in `cache_bypass_ctx()`
(see `api_handlers.py`).

The wave-3 outside-in tests (`test_asat_blind.py`,
`test_multihop_evidence_parity.py`, `test_conditioned_forecast_parity.py`)
all pass both flags on every call. Older outside-in tests inherited
from the bash originals may not — audit before reusing them as the
basis for new fixtures. The cost of hardening is ~10 seconds total
across the wave-3 suite (still ~1.94× faster than the bash originals);
worth it for the safety guarantee.

## Audit trail for any rebuild / regen

The fixture machinery in `lib/tests/conftest.py` must surface the
*reason* whenever it triggers a snapshot regen or MCMC sidecar build.
"Just runs sometimes" is unacceptable for a tool chain agents and
operators rely on.

- `_ensure_synth_ready` reads the `reasons` list returned by
  `verify_synth_data` and prints every entry under the
  `[requires_synth]` prefix before kicking off `synth_gen.py`. Each
  reason names the specific check that failed (truth hash drift,
  graph JSON drift, event hash drift, missing param file, query
  signature mismatch, etc.) so the operator can confirm the regen
  was warranted.
- `_ensure_bayes_sidecar` does not blindly trust `load_sidecar`
  returning `None`. The helper `_explain_sidecar_staleness` re-reads
  the sidecar, classifies the rejection (file missing, schema drift,
  fingerprint mismatch), and on fingerprint mismatch diffs every
  changed key (`saved=… expected=…`). All reasons are printed before
  MCMC is launched.

When adding a new fixture that triggers expensive generation,
preserve this contract: emit a precise reason for every rebuild,
never just a status word.

## Slow-call self-diagnostic

`DaemonClient.call` emits a stderr audit block whenever any CLI
request exceeds `DAGNET_SLOW_CALL_THRESHOLD_S` seconds (default 10).
The block contains the graph, query, daemon age + RSS, and the slice
of daemon stderr captured during the request. See
`GRAPH_OPS_TOOLING.md` §"Slow-call self-diagnostic" for the full
contract.

When a test file logs an unexplained slow run, search for
`daemon-slow-call` in the captured pytest output. The accompanying
block is sufficient to triage which call on which graph stalled,
without rerunning the test.

## When to Skip Tests

Not every change needs a test. Pure refactors with no behaviour change, documentation edits, and config tweaks do not need tests. But any change that **introduces a new code path, replaces an existing code path, or changes how data flows between subsystems** needs a test — and that test must exercise the real boundary, not a mock of it.

## Running Tests

**CRITICAL: Only run RELEVANT tests, not the full suite.**

**Cursor sandbox note**: The default Cursor sandbox hides `node_modules`. Use `required_permissions: ["all"]` on Shell tool calls that run npm/vitest.

**Standard invocation**: `cd graph-editor && npm test -- --run src/services/__tests__/yourFile.test.ts`

- **ALWAYS use file paths, NOT patterns** — patterns are extremely slow in Vitest. Never use `--testNamePattern`.
- **Default**: run only tests related to files you changed. **Full suite**: only when user explicitly requests it.
- **Frontend**: `npm test -- --run path/to/file.test.ts`
- **Python**: `pytest tests/specific_test.py` (activate venv first)
- Run BOTH only if changes affect both frontend and Python

## Investigating Test Failures

This is a specific application of the "No 'Not My Problem' Dismissals" rule (see `DEBUGGING_DISCIPLINE.md`). Every test failure is your responsibility to investigate, regardless of whether your changes caused it. You **own** the investigation.

Your job for **every** failure:

1. **Read the failing test** — understand what invariant it protects.
2. **Check recent changes** — use `git log` and `git diff` to identify what changed in the file under test or its dependencies.
3. **Trace the root cause** — determine whether the failure is from your change (indirect coupling), a recent commit on the branch, or a genuinely flaky test.
4. **Report findings** — tell the user exactly what broke and why, with file paths and line numbers.
5. **Propose a fix or flag it** — either fix it (if within scope and low risk) or explicitly flag it as needing attention with enough context for the user to act.

Never say "unrelated, pre-existing" without evidence. If you haven't checked the git history and the test's dependencies, you don't know whether it's pre-existing.

## Running Playwright E2E Tests (DagNet)

**CRITICAL: Playwright tests MUST be brisk. If a single Playwright spec does not complete in ~10–15s, treat that as a PROBLEM WITH THE TEST (or environment), not a cue to increase timeouts.**

**Default posture**:
- **Run a single spec** (or a small set) by file path, not the full suite, unless explicitly asked.
- **Hard cap the run** with `--global-timeout` so it cannot silently hang.
- **Never "fix" flakiness by inflating timeouts**; instead reduce work (fewer page reloads, fewer waits), improve determinism, or add targeted E2E hooks (DEV + `?e2e=1` only).

**Standard invocation (single spec, hard cap, single worker, no retries)**:
- Ensure Node is available via `graph-editor/.nvmrc`.
- Then run:
  - `cd graph-editor`
  - `CI= PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" npm run -s e2e -- e2e/yourSpec.spec.ts --workers=1 --retries=0 --reporter=line --timeout=10000 --global-timeout=15000`

**Key rules**:
- **Always run in the foreground** (do not background long runs).
- **Reuse server**: when running locally, ensure `CI` is unset (`CI=`) so Playwright can reuse the existing dev server (`reuseExistingServer: true`).
- **Browser path sanity**: if Playwright complains a browser executable is missing but you know it is installed, check for a **bad `PLAYWRIGHT_BROWSERS_PATH`** pointing at a sandbox/tmp directory. Prefer `"$HOME/.cache/ms-playwright"` in this repo's environment.

**If a spec is slow (>15s)**:
- First assume the test is doing too much: too many reloads, slow selectors, unnecessary waits, or nondeterministic UI interactions (especially SVG hit-testing).
- Make the test smaller and more deterministic; if needed, add a **dev-only** E2E hook behind `import.meta.env.DEV` + `?e2e=1` to avoid brittle UI gestures.
