# Bayes-Vars Sidecar Fixtures

Per-graph cached MCMC posteriors checked into the repo so pytest sessions
don't re-run the multi-minute fitter on every clean checkout. Sidecars are
keyed by a content fingerprint over `<graph>.truth.yaml` plus every
parameter file the graph references; any change to the truth or the params
flips the fingerprint and forces a fresh fit on next test run.

Schema and reader/writer live in [`bayes/sidecar.py`](../sidecar.py); the
dataclass is the contract.

## Canonical sidecars (this directory)

`<graph>.bayes-vars.json` — the canonical per-graph fit. **Never mutate
these from a test run.** They get rebuilt by
`_ensure_bayes_sidecar(graph_name)` (see below) when the fingerprint drifts
or `fitted_at` is missing/empty.

## `.test-cache/` (gitignored)

`<graph>.fitted-<asat-yyyymmdd>.bayes-vars.json` — per-test backdated
copies, written by `_ensure_bayes_sidecar_for_asat(graph, asat)`. The
content fingerprint is identical to the canonical (the sidecar fingerprint
hashes parameter content, not `fitted_at`), so cache invalidation still
works correctly. The directory is created on demand and is gitignored at
the repo root.

## Conftest helpers — when to use which

Both live in [`graph-editor/lib/tests/conftest.py`](../../graph-editor/lib/tests/conftest.py).

- **`_ensure_bayes_sidecar(graph_name)`** — use when the test:
  - does **not** apply `--bayes-vars` at all, or
  - applies `--bayes-vars` but does **not** use `asat()`, or
  - uses `asat()` whose date is on or after the canonical fit's
    `fitted_at`.

  Returns the canonical sidecar path; rebuilds via the harness when the
  fingerprint drifts or `fitted_at` is empty.

- **`_ensure_bayes_sidecar_for_asat(graph_name, *, as_at=None)`** — use when
  the test applies `--bayes-vars` AND has an `asat()` clause that may be in
  the past relative to the canonical fit. Without backdating, the FE's
  `resolveAsatPosterior` would strict-drop the bayesian projection because
  `fitted_at > asat`, silently reverting the chart to the analytic source.

  `as_at` is a UK-format date string (`d-MMM-yy`) — keyword-only. When
  `None`, the helper degrades to `_ensure_bayes_sidecar` semantics, so it
  is safe to call interchangeably regardless of whether the test uses
  `asat()`.

  The helper:
  1. Calls `_ensure_bayes_sidecar(graph_name)` to obtain the canonical
     payload.
  2. If `as_at is None`, returns the canonical path unchanged.
  3. If the canonical's `fitted_at` is already on or before
     `as_at - 1 day`, returns the canonical path unchanged.
  4. Otherwise, materialises a backdated copy at
     `bayes/fixtures/.test-cache/<graph>.fitted-<yyyymmdd>.bayes-vars.json`
     with the same payload and a `fitted_at` rewritten to one day before
     `as_at`. Idempotent — repeated calls reuse the cached file.

  The canonical sidecar is **never** mutated.

## Why this design

`fitted_at` is a posterior timestamp, distinct from the content
fingerprint. Tests that exercise past `asat()` need the bayesian
projection to be visible at that date; the cleanest way to get that without
either (a) re-fitting per test (expensive) or (b) overwriting the canonical
(pollutes git) is a per-test backdated copy keyed by the asat date.

See [`docs/current/asat-bayes-vars-fix-plan.md`](../../.claude/plans/asat-bayes-vars-fix.md)
(planning doc) and the test patterns in:

- [`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)
  — d3, d4, d6 use `_ensure_bayes_sidecar_for_asat`.
- [`test_cohort_maturity_no_evidence_truth.py`](../../graph-editor/lib/tests/test_cohort_maturity_no_evidence_truth.py)
  — uses `_ensure_bayes_sidecar_for_asat` for the public-tooling no-evidence
  canary.
