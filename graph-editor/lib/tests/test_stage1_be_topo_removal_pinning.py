"""Stage 1 / Work-package-A pinning tests (doc 73b §5).

Pins the absence of removed BE-topo surfaces so a future revision
cannot silently re-introduce them. §5 Action A1 spells out the exact
verification set:

- Removed files: ``graph-editor/src/services/beTopoPassService.ts``,
  ``graph-editor/src/services/forecastingParityService.ts``,
  ``graph-editor/lib/runner/stats_engine.py`` — none should exist.
- ``analytic_be`` literal must not appear in ``graph-editor/src`` /
  ``graph-editor/lib`` outside test fixtures (Stage 0 already pins this
  in ``test_stage0_be_contract_pinning.py``; this file adds the
  topo-pass and parity-service complements).
- ``topo-pass``, ``topoPass``, ``beTopoPass``, ``handle_stats_topo_pass``
  must have no live matches in ``graph-editor/src``,
  ``graph-editor/lib`` (live runtime only — tests + fixtures excluded),
  ``graph-editor/dev-server.py``, and
  ``graph-editor/lib/api_handlers.py``.

Out of scope per §5: ``bayes/`` is the offline Bayes-fitting pipeline;
``bayes/compiler/loo.py:119`` retains ``analytic_be`` as a legacy
source-name fallback for historical graph snapshots. Stage 1 must not
touch it.
"""

import os
import re

GRAPH_EDITOR_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', '..')
)
LIB_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'lib')
SRC_ROOT = os.path.join(GRAPH_EDITOR_ROOT, 'src')
DEV_SERVER_PATH = os.path.join(GRAPH_EDITOR_ROOT, 'dev-server.py')
API_HANDLERS_PATH = os.path.join(LIB_ROOT, 'api_handlers.py')

REMOVED_FILES = (
    os.path.join(SRC_ROOT, 'services', 'beTopoPassService.ts'),
    os.path.join(SRC_ROOT, 'services', 'forecastingParityService.ts'),
    os.path.join(LIB_ROOT, 'runner', 'stats_engine.py'),
)

# Word-boundary token tests so we do not false-match on identifiers
# that happen to share a prefix (e.g. `_analytic_best`).
TOPO_PASS_TOKENS = (
    r'\btopo-pass\b',
    r'\btopoPass\b',
    r'\bbeTopoPass\b',
    r'\bhandle_stats_topo_pass\b',
)


def _walk_source_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if d not in (
                '__pycache__', 'node_modules', '.pytest_cache',
                'tests', '__tests__', 'fixtures',
            )
        ]
        for fname in filenames:
            if not fname.endswith(('.py', '.ts', '.tsx', '.js', '.jsx')):
                continue
            if fname.endswith(('.test.ts', '.test.tsx', '.spec.ts')):
                continue
            yield os.path.join(dirpath, fname)


def test_a1_removed_files_absent():
    """A1: the three removed BE-topo files must not exist."""
    present = [path for path in REMOVED_FILES if os.path.exists(path)]
    assert not present, (
        '§5 Action A1: the following BE-topo surfaces were removed and '
        'must not return:\n  ' + '\n  '.join(present)
    )


def test_a1_topo_pass_tokens_absent_from_live_code():
    """A1: ``topo-pass`` / ``topoPass`` / ``beTopoPass`` /
    ``handle_stats_topo_pass`` must not appear in live graph-editor
    runtime code.
    """
    pattern = re.compile('|'.join(TOPO_PASS_TOKENS))

    offenders = []
    for root in (LIB_ROOT, SRC_ROOT):
        for path in _walk_source_files(root):
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                for line_no, line in enumerate(f, start=1):
                    if pattern.search(line):
                        offenders.append(f'{path}:{line_no}')

    assert not offenders, (
        '§5 Action A1: BE-topo tokens reappeared in live code:\n  '
        + '\n  '.join(offenders[:30])
    )


def test_a1_dev_server_clean():
    """A1: ``dev-server.py`` must not reference any topo-pass token."""
    if not os.path.exists(DEV_SERVER_PATH):
        return
    pattern = re.compile('|'.join(TOPO_PASS_TOKENS))
    with open(DEV_SERVER_PATH, 'r', encoding='utf-8') as f:
        offenders = [
            f'{DEV_SERVER_PATH}:{line_no}'
            for line_no, line in enumerate(f, start=1)
            if pattern.search(line)
        ]
    assert not offenders, (
        '§5 Action A1: dev-server.py must not register any topo-pass '
        'route or symbol:\n  ' + '\n  '.join(offenders)
    )


def test_a1_api_handlers_clean():
    """A1: ``api_handlers.py`` must not register a ``topo-pass`` route
    or define ``handle_stats_topo_pass``.
    """
    if not os.path.exists(API_HANDLERS_PATH):
        return
    pattern = re.compile('|'.join(TOPO_PASS_TOKENS))
    with open(API_HANDLERS_PATH, 'r', encoding='utf-8') as f:
        offenders = [
            f'{API_HANDLERS_PATH}:{line_no}'
            for line_no, line in enumerate(f, start=1)
            if pattern.search(line)
        ]
    assert not offenders, (
        '§5 Action A1: api_handlers.py must not register topo-pass '
        'routes or handlers:\n  ' + '\n  '.join(offenders)
    )


def test_a1_parity_service_absent_from_live_code():
    """A1: ``forecastingParityService`` / ``ForecastingParityService``
    references must not appear in live graph-editor runtime code.
    The parity service was deleted with the BE topo removal.
    """
    pattern = re.compile(r'\bforecastingParityService\b|\bForecastingParityService\b')

    offenders = []
    for root in (LIB_ROOT, SRC_ROOT):
        for path in _walk_source_files(root):
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                for line_no, line in enumerate(f, start=1):
                    if pattern.search(line):
                        offenders.append(f'{path}:{line_no}')

    assert not offenders, (
        '§5 Action A1: parity-service references reappeared in live '
        'code:\n  ' + '\n  '.join(offenders[:30])
    )
