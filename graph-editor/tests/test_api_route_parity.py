"""
Test that dev-server.py and python-api.py have the same routes registered.

This prevents the common bug of adding a route to dev-server but forgetting
to add it to the production Vercel API.
"""

import re
import json
from pathlib import Path

# Get paths relative to this test file (tests/ is at graph-editor/tests/)
TESTS_DIR = Path(__file__).parent
GRAPH_EDITOR_DIR = TESTS_DIR.parent
LIB_DIR = GRAPH_EDITOR_DIR / 'lib'
DEV_SERVER_PATH = GRAPH_EDITOR_DIR / 'dev-server.py'
PYTHON_API_PATH = GRAPH_EDITOR_DIR / 'api' / 'python-api.py'
VERCEL_CONFIG_PATH = GRAPH_EDITOR_DIR / 'vercel.json'


def extract_vercel_rewrite_sources(content: str) -> set:
    """
    Extract rewrite sources from graph-editor/vercel.json.

    Important: this MUST be valid JSON (no comments). If it isn't, this test fails.
    """
    cfg = json.loads(content)
    rewrites = cfg.get('rewrites') or []
    sources = set()
    for r in rewrites:
        src = r.get('source')
        if isinstance(src, str):
            sources.add(src.rstrip('/'))
    return sources


def extract_dev_server_routes(content: str) -> set:
    """Extract @app.post and @app.get routes from dev-server.py"""
    routes = set()
    # Match @app.post("/api/...") and @app.get("/api/...") patterns
    for match in re.finditer(r'@app\.(?:post|get)\(["\']([^"\']+)["\']\)', content):
        route = match.group(1)
        # Normalize: remove trailing slash
        routes.add(route.rstrip('/'))
    return routes


def extract_python_api_routes(content: str) -> set:
    """Extract routes from python-api.py handler routing"""
    routes = set()
    # Match patterns like: path == '/api/...'
    for match in re.finditer(r"path == ['\"]([^'\"]+)['\"]", content):
        route = match.group(1)
        routes.add(route.rstrip('/'))
    # Also match endpoint query param mappings
    for match in re.finditer(r"endpoint == ['\"]([^'\"]+)['\"]", content):
        endpoint = match.group(1)
        # Convert endpoint name to route
        if endpoint == 'runner-analyze':
            routes.add('/api/runner/analyze')
        elif endpoint == 'runner-available-analyses':
            routes.add('/api/runner/available-analyses')
        elif endpoint == 'snapshots-append':
            routes.add('/api/snapshots/append')
        elif endpoint == 'snapshots-health':
            routes.add('/api/snapshots/health')
        elif endpoint == 'snapshots-inventory':
            routes.add('/api/snapshots/inventory')
        elif endpoint == 'snapshots-delete':
            routes.add('/api/snapshots/delete')
        elif endpoint == 'snapshots-query-full':
            routes.add('/api/snapshots/query-full')
        else:
            routes.add(f'/api/{endpoint}')
    return routes


def test_route_parity():
    """Verify dev-server and python-api have the same routes."""
    # Read both files
    dev_server_content = DEV_SERVER_PATH.read_text()
    python_api_content = PYTHON_API_PATH.read_text()
    
    # Extract routes
    dev_routes = extract_dev_server_routes(dev_server_content)
    prod_routes = extract_python_api_routes(python_api_content)
    
    # Filter to only /api/ routes (ignore static file serving, etc.)
    dev_api_routes = {r for r in dev_routes if r.startswith('/api/')}
    prod_api_routes = {r for r in prod_routes if r.startswith('/api/')}
    
    # Exclude routes that are intentionally dev-only or prod-only
    # /api/python-api is the unified endpoint in prod, not a real route
    prod_api_routes.discard('/api/python-api')
    
    # These routes are intentionally dev-only (legacy/debugging endpoints)
    DEV_ONLY_ROUTES = {
        '/api/python-api',      # Unified endpoint routing in dev
        '/api/query-graph',     # Legacy debugging endpoint
        '/api/generate-query',  # Legacy single-query generation
        '/api/generate-all-queries',  # Legacy bulk query generation
        '/api/snapshots/query',       # Test-only: query snapshots for verification
        '/api/snapshots/delete-test', # Test-only: cleanup test data (pytest-* prefix only)
    }
    dev_api_routes -= DEV_ONLY_ROUTES
    
    # Find mismatches
    dev_only = dev_api_routes - prod_api_routes
    prod_only = prod_api_routes - dev_api_routes
    
    errors = []
    if dev_only:
        errors.append(f"Routes in dev-server.py but NOT in python-api.py: {sorted(dev_only)}")
    if prod_only:
        errors.append(f"Routes in python-api.py but NOT in dev-server.py: {sorted(prod_only)}")
    
    if errors:
        error_msg = "\n".join(errors)
        error_msg += "\n\nTo fix: Add missing routes to the appropriate file."
        raise AssertionError(error_msg)
    
    # Success - print what we validated
    print(f"✓ Route parity verified: {len(dev_api_routes)} routes match")
    print(f"  Routes: {sorted(dev_api_routes)}")


def test_vercel_rewrites_cover_prod_routes():
    """
    Verify that every prod API route (as modelled by python-api.py) is reachable
    via a rewrite rule in graph-editor/vercel.json.

    This catches the recurring failure mode:
    - route exists in dev-server.py and python-api.py
    - but Vercel does not rewrite /api/... -> /api/python-api, so prod 404s
    """
    vercel_content = VERCEL_CONFIG_PATH.read_text()
    rewrite_sources = extract_vercel_rewrite_sources(vercel_content)

    python_api_content = PYTHON_API_PATH.read_text()
    prod_routes = extract_python_api_routes(python_api_content)

    # Only consider public /api/* routes (exclude the unified internal handler).
    prod_api_routes = {r for r in prod_routes if r.startswith('/api/')}
    prod_api_routes.discard('/api/python-api')

    # Vercel rewrites define which public sources are routed to the unified handler.
    missing = sorted(prod_api_routes - rewrite_sources)
    if missing:
        raise AssertionError(
            "Missing Vercel rewrites for prod API routes:\n"
            + "\n".join(f"- {r}" for r in missing)
            + "\n\nTo fix: add rewrite entries in graph-editor/vercel.json."
        )


def test_snapshot_health_supports_get_in_prod_handler():
    """
    The frontend calls GET /api/snapshots/health. Ensure python-api.py supports it.
    This is a method-level parity check that route name parity alone cannot catch.
    """
    python_api_content = PYTHON_API_PATH.read_text()

    # Light-weight check: do_GET exists, and it has an explicit handler for the health path.
    if 'def do_GET' not in python_api_content:
        raise AssertionError("python-api.py is missing do_GET; GET /api/snapshots/health will 404 in prod")
    if "/api/snapshots/health" not in python_api_content:
        raise AssertionError("python-api.py does not reference /api/snapshots/health; GET health is likely not routed")


def test_api_handlers_imported():
    """Verify all handler functions are imported from api_handlers.py"""
    python_api_content = PYTHON_API_PATH.read_text()
    api_handlers_content = (LIB_DIR / 'api_handlers.py').read_text()
    
    # Find all handle_* functions defined in api_handlers.py
    defined_handlers = set(re.findall(r'^def (handle_\w+)\(', api_handlers_content, re.MULTILINE))
    
    # Find all handle_* functions imported in python-api.py
    imported_handlers = set(re.findall(r'from api_handlers import (handle_\w+)', python_api_content))
    
    # Check that all handlers used in python-api.py are defined
    missing = imported_handlers - defined_handlers
    if missing:
        raise AssertionError(f"Handlers imported but not defined in api_handlers.py: {missing}")
    
    print(f"✓ All {len(imported_handlers)} imported handlers are defined in api_handlers.py")


if __name__ == '__main__':
    test_route_parity()
    test_api_handlers_imported()
    print("\n✓ All API route parity tests passed!")

