"""
Test that every Modal web endpoint in bayes/app.py has a corresponding
route in dev-server.py (and vice versa for Bayes routes).

This ensures the local dev server faithfully simulates the Modal backend,
so all functional tests can run against the local backend with confidence
that they cover the same API surface as production.
"""

import re
from pathlib import Path

GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2]
BAYES_APP_PATH = GRAPH_EDITOR_DIR.parent / 'bayes' / 'app.py'
DEV_SERVER_PATH = GRAPH_EDITOR_DIR / 'dev-server.py'


def _extract_modal_endpoints(content: str) -> dict[str, str]:
    """Extract Modal fastapi_endpoint functions: {name: HTTP method}.

    Looks for patterns like:
        @modal.fastapi_endpoint(method="POST")
        def submit(...)
    """
    endpoints = {}
    lines = content.splitlines()
    for i, line in enumerate(lines):
        m = re.search(r'@modal\.fastapi_endpoint\(method=["\'](\w+)["\']\)', line)
        if m:
            method = m.group(1).upper()
            # Next non-decorator, non-blank line should be the def
            for j in range(i + 1, min(i + 5, len(lines))):
                fn_match = re.match(r'\s*(?:async\s+)?def\s+(\w+)\s*\(', lines[j])
                if fn_match:
                    endpoints[fn_match.group(1)] = method
                    break
    return endpoints


def _extract_dev_server_bayes_routes(content: str) -> dict[str, str]:
    """Extract Bayes-related routes from dev-server.py: {route: HTTP method}.

    Only includes /api/bayes/* routes (excludes tunnel management).
    """
    routes = {}
    for m in re.finditer(
        r'@app\.(post|get)\(["\'](/api/bayes/(?:submit|status|cancel|version))["\']',
        content,
    ):
        method = m.group(1).upper()
        route = m.group(2)
        routes[route] = method
    return routes


def test_every_modal_endpoint_has_local_equivalent():
    """Each Modal web endpoint (submit, status, cancel) must have a
    matching /api/bayes/* route in dev-server.py with the same HTTP method."""

    modal_content = BAYES_APP_PATH.read_text()
    dev_content = DEV_SERVER_PATH.read_text()

    modal_endpoints = _extract_modal_endpoints(modal_content)
    dev_routes = _extract_dev_server_bayes_routes(dev_content)

    # Build a lookup from endpoint name to expected dev route
    # Modal endpoint names map to /api/bayes/{name}
    missing = []
    method_mismatches = []

    for name, modal_method in modal_endpoints.items():
        # fit_graph is the worker function, not a web endpoint
        if name == 'fit_graph':
            continue

        expected_route = f'/api/bayes/{name}'
        if expected_route not in dev_routes:
            missing.append(f'{expected_route} ({modal_method}) — Modal endpoint "{name}" has no local route')
        elif dev_routes[expected_route] != modal_method:
            method_mismatches.append(
                f'{expected_route}: Modal={modal_method}, local={dev_routes[expected_route]}'
            )

    errors = []
    if missing:
        errors.append('Missing local routes:\n  ' + '\n  '.join(missing))
    if method_mismatches:
        errors.append('HTTP method mismatches:\n  ' + '\n  '.join(method_mismatches))

    assert not errors, '\n'.join(errors)

    # Print what we verified
    print(f'✓ Modal ↔ local parity: {len(modal_endpoints) - 1} endpoints verified')
    for name, method in sorted(modal_endpoints.items()):
        if name != 'fit_graph':
            print(f'  {method} /api/bayes/{name}')


def test_local_bayes_routes_all_have_modal_counterparts():
    """No orphan local Bayes routes — every /api/bayes/{op} in dev-server.py
    must correspond to a Modal endpoint (excluding tunnel management)."""

    modal_content = BAYES_APP_PATH.read_text()
    dev_content = DEV_SERVER_PATH.read_text()

    modal_endpoints = _extract_modal_endpoints(modal_content)
    modal_names = {name for name in modal_endpoints if name != 'fit_graph'}

    dev_routes = _extract_dev_server_bayes_routes(dev_content)

    orphans = []
    for route in dev_routes:
        # Extract the operation name from /api/bayes/{name}
        op_name = route.rsplit('/', 1)[-1]
        if op_name not in modal_names:
            orphans.append(f'{route} — no matching Modal endpoint "{op_name}"')

    assert not orphans, 'Orphan local routes (no Modal counterpart):\n  ' + '\n  '.join(orphans)
