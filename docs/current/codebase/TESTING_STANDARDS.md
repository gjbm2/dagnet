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
