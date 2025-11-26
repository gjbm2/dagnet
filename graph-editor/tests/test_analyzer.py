"""
Tests for main analyzer.
"""

import pytest
from lib.runner.analyzer import analyze, analyze_scenario, get_available_analyses
from lib.runner.types import AnalysisRequest, ScenarioData


def build_test_graph_data():
    """Test graph data in DagNet format."""
    return {
        'nodes': [
            {'uuid': 'start', 'id': 'start', 'entry': {'is_start': True}},
            {'uuid': 'a', 'id': 'a'},
            {'uuid': 'b1', 'id': 'b1'},
            {'uuid': 'b2', 'id': 'b2'},
            {'uuid': 'end1', 'id': 'end1', 'absorbing': True},
            {'uuid': 'end2', 'id': 'end2', 'absorbing': True},
        ],
        'edges': [
            {'uuid': 'e1', 'from': 'start', 'to': 'a', 'p': {'mean': 1.0}},
            {'uuid': 'e2', 'from': 'a', 'to': 'b1', 'p': {'mean': 0.6}},
            {'uuid': 'e3', 'from': 'a', 'to': 'b2', 'p': {'mean': 0.4}},
            {'uuid': 'e4', 'from': 'b1', 'to': 'end1', 'p': {'mean': 1.0}},
            {'uuid': 'e5', 'from': 'b2', 'to': 'end2', 'p': {'mean': 1.0}},
        ],
    }


class TestAnalyze:
    """Test main analyze function."""
    
    def test_single_scenario(self):
        """Analyze single scenario with DSL."""
        request = AnalysisRequest(
            scenarios=[
                ScenarioData(
                    scenario_id='base',
                    graph=build_test_graph_data(),
                )
            ],
            query_dsl='from(start)',
        )
        
        response = analyze(request)
        
        assert response.success == True
        assert response.result is not None
        assert response.result.analysis_type is not None
    
    def test_with_dsl_query(self):
        """Analyze with DSL query."""
        request = AnalysisRequest(
            scenarios=[
                ScenarioData(
                    scenario_id='base',
                    graph=build_test_graph_data(),
                )
            ],
            query_dsl='from(start).to(end1)',
        )
        
        response = analyze(request)
        
        assert response.success == True
        assert response.query_dsl == 'from(start).to(end1)'
    
    def test_error_handling(self):
        """Handle errors gracefully."""
        request = AnalysisRequest(
            scenarios=[
                ScenarioData(
                    scenario_id='base',
                    graph={'invalid': 'data'},  # Invalid graph
                )
            ],
            query_dsl='visited(nonexistent)',
        )
        
        response = analyze(request)
        
        # Should still return a response, not crash
        assert response is not None


class TestAnalyzeScenario:
    """Test scenario analysis with DSL patterns."""
    
    def test_from_node_outcomes(self):
        """from(A) -> from_node_outcomes."""
        result = analyze_scenario(
            graph_data=build_test_graph_data(),
            query_dsl='from(start)',
        )
        
        assert result.analysis_type == 'from_node_outcomes'
    
    def test_to_node_reach(self):
        """to(B) -> to_node_reach."""
        result = analyze_scenario(
            graph_data=build_test_graph_data(),
            query_dsl='to(end1)',
        )
        
        assert result.analysis_type == 'to_node_reach'
    
    def test_path_between(self):
        """from(A).to(B) -> path_between with new declarative schema."""
        result = analyze_scenario(
            graph_data=build_test_graph_data(),
            query_dsl='from(start).to(end1)',
        )
        
        assert result.analysis_type == 'path_between'
        # New schema: data is array of rows, check final stage has probability
        assert len(result.data) >= 2
        # Stage now uses node IDs, not indices
        final_row = [r for r in result.data if r['stage'] == 'end1'][0]
        assert 'probability' in final_row
    
    def test_path_through(self):
        """visited(A) -> path_through."""
        result = analyze_scenario(
            graph_data=build_test_graph_data(),
            query_dsl='visited(a)',  # 'a' is a middle node in test graph
        )
        
        assert result.analysis_type == 'path_through'


class TestGetAvailableAnalyses:
    """Test DSL string -> analysis type matching."""
    
    def test_empty_dsl_graph_overview(self):
        """Empty DSL -> graph_overview."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(graph_data=graph_data, query_dsl='')
        assert available[0]['id'] == 'graph_overview'
    
    def test_from_only_outcomes(self):
        """from(A) -> from_node_outcomes."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(graph_data=graph_data, query_dsl='from(start)')
        assert available[0]['id'] == 'from_node_outcomes'
    
    def test_to_only_reach(self):
        """to(B) -> to_node_reach."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(graph_data=graph_data, query_dsl='to(end1)')
        assert available[0]['id'] == 'to_node_reach'
    
    def test_visited_only_path_through(self):
        """visited(A) -> path_through."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(graph_data=graph_data, query_dsl='visited(a)')
        assert available[0]['id'] == 'path_through'
        # Should also have general_selection as fallback
        assert len(available) >= 2
        assert any(a['id'] == 'general_selection' for a in available)
    
    def test_from_to_path_between(self):
        """from(A).to(B) -> path_between."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(graph_data=graph_data, query_dsl='from(start).to(end1)')
        assert available[0]['id'] == 'path_between'
    
    def test_from_to_visited_constrained_path(self):
        """from(A).to(B).visited(C) -> constrained_path."""
        graph_data = build_test_graph_data()
        available = get_available_analyses(
            graph_data=graph_data,
            query_dsl='from(start).to(end1).visited(a)'
        )
        assert available[0]['id'] == 'constrained_path'


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

