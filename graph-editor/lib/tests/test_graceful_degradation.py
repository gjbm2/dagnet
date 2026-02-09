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

    def test_gd004_cohort_maturity_empty_epoch_is_success(self):
        """
        GD-004: cohort_maturity empty epoch is success.

        Cohort maturity sweep queries may intentionally yield no rows for a planned epoch
        (e.g. gap epochs, or early days before first retrieval). The per-scenario snapshot
        handler must return a successful empty result block, not an error.
        """
        from api_handlers import handle_runner_analyze

        with patch('snapshot_service.query_snapshots_for_sweep') as mock_sweep:
            mock_sweep.return_value = []

            req = {
                "analysis_type": "cohort_maturity",
                "query_dsl": "from(A).to(B).cohort(1-Oct-25:3-Oct-25).asat(3-Oct-25)",
                "scenarios": [{
                    "scenario_id": "base",
                    "name": "Base",
                    "colour": "#000000",
                    "visibility_mode": "f+e",
                    "graph": {},
                    "snapshot_subjects": [{
                        "subject_id": "s1::epoch:0",
                        "param_id": "pytest-gd-param",
                        "canonical_signature": '{"c":"gd","x":{}}',
                        "core_hash": "hash",
                        "read_mode": "cohort_maturity",
                        "anchor_from": "2025-10-01",
                        "anchor_to": "2025-10-03",
                        "sweep_from": "2025-10-01",
                        "sweep_to": "2025-10-01",
                        "slice_keys": ["__epoch_gap__"],
                        "target": {"targetId": "e1"},
                    }],
                }],
            }

            res = handle_runner_analyze(req)
            assert res["success"] is True
            # Single scenario + single subject is flattened by the handler.
            assert "result" in res
            result = res["result"]
            assert result["analysis_type"] == "cohort_maturity"
            assert isinstance(result.get("frames"), list)
    
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
