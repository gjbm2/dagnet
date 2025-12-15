"""
Tests for LAG field extraction in analytics runner.

Verifies that:
1. graph_builder correctly extracts forecast.mean, evidence.mean, latency data
2. runners surface these fields in analysis output
3. visibility_mode is passed through correctly
"""

import pytest
from lib.runner.graph_builder import (
    build_networkx_graph,
    _extract_evidence,
    _extract_forecast,
    _extract_latency,
)
from lib.runner.runners import run_path, run_single_node_entry, run_branch_comparison
from lib.runner.types import ScenarioData


class TestLAGFieldExtraction:
    """Test LAG field extraction from graph data."""

    def test_extract_evidence_with_mean(self):
        """Evidence should include mean (observed rate)."""
        p_param = {
            'mean': 0.72,
            'evidence': {
                'n': 1000,
                'k': 720,
                'mean': 0.68,  # observed rate (may differ from blended mean)
                'window_from': '2025-01-01',
                'window_to': '2025-01-07',
            }
        }
        
        evidence = _extract_evidence(p_param)
        
        assert evidence is not None
        assert evidence['n'] == 1000
        assert evidence['k'] == 720
        assert evidence['mean'] == 0.68
        assert evidence['window_from'] == '2025-01-01'
        assert evidence['window_to'] == '2025-01-07'

    def test_extract_forecast_fields(self):
        """Forecast should include mean, k, stdev."""
        p_param = {
            'mean': 0.72,
            'forecast': {
                'mean': 0.75,  # projected rate from mature cohorts
                'k': 850,      # expected converters
                'stdev': 0.05,
            }
        }
        
        forecast = _extract_forecast(p_param)
        
        assert forecast is not None
        assert forecast['mean'] == 0.75
        assert forecast['k'] == 850
        assert forecast['stdev'] == 0.05

    def test_extract_latency_fields(self):
        """Latency should include completeness, t95, path_t95."""
        p_param = {
            'mean': 0.72,
            'latency': {
                'median_lag_days': 7.5,
                'mean_lag_days': 8.2,
                't95': 21,
                'path_t95': 35,
                'completeness': 0.85,
                'latency_parameter': True,
            }
        }
        
        latency = _extract_latency(p_param)
        
        assert latency is not None
        assert latency['median_lag_days'] == 7.5
        assert latency['mean_lag_days'] == 8.2
        assert latency['t95'] == 21
        assert latency['path_t95'] == 35
        assert latency['completeness'] == 0.85
        assert latency['latency_parameter'] is True

    def test_extract_none_for_missing_fields(self):
        """Extractors should return None for missing data."""
        assert _extract_evidence(None) is None
        assert _extract_evidence({}) is None
        assert _extract_forecast(None) is None
        assert _extract_forecast({}) is None
        assert _extract_latency(None) is None
        assert _extract_latency({}) is None


class TestGraphBuilderLAGFields:
    """Test that graph_builder adds LAG fields to edges."""

    def test_build_graph_with_lag_fields(self):
        """Graph edges should have forecast, evidence, latency attributes."""
        graph_data = {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'success', 'absorbing': True},
            ],
            'edges': [
                {
                    'uuid': 'edge-1',
                    'from': 'node-1',
                    'to': 'node-2',
                    'p': {
                        'mean': 0.72,
                        'forecast': {'mean': 0.75, 'k': 850},
                        'evidence': {'mean': 0.68, 'n': 1000, 'k': 720},
                        'latency': {'completeness': 0.85, 't95': 21},
                        'n': 1200,  # inbound-n
                    }
                }
            ]
        }
        
        G = build_networkx_graph(graph_data)
        
        # Check edge attributes
        edge = G.edges['node-1', 'node-2']
        
        assert edge['p'] == 0.72  # blended mean
        
        # Forecast data
        assert edge['forecast'] is not None
        assert edge['forecast']['mean'] == 0.75
        assert edge['forecast']['k'] == 850
        
        # Evidence data
        assert edge['evidence'] is not None
        assert edge['evidence']['mean'] == 0.68
        assert edge['evidence']['n'] == 1000
        assert edge['evidence']['k'] == 720
        
        # Latency data
        assert edge['latency'] is not None
        assert edge['latency']['completeness'] == 0.85
        assert edge['latency']['t95'] == 21
        
        # Inbound-n
        assert edge['p_n'] == 1200


class TestRunnersLAGFields:
    """Test that runners surface LAG fields in output."""

    @pytest.fixture
    def sample_graph_with_lag(self):
        """Create a simple graph with LAG data for testing."""
        return {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'label': 'Entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'step1', 'label': 'Step 1'},
                {'uuid': 'node-3', 'id': 'success', 'label': 'Success', 'absorbing': True},
            ],
            'edges': [
                {
                    'uuid': 'edge-1',
                    'from': 'node-1',
                    'to': 'node-2',
                    'p': {
                        'mean': 0.8,
                        'forecast': {'mean': 0.82, 'k': 820},
                        'evidence': {'mean': 0.78, 'n': 1000, 'k': 780},
                        'latency': {'completeness': 0.9, 't95': 14},
                        'n': 1000,
                    }
                },
                {
                    'uuid': 'edge-2',
                    'from': 'node-2',
                    'to': 'node-3',
                    'p': {
                        'mean': 0.9,
                        'forecast': {'mean': 0.92, 'k': 736},
                        'evidence': {'mean': 0.88, 'n': 800, 'k': 704},
                        'latency': {'completeness': 0.85, 't95': 21},
                        'n': 800,
                    }
                }
            ]
        }

    def test_run_path_includes_lag_fields(self, sample_graph_with_lag):
        """Path analysis should include forecast_mean, evidence_mean, completeness."""
        G = build_networkx_graph(sample_graph_with_lag)
        
        # Include intermediate node in path to get LAG data at that stage
        result = run_path(G, 'node-1', 'node-3', intermediate_nodes=['node-2'], all_scenarios=None)
        
        # Check data rows have LAG fields
        data = result['data']
        assert len(data) >= 3  # entry, step1, and success stages
        
        # Check second stage (entry → step1) - use UUID since that's how graph is keyed
        stage1_row = next((r for r in data if r['stage'] == 'node-2'), None)
        assert stage1_row is not None, f"No row found with stage='node-2'. Data: {data}"
        assert 'forecast_mean' in stage1_row
        assert stage1_row['forecast_mean'] == 0.82
        assert 'evidence_mean' in stage1_row
        assert stage1_row['evidence_mean'] == 0.78
        assert 'completeness' in stage1_row
        assert stage1_row['completeness'] == 0.9
        
        # Check semantics include new metrics
        metrics = result['semantics']['metrics']
        metric_ids = [m['id'] for m in metrics]
        assert 'forecast_mean' in metric_ids
        assert 'evidence_mean' in metric_ids
        assert 'completeness' in metric_ids

    def test_run_path_includes_visibility_mode(self, sample_graph_with_lag):
        """Path analysis should include visibility_mode per row."""
        scenario = ScenarioData(
            scenario_id='test',
            name='Test Scenario',
            colour='#ff0000',
            visibility_mode='f',  # forecast only
            graph=sample_graph_with_lag,
        )
        
        G = build_networkx_graph(sample_graph_with_lag)
        result = run_path(G, 'node-1', 'node-3', all_scenarios=[scenario])
        
        # Check visibility_mode is in data rows
        data = result['data']
        for row in data:
            assert 'visibility_mode' in row
            assert row['visibility_mode'] == 'f'
        
        # Check visibility_mode is in dimension_values
        scenario_values = result['dimension_values']['scenario_id']
        assert 'test' in scenario_values
        assert scenario_values['test']['visibility_mode'] == 'f'

    def test_run_single_node_entry_includes_visibility_mode(self, sample_graph_with_lag):
        """Single node entry analysis should include visibility_mode."""
        scenario = ScenarioData(
            scenario_id='evidence',
            name='Evidence Only',
            colour='#00ff00',
            visibility_mode='e',
            graph=sample_graph_with_lag,
        )
        
        G = build_networkx_graph(sample_graph_with_lag)
        result = run_single_node_entry(G, 'node-1', all_scenarios=[scenario])
        
        # Check visibility_mode in data rows
        for row in result['data']:
            assert row['visibility_mode'] == 'e'
        
        # Check dimension values
        assert result['dimension_values']['scenario_id']['evidence']['visibility_mode'] == 'e'

    def test_run_branch_comparison_includes_lag_fields(self, sample_graph_with_lag):
        """Branch comparison should include forecast_mean, evidence_mean."""
        # Create graph with branching structure
        branch_graph = {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'label': 'Entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'branch-a', 'label': 'Branch A'},
                {'uuid': 'node-3', 'id': 'branch-b', 'label': 'Branch B'},
                {'uuid': 'node-4', 'id': 'end', 'label': 'End', 'absorbing': True},
            ],
            'edges': [
                {
                    'uuid': 'edge-1',
                    'from': 'node-1',
                    'to': 'node-2',
                    'p': {
                        'mean': 0.6,
                        'forecast': {'mean': 0.65},
                        'evidence': {'mean': 0.55},
                        'latency': {'completeness': 0.8},
                    }
                },
                {
                    'uuid': 'edge-2',
                    'from': 'node-1',
                    'to': 'node-3',
                    'p': {
                        'mean': 0.4,
                        'forecast': {'mean': 0.35},
                        'evidence': {'mean': 0.45},
                        'latency': {'completeness': 0.75},
                    }
                },
                {'uuid': 'edge-3', 'from': 'node-2', 'to': 'node-4', 'p': {'mean': 1.0}},
                {'uuid': 'edge-4', 'from': 'node-3', 'to': 'node-4', 'p': {'mean': 1.0}},
            ]
        }
        
        G = build_networkx_graph(branch_graph)
        result = run_branch_comparison(G, ['node-2', 'node-3'])
        
        # Check LAG fields are present
        data = result['data']
        # Branch uses UUID as key, then translate_uuids_to_ids converts to human ID
        branch_a_row = next((r for r in data if r['branch'] == 'node-2'), None)
        assert branch_a_row is not None, f"No row found with branch='node-2'. Data: {data}"
        assert 'forecast_mean' in branch_a_row
        assert branch_a_row['forecast_mean'] == 0.65
        assert 'evidence_mean' in branch_a_row
        assert branch_a_row['evidence_mean'] == 0.55
        assert 'completeness' in branch_a_row
        assert branch_a_row['completeness'] == 0.8


class TestVisibilityModeDefaults:
    """Test default behaviour when visibility_mode is not specified."""

    def test_default_visibility_mode_is_f_plus_e(self):
        """When visibility_mode is not specified, default to f+e."""
        graph_data = {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'end', 'absorbing': True},
            ],
            'edges': [
                {'uuid': 'edge-1', 'from': 'node-1', 'to': 'node-2', 'p': {'mean': 0.5}}
            ]
        }
        
        G = build_networkx_graph(graph_data)
        result = run_path(G, 'node-1', 'node-2', all_scenarios=None)
        
        # Default scenario should have visibility_mode = f+e
        for row in result['data']:
            assert row['visibility_mode'] == 'f+e'
        
        assert result['dimension_values']['scenario_id']['current']['visibility_mode'] == 'f+e'

    def test_scenario_without_visibility_mode_defaults_to_f_plus_e(self):
        """ScenarioData without visibility_mode should default to f+e."""
        graph_data = {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'end', 'absorbing': True},
            ],
            'edges': [
                {'uuid': 'edge-1', 'from': 'node-1', 'to': 'node-2', 'p': {'mean': 0.5}}
            ]
        }
        
        # Create scenario without visibility_mode
        scenario = ScenarioData(
            scenario_id='test',
            name='Test',
            graph=graph_data,
        )
        
        G = build_networkx_graph(graph_data)
        result = run_path(G, 'node-1', 'node-2', all_scenarios=[scenario])
        
        # Should default to f+e
        for row in result['data']:
            assert row['visibility_mode'] == 'f+e'


class TestInvariantSemantics:
    """Test that field meanings are invariant regardless of visibility mode."""

    def test_forecast_mean_meaning_unchanged_by_mode(self):
        """forecast_mean should always mean the same thing regardless of mode."""
        graph_data = {
            'nodes': [
                {'uuid': 'node-1', 'id': 'entry', 'entry': {'is_start': True}},
                {'uuid': 'node-2', 'id': 'end', 'absorbing': True},
            ],
            'edges': [
                {
                    'uuid': 'edge-1',
                    'from': 'node-1',
                    'to': 'node-2',
                    'p': {
                        'mean': 0.7,
                        'forecast': {'mean': 0.75},
                        'evidence': {'mean': 0.65},
                    }
                }
            ]
        }
        
        G = build_networkx_graph(graph_data)
        
        # Test with different visibility modes
        for mode in ['f+e', 'f', 'e']:
            scenario = ScenarioData(
                scenario_id='test',
                name='Test',
                visibility_mode=mode,
                graph=graph_data,
            )
            
            result = run_path(G, 'node-1', 'node-2', all_scenarios=[scenario])
            
            # forecast_mean should always be 0.75 regardless of mode
            # Stage uses UUID since graph_builder preserves them
            stage_row = next((r for r in result['data'] if r['stage'] == 'node-2'), None)
            assert stage_row is not None, f"No row found for stage='node-2'. Data: {result['data']}"
            assert stage_row.get('forecast_mean') == 0.75
            assert stage_row.get('evidence_mean') == 0.65
            
            # The mode should be recorded but doesn't change the values
            assert stage_row['visibility_mode'] == mode

