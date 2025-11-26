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
                # If no endpoint param and no original path header, this is an error
                elif not original_path:
                    self.send_error_response(400, "Missing endpoint. Supported: parse-query, generate-all-parameters, stats-enhance, runner-analyze, runner-available-analyses")
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

