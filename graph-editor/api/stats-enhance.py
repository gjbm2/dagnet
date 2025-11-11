"""
Vercel serverless function: Enhance raw aggregation with statistical methods.

Supports:
- MCMC (Markov Chain Monte Carlo)
- Bayesian-complex
- Trend-aware
- Robust

Path: /api/stats-enhance
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
            raw_data = data.get('raw')
            method = data.get('method')
            
            if not raw_data:
                self.send_error_response(400, "Missing 'raw' field")
                return
            
            if not method:
                self.send_error_response(400, "Missing 'method' field")
                return
            
            # Import and enhance
            from stats_enhancement import enhance_aggregation
            
            enhanced = enhance_aggregation(raw_data, method)
            
            response = {
                **enhanced,
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

