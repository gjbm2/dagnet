"""
Unified Vercel Python API handler - routes to different endpoints based on path.

This consolidates all Python endpoints into a single function to avoid
repeated dependency installation per function.

Routes:
- /api/parse-query -> parse DSL query
- /api/generate-all-parameters -> generate_all_parameter_queries
- /api/stats-enhance -> enhance_aggregation
- /api/runner/analyze -> run analytics
- /api/runner/available-analyses -> get available analysis types
- /api/compile-exclude -> compile excludes() to minus/plus form
- /api/snapshots/append -> shadow-write snapshot data to DB
- /api/snapshots/health -> DB health check
"""
from http.server import BaseHTTPRequestHandler
import json
import sys
import os

# Add lib/ to Python path (lib is now in graph-editor/, one level up from graph-editor/api)
current_dir = os.path.dirname(os.path.abspath(__file__))
graph_editor_dir = os.path.dirname(current_dir)  # graph-editor/
lib_path = os.path.join(graph_editor_dir, 'lib')
sys.path.insert(0, lib_path)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Route GET requests based on path (health checks, etc.)."""
        try:
            path = self.path.split('?')[0]

            # Check for original path header (Vercel may or may not set this)
            original_path = self.headers.get('x-vercel-original-path') or self.headers.get('x-original-path')
            if original_path:
                path = original_path.split('?')[0]

            # Support rewrites to /api/python-api with endpoint query param
            if path == '/api/python-api':
                from urllib.parse import urlparse, parse_qs
                parsed = urlparse(self.path)
                query_params = parse_qs(parsed.query)
                endpoint = query_params.get('endpoint', [None])[0]
                if endpoint == 'snapshots-health':
                    path = '/api/snapshots/health'
                else:
                    # For now, GET is only used for lightweight health checks.
                    self.send_error_response(400, "Missing/unsupported endpoint for GET. Supported: snapshots-health")
                    return

            if path == '/api/snapshots/health':
                # Match the contract described in docs and used by the frontend.
                # Note: handler logic lives in lib/api_handlers.py
                self.handle_snapshots_health({})
                return

            self.send_error_response(404, f"Unknown endpoint: {path}")
        except Exception as e:
            self.send_error_response(500, str(e))

    def do_POST(self):
        """Route POST requests based on path."""
        try:
            # Read request body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8'))
            
            # Route based on path
            # Vercel rewrites change the destination but we need to detect original path
            # Check for original path in headers first, then fall back to self.path
            # If path is /api/python-api, check for endpoint in query params or header
            path = self.path.split('?')[0]
            
            # Check for original path header (Vercel may or may not set this)
            original_path = self.headers.get('x-vercel-original-path') or self.headers.get('x-original-path')
            if original_path:
                path = original_path.split('?')[0]
            
            # If we're at /api/python-api, check query params for endpoint
            if path == '/api/python-api':
                from urllib.parse import urlparse, parse_qs
                parsed = urlparse(self.path)
                query_params = parse_qs(parsed.query)
                endpoint = query_params.get('endpoint', [None])[0]
                if endpoint == 'parse-query':
                    path = '/api/parse-query'
                elif endpoint == 'generate-all-parameters':
                    path = '/api/generate-all-parameters'
                elif endpoint == 'stats-enhance':
                    path = '/api/stats-enhance'
                elif endpoint == 'runner-analyze':
                    path = '/api/runner/analyze'
                elif endpoint == 'runner-available-analyses':
                    path = '/api/runner/available-analyses'
                elif endpoint == 'compile-exclude':
                    path = '/api/compile-exclude'
                elif endpoint == 'snapshots-append':
                    path = '/api/snapshots/append'
                elif endpoint == 'snapshots-health':
                    path = '/api/snapshots/health'
                elif endpoint == 'snapshots-inventory':
                    path = '/api/snapshots/inventory'
                elif endpoint == 'snapshots-batch-retrieval-days':
                    path = '/api/snapshots/batch-retrieval-days'
                elif endpoint == 'snapshots-batch-anchor-coverage':
                    path = '/api/snapshots/batch-anchor-coverage'
                elif endpoint == 'snapshots-retrievals':
                    path = '/api/snapshots/retrievals'
                elif endpoint == 'snapshots-delete':
                    path = '/api/snapshots/delete'
                elif endpoint == 'snapshots-query-full':
                    path = '/api/snapshots/query-full'
                elif endpoint == 'snapshots-query-virtual':
                    path = '/api/snapshots/query-virtual'
                elif endpoint == 'sigs-list':
                    path = '/api/sigs/list'
                elif endpoint == 'sigs-get':
                    path = '/api/sigs/get'
                elif endpoint == 'lag-recompute-models':
                    path = '/api/lag/recompute-models'
                # If no endpoint param and no original path header, this is an error
                elif not original_path:
                    self.send_error_response(400, "Missing endpoint. Supported: parse-query, generate-all-parameters, stats-enhance, runner-analyze, runner-available-analyses, compile-exclude, snapshots-append, snapshots-health, snapshots-inventory, snapshots-batch-retrieval-days, snapshots-batch-anchor-coverage, snapshots-retrievals, snapshots-delete, snapshots-query-full, snapshots-query-virtual, sigs-list, sigs-get, lag-recompute-models")
                    return
            
            if path == '/api/parse-query':
                self.handle_parse_query(data)
            elif path == '/api/generate-all-parameters':
                self.handle_generate_all_parameters(data)
            elif path == '/api/stats-enhance':
                self.handle_stats_enhance(data)
            elif path == '/api/runner/analyze':
                self.handle_runner_analyze(data)
            elif path == '/api/runner/available-analyses':
                self.handle_runner_available_analyses(data)
            elif path == '/api/compile-exclude':
                self.handle_compile_exclude(data)
            elif path == '/api/snapshots/append':
                self.handle_snapshots_append(data)
            elif path == '/api/snapshots/health':
                self.handle_snapshots_health(data)
            elif path == '/api/snapshots/inventory':
                self.handle_snapshots_inventory(data)
            elif path == '/api/snapshots/batch-retrieval-days':
                self.handle_snapshots_batch_retrieval_days(data)
            elif path == '/api/snapshots/batch-anchor-coverage':
                self.handle_snapshots_batch_anchor_coverage(data)
            elif path == '/api/snapshots/retrievals':
                self.handle_snapshots_retrievals(data)
            elif path == '/api/snapshots/delete':
                self.handle_snapshots_delete(data)
            elif path == '/api/snapshots/query-full':
                self.handle_snapshots_query_full(data)
            elif path == '/api/snapshots/query-virtual':
                self.handle_snapshots_query_virtual(data)
            elif path == '/api/sigs/list':
                self.handle_sigs_list(data)
            elif path == '/api/sigs/get':
                self.handle_sigs_get(data)
            elif path == '/api/lag/recompute-models':
                self.handle_lag_recompute_models(data)
            elif path == '/api/lag-recompute-models':
                # Back-compat alias for older route naming (hyphen, no /lag prefix).
                self.handle_lag_recompute_models(data)
            else:
                self.send_error_response(404, f"Unknown endpoint: {path}")
                
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_parse_query(self, data):
        """Handle parse-query endpoint."""
        try:
            from api_handlers import handle_parse_query as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_generate_all_parameters(self, data):
        """Handle generate-all-parameters endpoint."""
        try:
            from api_handlers import handle_generate_all_parameters as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_stats_enhance(self, data):
        """Handle stats-enhance endpoint."""
        try:
            from api_handlers import handle_stats_enhance as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_runner_analyze(self, data):
        """Handle runner/analyze endpoint."""
        try:
            from api_handlers import handle_runner_analyze as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_runner_available_analyses(self, data):
        """Handle runner/available-analyses endpoint."""
        try:
            from api_handlers import handle_runner_available_analyses as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_compile_exclude(self, data):
        """Handle compile-exclude endpoint - compiles excludes() to minus/plus form."""
        try:
            from api_handlers import handle_compile_exclude as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_append(self, data):
        """Handle snapshots/append endpoint - shadow-write to snapshot DB."""
        try:
            from api_handlers import handle_snapshots_append as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_health(self, data):
        """Handle snapshots/health endpoint - DB connectivity check."""
        try:
            from api_handlers import handle_snapshots_health as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_inventory(self, data):
        """Handle snapshots/inventory endpoint - batch inventory query."""
        try:
            from api_handlers import handle_snapshots_inventory as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_snapshots_batch_retrieval_days(self, data):
        """Handle snapshots/batch-retrieval-days endpoint."""
        try:
            from api_handlers import handle_snapshots_batch_retrieval_days as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_snapshots_batch_anchor_coverage(self, data):
        """Handle snapshots/batch-anchor-coverage endpoint - Retrieve All DB preflight."""
        try:
            from api_handlers import handle_snapshots_batch_anchor_coverage as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_snapshots_retrievals(self, data):
        """Handle snapshots/retrievals endpoint - distinct retrieval timestamps."""
        try:
            from api_handlers import handle_snapshots_retrievals as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_delete(self, data):
        """Handle snapshots/delete endpoint - delete snapshots for a param."""
        try:
            from api_handlers import handle_snapshots_delete as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_query_full(self, data):
        """Handle snapshots/query-full endpoint - query with filters."""
        try:
            from api_handlers import handle_snapshots_query_full as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def handle_snapshots_query_virtual(self, data):
        """Handle snapshots/query-virtual endpoint - virtual snapshot (asat)."""
        try:
            from api_handlers import handle_snapshots_query_virtual as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_sigs_list(self, data):
        """Handle sigs/list endpoint - list signature registry rows."""
        try:
            from api_handlers import handle_sigs_list as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_sigs_get(self, data):
        """Handle sigs/get endpoint - get a single signature registry row."""
        try:
            from api_handlers import handle_sigs_get as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))

    # REMOVED: handle_sigs_links_list, handle_sigs_links_create,
    # handle_sigs_links_deactivate, handle_sigs_resolve
    # Equivalence is now FE-owned via hash-mappings.json.

    def handle_lag_recompute_models(self, data):
        """Handle lag/recompute-models endpoint - fit lag models from DB evidence."""
        try:
            from api_handlers import handle_lag_recompute_models as handler_func
            response = handler_func(data)
            self.send_success_response(response)
        except ValueError as e:
            self.send_error_response(400, str(e))
        except Exception as e:
            self.send_error_response(500, str(e))
    
    def send_success_response(self, data):
        """Send successful JSON response."""
        response_json = json.dumps(data)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(response_json.encode('utf-8'))
    
    def send_error_response(self, status_code, message):
        """Send error JSON response."""
        error_response = {
            "error": message,
            "detail": message,
            "success": False
        }
        response_json = json.dumps(error_response)
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(response_json.encode('utf-8'))
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

