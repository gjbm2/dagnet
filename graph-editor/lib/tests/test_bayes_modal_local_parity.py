"""
Test that every Modal web endpoint in bayes/app.py has a corresponding
route in dev-server.py (and vice versa for Bayes routes), AND that every
URL the FE hardcodes or fetches has a matching Python route.

Three layers of parity:
  1. Modal endpoint ↔ local dev-server route (existing)
  2. FE hardcoded URLs ↔ local dev-server route (new)
  3. FE config-fetched URLs ↔ local dev-server config response (new)
"""

import re
from pathlib import Path

GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2]
BAYES_APP_PATH = GRAPH_EDITOR_DIR.parent / 'bayes' / 'app.py'
DEV_SERVER_PATH = GRAPH_EDITOR_DIR / 'dev-server.py'
SRC_DIR = GRAPH_EDITOR_DIR / 'src'


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


# ---------------------------------------------------------------------------
# Layer 2: FE hardcoded URLs ↔ dev-server routes
# ---------------------------------------------------------------------------

def _extract_fe_bayes_paths() -> dict[str, str]:
    """Extract every /api/bayes/* URL path from FE TypeScript sources.

    Returns {path: source_file:line} for diagnostics.
    """
    paths: dict[str, str] = {}
    url_re = re.compile(r"""['"`]https?://localhost:\d+(/api/bayes[^'"`\s?]*)""")

    for ts_file in SRC_DIR.rglob('*.ts'):
        for i, line in enumerate(ts_file.read_text().splitlines(), 1):
            for m in url_re.finditer(line):
                path = m.group(1).rstrip('/')
                rel = ts_file.relative_to(GRAPH_EDITOR_DIR)
                paths[path] = f'{rel}:{i}'

    for tsx_file in SRC_DIR.rglob('*.tsx'):
        for i, line in enumerate(tsx_file.read_text().splitlines(), 1):
            for m in url_re.finditer(line):
                path = m.group(1).rstrip('/')
                rel = tsx_file.relative_to(GRAPH_EDITOR_DIR)
                paths[path] = f'{rel}:{i}'

    return paths


def _extract_all_dev_server_bayes_routes(content: str) -> set[str]:
    """Extract ALL /api/bayes/* routes from dev-server.py (including tunnel)."""
    routes = set()
    for m in re.finditer(
        r'@app\.(?:post|get)\(["\'](/api/bayes/[^"\']+)["\']\)', content,
    ):
        routes.add(m.group(1).rstrip('/'))
    return routes


def test_fe_hardcoded_urls_match_dev_server_routes():
    """Every /api/bayes/* URL in FE TypeScript must have a route in dev-server.py.

    This catches the bug where FE calls a path that the Python server
    doesn't serve — silent 404 in local dev, confusing failures in prod.
    """
    dev_content = DEV_SERVER_PATH.read_text()
    dev_routes = _extract_all_dev_server_bayes_routes(dev_content)

    fe_paths = _extract_fe_bayes_paths()

    # /api/bayes-webhook is served by Vite middleware (TS), not dev-server.py
    fe_bayes_paths = {
        p: src for p, src in fe_paths.items()
        if p.startswith('/api/bayes/') and '/bayes-webhook' not in p
    }

    missing = []
    for path, source in sorted(fe_bayes_paths.items()):
        if path not in dev_routes:
            missing.append(f'{path}  (referenced in {source})')

    assert not missing, (
        'FE references Bayes paths with no matching dev-server route:\n  '
        + '\n  '.join(missing)
    )

    print(f'✓ FE ↔ dev-server parity: {len(fe_bayes_paths)} FE paths verified')
    for p in sorted(fe_bayes_paths):
        print(f'  {p}')


# ---------------------------------------------------------------------------
# Layer 3: dev-server /api/bayes/config response URLs ↔ its own routes
# ---------------------------------------------------------------------------

def test_config_endpoint_urls_match_dev_server_routes():
    """The URLs returned by /api/bayes/config must correspond to actual routes.

    The config endpoint returns modal_submit_url, modal_status_url, etc.
    In local mode these point back at the dev server itself — the paths
    must match registered routes.
    """
    dev_content = DEV_SERVER_PATH.read_text()
    dev_routes = _extract_all_dev_server_bayes_routes(dev_content)

    # Extract URL strings from the config endpoint's return value
    config_url_re = re.compile(
        r"""['"]https?://localhost:\d+(/api/bayes/[^'"]+)['"]"""
    )
    config_paths = set()
    in_config = False
    for line in dev_content.splitlines():
        if '/api/bayes/config' in line and '@app' in line:
            in_config = True
        if in_config:
            for m in config_url_re.finditer(line):
                config_paths.add(m.group(1).rstrip('/'))
            if 'return' in line and in_config and config_paths:
                break

    # /api/bayes-webhook is Vite middleware, not a dev-server route
    config_bayes_paths = {
        p for p in config_paths
        if p.startswith('/api/bayes/') and '/bayes-webhook' not in p
    }

    missing = []
    for path in sorted(config_bayes_paths):
        if path not in dev_routes:
            missing.append(path)

    assert not missing, (
        'Config endpoint returns URLs with no matching dev-server route:\n  '
        + '\n  '.join(missing)
    )

    print(f'✓ Config ↔ dev-server parity: {len(config_bayes_paths)} config URLs verified')
    for p in sorted(config_bayes_paths):
        print(f'  {p}')
