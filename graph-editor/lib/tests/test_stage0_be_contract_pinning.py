"""Stage 0 BE contract pinning tests (doc 73b §8 Stage 0).

Pins three end-state contracts on the BE side. Some assertions are
expected to fail until later 73b stages land; those use ``xfail`` with
the owning stage cited so they can be flipped to ``passed`` when the
corresponding work lands and a regression cannot silently reintroduce
the violation.

Pinned contracts:

1. **Layer-isolation invariant** (doc 73b §3.3.3, §6.5; binding per §8
   "At least one Stage 0 test must prove..."). Changing scoped
   ``p.evidence.{n, k}`` does not change the resolved source prior
   (``alpha``, ``beta``) when ``model_vars[analytic]`` carries a valid
   §3.9 source-layer shape. Currently violated by the resolver D20
   shortcut at ``model_resolver.py:391-415`` (§3.8 register entry 1);
   Stage 2 closes the violation by routing analytic α/β reads through
   ``model_vars[analytic].probability``.

2. **`analytic_be` absence in live graph-editor code** (acceptance
   criterion 2). The literal ``analytic_be`` must not appear in
   ``graph-editor/lib`` or ``graph-editor/src`` (these are the FE TS,
   FE-served Python runtime, and CLI surfaces). The only documented
   retention is ``bayes/compiler/loo.py:119`` per §5 Action A1 —
   legacy-snapshot source-name fallback in the offline Bayes compiler,
   not in the live system.

3. **Consumer rule** (§3.4, §6.5): forecast runners that read promoted
   model state must not consume L4/L5 current-answer fields
   (``p.mean``, ``p.evidence.*``, ``p.stdev``, ``p.stdev_pred``,
   ``p.n``, ``p.latency.completeness*``) as model-bearing inputs.
   Stage 0 pins the carrier-style ``p.mean`` reads called out in
   §6.5 / Stage 4(d) so Stage 4(d)'s audit cannot regress.
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

GRAPH_EDITOR_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', '..')
)
LIB_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'lib')
SRC_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'src')


def _make_analytic_only_edge(n, k, *, with_full_analytic_shape=True):
    """Build an edge whose source layer is analytic-only, no bayesian.

    When ``with_full_analytic_shape`` is True the edge carries the
    §3.9-mirror Beta-shape and source-mass fields under
    ``model_vars[analytic].probability``. The current-answer
    ``p.evidence.{n, k}`` are scoped values and must not feed the
    resolved α, β when the §3.9 shape is present.
    """
    p_mean = (k + 1.0) / (n + 2.0) if n > 0 else 0.5
    probability = {'mean': p_mean, 'stdev': 0.05}
    if with_full_analytic_shape:
        # §3.9 source-layer Beta shape derived from aggregate window
        # evidence — independent of the user's scoped p.evidence.
        probability.update({
            'alpha': 30.0,
            'beta': 70.0,
            'n_effective': 100.0,
            'window_n_effective': 100.0,
            'provenance': 'analytic_window_baseline',
        })
    return {
        'p': {
            'forecast': {'mean': p_mean},
            'evidence': {'n': n, 'k': k},
            'model_vars': [
                {
                    'source': 'analytic',
                    'probability': probability,
                    'latency': {
                        'mu': 2.0,
                        'sigma': 0.5,
                        'onset_delta_days': 0.0,
                    },
                }
            ],
        }
    }


def test_layer_isolation_scoped_evidence_does_not_change_source_prior():
    """Layer-isolation invariant (§3.3.3, §6.5; §8 binding).

    With ``model_vars[analytic]`` carrying a valid §3.9 source-layer
    shape, two resolutions that differ only in ``p.evidence.{n, k}``
    must produce identical α, β, n_effective on the resolved
    promoted source prior.

    Stage 2 (Decision 13) closes this gate: the resolver now reads
    aggregate α, β from ``model_vars[analytic].probability``; the
    D20 evidence-count synthesis path was removed.
    """
    from runner.model_resolver import resolve_model_params

    edge_small = _make_analytic_only_edge(n=10, k=2)
    edge_large = _make_analytic_only_edge(n=1000, k=200)

    resolved_small = resolve_model_params(edge_small)
    resolved_large = resolve_model_params(edge_large)

    assert resolved_small is not None and resolved_large is not None
    assert resolved_small.source == 'analytic'
    assert resolved_large.source == 'analytic'

    assert resolved_small.alpha == resolved_large.alpha, (
        f"Resolved α changed with scoped evidence: "
        f"{resolved_small.alpha} → {resolved_large.alpha}. "
        f"§3.3.3 forbids reading L4/L5 fields as model input."
    )
    assert resolved_small.beta == resolved_large.beta, (
        f"Resolved β changed with scoped evidence: "
        f"{resolved_small.beta} → {resolved_large.beta}."
    )
    assert resolved_small.n_effective == resolved_large.n_effective, (
        f"Resolved n_effective changed with scoped evidence: "
        f"{resolved_small.n_effective} → {resolved_large.n_effective}."
    )


def test_analytic_be_absent_from_live_graph_editor_code():
    """`analytic_be` must not appear in graph-editor lib/ or src/.

    Acceptance criterion 2 (§9): the only documented retention of the
    literal is ``bayes/compiler/loo.py`` per §5 Action A1.
    """
    offenders = []
    for root in (LIB_ROOT, SRC_ROOT):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d not in (
                    '__pycache__', 'node_modules', '.pytest_cache',
                    'tests', '__tests__',
                )
            ]
            for fname in filenames:
                if not fname.endswith(('.py', '.ts', '.tsx', '.js', '.jsx')):
                    continue
                if fname.endswith(('.test.ts', '.test.tsx', '.spec.ts')):
                    continue
                path = os.path.join(dirpath, fname)
                try:
                    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                # Reject only the literal token "analytic_be"; allow
                # function names like `_analytic_best` that share a
                # prefix.
                for m in re.finditer(r'\banalytic_be\b', content):
                    line_no = content[:m.start()].count('\n') + 1
                    offenders.append(f"{path}:{line_no}")

    assert not offenders, (
        "`analytic_be` literal must not appear in live graph-editor "
        "code (acceptance criterion 2). Offenders:\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.xfail(
    reason=(
        'doc 73b Stage 4(d): _resolve_edge_p in forecast_state.py and '
        'sibling carrier reads in graph_builder.py:202 / path_runner.py:105 '
        'still read p.mean as a model input. Stage 4(d) routes them through '
        'resolve_model_params.'
    ),
    strict=True,
)
def test_consumer_rule_carrier_reads_route_through_resolver():
    """Consumer rule (§3.4, §6.5): carrier-style reads in the BE
    forecast runners must go through ``resolve_model_params`` and
    must not consume ``p.mean`` directly as a model-bearing input.

    Pinned via source inspection — the listed lines must not contain
    a direct ``p.mean`` / ``p['mean']`` / ``p.get('mean')`` read used as
    model input. Stage 4(d)'s audit closes this; the test pins the
    end-state.
    """
    forecast_state_path = os.path.join(
        LIB_ROOT, 'runner', 'forecast_state.py'
    )
    graph_builder_path = os.path.join(
        LIB_ROOT, 'runner', 'graph_builder.py'
    )
    path_runner_path = os.path.join(
        LIB_ROOT, 'runner', 'path_runner.py'
    )

    bad_patterns = [
        re.compile(r"\.get\(\s*['\"]mean['\"]\s*\)"),
        re.compile(r"\['mean'\]"),
        re.compile(r"\['mean'\]"),
    ]

    offenders = []
    for path in (forecast_state_path, graph_builder_path, path_runner_path):
        if not os.path.exists(path):
            continue
        with open(path, 'r', encoding='utf-8') as f:
            for line_no, line in enumerate(f, start=1):
                stripped = line.strip()
                if stripped.startswith('#'):
                    continue
                for pat in bad_patterns:
                    if pat.search(line):
                        offenders.append(
                            f"{os.path.basename(path)}:{line_no}: {stripped}"
                        )
                        break

    assert not offenders, (
        "Carrier consumer reads must route through resolve_model_params "
        "(§6.5 / Stage 4(d)). Offending direct p.mean reads:\n  "
        + "\n  ".join(offenders[:20])
    )
