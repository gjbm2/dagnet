# Project Assure: Schema-Driven Contract Testing for CLI Param Pack Output

**Status**: Proposal (draft)
**Date**: 17-Apr-26

## Problem

The CLI param pack is the canonical output of the dagnet stats pipeline. Five CLI commands consume it (param-pack, analyse, parity-test, bayes, hydrate), the CSV batch runner drives regression testing from it, and the browser scenarios system composes and edits it. If the param pack silently drops a field or produces a wrong value, everything downstream is compromised.

The current test regime cannot detect silent omissions. Every assertion checks a value the test author already knew to expect. No test asks "is this the complete output?" or "does this value satisfy a domain constraint?" As a result, 23 tests pass while `t95` has never appeared in the output, `p.mean` has never been verified, and `forecast.stdev` is extracted by dead code that nothing populates. These deficiencies were found during a 17-Apr-26 investigation but they are symptoms of the testing approach, not one-off bugs.

## Design

The published graph schema (`conversion-graph-1.1.0.json`) already defines every field on every type using JSON Schema draft 2020-12, with `$defs` for `ProbabilityParam`, `LatencyConfig`, `ForecastParams`, `CostParam`, and structured definitions for `Edge`, `Node`, and their sub-objects. It already distinguishes user-facing from internal fields via descriptions and comments. What it lacks is a formal, machine-readable declaration of which fields constitute the param pack.

The proposal adds that declaration to the schema, then builds two layers of automated testing on top of it.

### Layer 1: Structural contract

Add `"x-param-pack": true` to each property in the schema that should appear in param pack output. JSON Schema supports arbitrary `x-` extension keywords (standard practice in OpenAPI); they don't affect validation and don't break existing consumers.

The annotation goes on the canonical user-facing field, not on internal staging fields. For example, `t95` gets the annotation; `promoted_t95` does not. The pipeline's contract is to ensure `t95` is populated from whatever source (currently `promoted_t95` via the promotion step). This keeps the `promoted_` prefix as a pure internal implementation detail.

The annotations live on the schema definitions that already describe the field. `ProbabilityParam.mean`, `ProbabilityParam.evidence.n`, `LatencyConfig.t95`, `ForecastParams.mean`, `CostParam.mean`, `Edge.weight_default`, `Node.entry.entry_weight`, `Node.case.variants[].weight` — approximately 20 fields across 6 definitions.

A structural test loads the schema, walks `$defs`, follows `$ref` links, and collects every `x-param-pack: true` path. It then runs the CLI pipeline on a fixture graph and asserts:

- Every annotated field appears in the output (given the edge/node configuration).
- No un-annotated field appears in the output.

Conditionality — not every field applies to every edge — is resolved by reading the fixture graph itself: does this edge have `latency_parameter: true`? Then latency fields are expected. Does this node have `case.variants`? Then case fields are expected. The schema doesn't need to encode conditions; the graph already does.

When someone adds a new field to the schema, they mark it `x-param-pack` or not. If they mark it but the pipeline doesn't populate it, the structural test fails. If the pipeline emits a field that isn't marked, the structural test fails. One decision point, one source of truth.

### Layer 2: Semantic invariants

A field can exist with a garbage value and pass structural checks. Every param-pack field needs a domain invariant — a statement that holds from outside the system regardless of implementation.

Examples:

| Field | Invariant | Basis |
|-------|-----------|-------|
| `p.mean` | `0 < x < 1` | It's a probability |
| `evidence.mean` | `x == evidence.k / evidence.n` | Definition |
| `evidence.n` | `x >= evidence.k` | Can't have more successes than trials |
| `evidence.stdev` | `x approx sqrt(mean * (1 - mean) / n)` | Binomial SE |
| `t95` | `x > median_lag_days` | 95th percentile exceeds median for right-skewed distributions |
| `path_t95` | `x >= t95` | Path can't be shorter than the edge |
| `completeness` | `0 <= x <= 1` | It's a fraction |

These are mathematical or physical truths, not implementation checks. If the pipeline violates one, something is wrong regardless of where.

The invariant registry lives in test code — a map from field path patterns to assertion functions. Test code is the natural home because invariants need to reference the full output (cross-field checks like `n >= k` require access to sibling values), and they're type-checked and co-located with the tests that run them.

A meta-test then compares the schema's param-pack field set against the invariant registry's keys and fails if any field lacks a registered invariant. This forces anyone adding a new param-pack field to define what "correct" looks like for it before the tests pass.

### Summary

The schema says WHAT fields are param-pack. The invariant registry says HOW to validate them. The meta-test ensures every WHAT has a HOW. Together they catch three failure modes the current tests miss:

- A field is silently dropped (structural).
- A field has a wrong value (semantic).
- A new field is added without defining correctness (meta).

## Design decisions

**Annotation goes on the canonical field, not the internal staging field.** `t95` is annotated, `promoted_t95` is not. The pipeline must ensure the canonical field is populated. The current deficiency — `promoted_t95` is written but never copied to `t95` — is a pipeline bug that the structural test would catch, not a schema modelling problem.

**Conditionality is derived from the graph, not encoded in the schema.** The test reads the fixture graph to determine which field groups apply. This avoids inventing a condition DSL inside JSON Schema and keeps the schema annotations simple booleans.

**Invariants live in test code, not in the schema.** JSON Schema can express simple bounds (`minimum`, `maximum`) but not relational constraints (`n >= k`, `t95 > median_lag_days`). Putting invariants in code avoids a second expression language and keeps them type-checked.

**This layers on top of existing tests, it doesn't replace them.** The existing `cliParamPack.test.ts` tests specific numerical values with hand-computable fixtures. `ParamPackDSLService.test.ts` tests serialisation round-trips. `paramPackCsvRunner` drives integration testing from CSV. The new contract tests add structural completeness, semantic validity, and coverage enforcement — a different failure mode from "this specific number is wrong."

## Open questions

**Which borderline fields are param-pack?** The clear yes/no cases are listed above. Fields needing a decision:

- `completeness_stdev` — only populated by the BE topo pass, not the FE path. If it's param-pack, the FE path has a gap to close.
- `forecast.stdev` — extracted by `GraphParamExtractor` but never populated by any pipeline stage. Dead code, or a field awaiting a producer?
- `latency.onset_delta_days` — used by downstream analysis types. Internal model parameter or user-visible?
- `cost_gbp.distribution`, `labour_cost.distribution` — currently extracted. Are distribution names part of the param pack contract?

These don't block the structural/semantic testing work — they just determine which fields get the annotation.

---

## CLI production readiness

The contract testing above addresses output correctness. A separate set of problems affects the CLI as a tool that agents and automated workflows depend on: it's slow, logging is unreliable, tracing is hard, and failure modes are opaque.

### Startup cost

`param-pack.ts --help` takes 2 seconds. The entry point imports `fake-indexeddb`, then dynamically imports the command module, which imports the full browser pipeline (`fetchDataService`, `UpdateManager`, `statisticalEnhancementService`, etc.). The tsx transpiler adds further overhead. For an agent running param-pack in a loop — say, sweeping across multiple DSL queries — this 2-second cold start per invocation dominates wall-clock time.

The cached disk loader (`loadGraphFromDiskCached`) avoids re-parsing YAML files on repeated calls, but it doesn't help with the import/transpilation cost. The fundamental issue is that the CLI loads the entire browser codebase to run headlessly. There's no lightweight entry path.

Possible approaches: pre-bundling the CLI commands (esbuild/rollup to a single .mjs file eliminates tsx overhead), a warm-server mode that keeps the process alive between invocations, or a batch mode that accepts multiple queries in a single run. These need profiling to understand where the 2 seconds actually goes (transpilation? module initialisation? fake-indexeddb setup?).

### Logging discipline

The CLI's own logger (`logger.ts`) correctly writes to stderr with `[cli]` prefixes. But it sits on top of 344 `console.log`/`warn`/`info`/`error` calls across the shared pipeline services (`fetchDataService`: 36, `UpdateManager`: 79, `dataOperations/`: 229). These are designed for the browser devtools, not CLI consumption.

The suppression in `cliEntry.ts` replaces `console.log`, `console.warn`, and optionally `console.info` with noops before any other imports. This works — mostly. But it's fragile:

- Any module that captures a reference to `console.log` at import time (before `initCLI()` runs) bypasses the suppression.
- `console.error` is never suppressed, so anything that writes to `console.error` in the shared services goes to stderr unsolicited. This isn't always wrong (errors should go to stderr) but it's uncontrolled — the output mixes CLI logger prefixed lines with raw unprefixed output from deep in the pipeline.
- The `--verbose` flag un-suppresses everything, flooding stderr with hundreds of browser-oriented debug lines that aren't useful for CLI troubleshooting.

The result: without `--verbose`, you get clean but opaque output. With `--verbose`, you get a firehose. There's no middle ground where you can see what the CLI is doing without drowning in pipeline internals.

What's needed is levelled, structured logging that the CLI controls. The shared services shouldn't write to console directly — they should go through a logging interface that the CLI can configure (suppress, redirect, filter by level, format as JSON lines). This is a larger refactor but it's the root cause of both the "can't trace what happened" and "stray output contaminates stdout" problems.

### Stream discipline

stdout is reserved for data output. The CLI logger writes to stderr. But `console.error(USAGE)` in the command files writes the help text to stderr, and the parity-test command writes its progress and results to `console.error` (not through the CLI logger). The conventions are inconsistent across commands.

For agentic use, the contract should be absolute: stdout contains only the structured output (YAML, JSON, CSV, or a bare scalar for `--get`). stderr contains only log lines, prefixed and levelled. Any violation is a bug. No test currently enforces this.

### Exit codes and failure signalling

Every command uses the same two exit codes: 0 (success) and 1 (everything else). An agent can't distinguish:

- Bad input (malformed DSL, missing graph, wrong arguments)
- Infrastructure failure (BE unreachable, connection error)
- Degraded success (BE topo pass failed, fell back to FE-only values)
- Partial failure (some edges aggregated, others didn't)

The degraded-success case is the most insidious. The command exits 0, the output looks structurally complete, but values are lower quality because the BE wasn't available. An agent has no signal that something was lost.

Options: distinct exit codes (2 = degraded, 3 = partial failure), a `--strict` flag that promotes degradation to failure, or structured metadata in the output itself (a `_meta` block with pipeline status). The right answer probably depends on how agents actually consume the output — whether they check exit codes, parse metadata, or just trust the values.

### Determinism

For regression testing and agentic diffing, identical inputs should produce identical outputs. Potential sources of non-determinism:

- Floating-point ordering (aggregation order affecting accumulated rounding)
- Object key insertion order in JSON output
- Topological sort tie-breaking (stable across runs?)
- Timestamps leaking into output (the `retrieved_at` field is excluded from param packs, but are there others?)

This needs verification rather than assumption. A simple test — run the pipeline twice on the same fixture, diff the outputs — would surface any issues.

### What to test

None of the above is tested today. The existing tests import pipeline functions and call them directly. No test spawns the CLI as a subprocess. The process-level testing surface includes:

- **Stream separation**: invoke the CLI, capture stdout and stderr separately, assert stdout contains only valid YAML/JSON/CSV and stderr contains only prefixed log lines.
- **Exit codes**: invoke with bad DSL, missing graph, unreachable BE, and assert specific exit codes for each.
- **Determinism**: invoke twice with identical inputs, assert byte-identical stdout.
- **Cold start**: measure and assert a time budget (this also creates pressure to optimise).
- **Degradation signalling**: invoke without BE, verify the output indicates degradation (however that's designed).
- **Batch/sweep**: if a batch mode is added, test that N queries in one invocation produce the same results as N separate invocations.

These are subprocess tests — they spawn `npx tsx src/cli/param-pack.ts` as a child process and inspect its behaviour from the outside. They test the CLI as a Unix tool, not as a collection of functions.
