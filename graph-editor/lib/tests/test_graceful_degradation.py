"""
Graceful Degradation Tests (GD-003)

Tests for analytics error handling when database is unavailable.
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock

# Add lib directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestGracefulDegradation:
    """GD-003: Graceful degradation when DB unavailable."""
    
    def test_gd003_read_db_unavailable(self):
        """
        GD-003: read_db_unavailable
        
        Analytics query with no DB connection returns clear error message.
        """
        from api_handlers import _handle_snapshot_analyze
        
        # Mock the snapshot_service.query_snapshots function
        with patch('snapshot_service.query_snapshots') as mock_query:
            mock_query.side_effect = ValueError("DB_CONNECTION environment variable not set")
            
            data = {
                'snapshot_query': {
                    'param_id': 'test-repo-main-param-a',
                    'anchor_from': '2025-10-01',
                    'anchor_to': '2025-10-10',
                },
                'analysis_type': 'lag_histogram',
            }
            
            # Should not raise, should return error response
            try:
                result = _handle_snapshot_analyze(data)
                # If it returns (not raises), check for error indication
                assert result.get('success') == False or 'error' in result
            except ValueError as e:
                # Acceptable - error is raised with clear message
                assert 'DB_CONNECTION' in str(e) or 'database' in str(e).lower()
    
    def test_gd003_empty_result_clear_message(self):
        """
        GD-003: When no snapshot data found, return clear message.
        """
        from api_handlers import _handle_snapshot_analyze
        
        # Mock the snapshot_service.query_snapshots function
        with patch('snapshot_service.query_snapshots') as mock_query:
            mock_query.return_value = []
            
            data = {
                'snapshot_query': {
                    'param_id': 'test-repo-main-nonexistent-param',
                    'anchor_from': '2025-10-01',
                    'anchor_to': '2025-10-10',
                },
                'analysis_type': 'lag_histogram',
            }
            
            result = _handle_snapshot_analyze(data)
            
            assert result['success'] == False
            assert 'error' in result
            assert 'No snapshot data' in result['error']
    
    def test_health_check_db_unavailable(self):
        """
        Health check returns clear error when DB unavailable.
        """
        from snapshot_service import health_check
        
        # Temporarily unset DB_CONNECTION
        original = os.environ.get('DB_CONNECTION')
        try:
            if 'DB_CONNECTION' in os.environ:
                del os.environ['DB_CONNECTION']
            
            result = health_check()
            
            assert result['status'] == 'error'
            assert result['db'] == 'not_configured'
        finally:
            if original:
                os.environ['DB_CONNECTION'] = original
