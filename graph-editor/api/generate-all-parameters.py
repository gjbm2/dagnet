"""
Vercel serverless function: Generate MSMDC queries for all parameters.

This endpoint generates queries for:
- Edge base probabilities (edge.p)
- Edge conditional probabilities (edge.conditional_p[])
- Edge costs (cost_gbp, cost_time)
- Case node variants (node.case.variants[])

Path: /api/generate-all-parameters
Method: POST
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
        try:
            # Read request body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8'))
            
            # Extract parameters
            graph_data = data.get('graph')
            param_types = data.get('paramTypes')  # Optional: filter by type
            downstream_of = data.get('downstream_of')  # Optional: incremental updates
            max_checks = data.get('maxChecks', 200)
            literal_weights = data.get('literal_weights')
            preserve_condition = data.get('preserve_condition', True)
            preserve_case_context = data.get('preserveCaseContext', True)
            
            if not graph_data:
                self.send_error_response(400, "Missing 'graph' field")
                return
            
            # Import modules
            from msmdc import generate_all_parameter_queries, generate_queries_by_type
            from graph_types import Graph
            
            # Parse graph
            graph = Graph.model_validate(graph_data)
            
            # Generate all parameters or filter by type/downstream
            if param_types:
                params_by_type = generate_queries_by_type(
                    graph, param_types, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
                )
                all_params = []
                for ptype, params in params_by_type.items():
                    all_params.extend(params)
            else:
                all_params = generate_all_parameter_queries(
                    graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
                )
            
            # Format response
            parameters = []
            stats_by_type = {}
            
            for param in all_params:
                parameters.append({
                    "paramType": param.param_type,
                    "paramId": param.param_id,
                    "edgeKey": param.edge_key,
                    "condition": param.condition,
                    "query": param.query,
                    "stats": param.stats
                })
                
                # Count by type
                if param.param_type not in stats_by_type:
                    stats_by_type[param.param_type] = 0
                stats_by_type[param.param_type] += 1
            
            response = {
                "parameters": parameters,
                "stats": {
                    "total": len(parameters),
                    "byType": stats_by_type
                },
                "success": True
            }
            
            self.send_success_response(response)
            
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

