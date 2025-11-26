"""
Tests for analysis type adaptor.

Tests the matching logic that maps predicates to analysis types.
"""

import pytest
from lib.runner.adaptor import (
    AnalysisAdaptor,
    AnalysisDefinition,
    match_analysis_type,
)


class TestAnalysisDefinition:
    """Test AnalysisDefinition class."""
    
    def test_basic_creation(self):
        """Create definition from config dict."""
        config = {
            'id': 'test_type',
            'name': 'Test Analysis',
            'description': 'Test description',
            'when': {'node_count': 1},
            'runner': 'test_runner'
        }
        defn = AnalysisDefinition(config)
        
        assert defn.id == 'test_type'
        assert defn.name == 'Test Analysis'
        assert defn.description == 'Test description'
        assert defn.runner == 'test_runner'
        assert defn.when == {'node_count': 1}
    
    def test_missing_description(self):
        """Description defaults to empty string."""
        config = {
            'id': 'test',
            'name': 'Test',
            'when': {},
            'runner': 'runner'
        }
        defn = AnalysisDefinition(config)
        assert defn.description == ''


class TestAnalysisAdaptor:
    """Test AnalysisAdaptor matching logic."""
    
    @pytest.fixture
    def adaptor(self):
        """Get adaptor with default config."""
        return AnalysisAdaptor()
    
    def test_loads_definitions(self, adaptor):
        """Adaptor loads definitions from YAML."""
        assert len(adaptor.definitions) > 0
        assert all(isinstance(d, AnalysisDefinition) for d in adaptor.definitions)
    
    def test_empty_dsl_graph_overview(self, adaptor):
        """Empty DSL (node_count=0) matches graph_overview."""
        predicates = {
            'node_count': 0,
        }
        result = adaptor.match(predicates)
        assert result.id == 'graph_overview'
    
    def test_single_node_from_outcomes(self, adaptor):
        """from(A) matches from_node_outcomes."""
        predicates = {
            'node_count': 1,
            'has_from': True,
            'has_to': False,
        }
        result = adaptor.match(predicates)
        assert result.id == 'from_node_outcomes'
    
    def test_single_node_to_reach(self, adaptor):
        """to(B) matches to_node_reach."""
        predicates = {
            'node_count': 1,
            'has_from': False,
            'has_to': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'to_node_reach'
    
    def test_single_node_visited_path_through(self, adaptor):
        """visited(A) matches path_through."""
        predicates = {
            'node_count': 1,
            'has_from': False,
            'has_to': False,
        }
        result = adaptor.match(predicates)
        assert result.id == 'path_through'
    
    def test_path_between(self, adaptor):
        """from(A).to(B) matches path_between."""
        predicates = {
            'node_count': 2,
            'has_from': True,
            'has_to': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'path_between'
    
    def test_two_absorbing_outcome_comparison(self, adaptor):
        """Two absorbing nodes match outcome_comparison."""
        predicates = {
            'node_count': 2,
            'has_from': False,
            'has_to': False,
            'all_absorbing': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'outcome_comparison'
    
    def test_two_siblings_branch_comparison(self, adaptor):
        """Two sibling nodes match branch_comparison."""
        predicates = {
            'node_count': 2,
            'has_from': False,
            'has_to': False,
            'all_absorbing': False,
            'all_are_siblings': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'branch_comparison'
    
    def test_two_nodes_multi_waypoint(self, adaptor):
        """Two non-sibling non-absorbing nodes match multi_waypoint."""
        predicates = {
            'node_count': 2,
            'has_from': False,
            'has_to': False,
            'all_absorbing': False,
            'all_are_siblings': False,
        }
        result = adaptor.match(predicates)
        assert result.id == 'multi_waypoint'
    
    def test_three_absorbing_multi_outcome(self, adaptor):
        """Three absorbing nodes match multi_outcome_comparison."""
        predicates = {
            'node_count': 3,
            'has_from': False,
            'has_to': False,
            'all_absorbing': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'multi_outcome_comparison'
    
    def test_three_siblings_multi_branch(self, adaptor):
        """Three sibling nodes match multi_branch_comparison."""
        predicates = {
            'node_count': 3,
            'has_from': False,
            'has_to': False,
            'all_absorbing': False,
            'all_are_siblings': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'multi_branch_comparison'
    
    def test_constrained_path(self, adaptor):
        """from(A).to(B).visited(C) matches constrained_path."""
        predicates = {
            'node_count': 3,
            'has_from': True,
            'has_to': True,
        }
        result = adaptor.match(predicates)
        assert result.id == 'constrained_path'
    
    def test_branches_from_start(self, adaptor):
        """from(A).visitedAny(B,C) matches branches_from_start."""
        predicates = {
            'has_from': True,
            'has_to': False,
            'visited_any_count': 1,
        }
        result = adaptor.match(predicates)
        assert result.id == 'branches_from_start'
    
    def test_fallback(self, adaptor):
        """Unmatched predicates fall back to general_selection."""
        predicates = {
            'node_count': 5,
            'all_absorbing': False,
            'all_are_siblings': False,
            'has_from': False,
            'has_to': False,
        }
        result = adaptor.match(predicates)
        assert result.id == 'general_selection'


class TestMatchingLogic:
    """Test the internal matching logic."""
    
    @pytest.fixture
    def adaptor(self):
        return AnalysisAdaptor()
    
    def test_exact_match(self, adaptor):
        """Exact value matching works."""
        assert adaptor._matches({'x': 5}, {'x': 5}) == True
        assert adaptor._matches({'x': 5}, {'x': 6}) == False
    
    def test_gte_match(self, adaptor):
        """Greater-than-or-equal matching works."""
        assert adaptor._matches({'x': 5}, {'x': {'gte': 3}}) == True
        assert adaptor._matches({'x': 5}, {'x': {'gte': 5}}) == True
        assert adaptor._matches({'x': 5}, {'x': {'gte': 6}}) == False
    
    def test_lte_match(self, adaptor):
        """Less-than-or-equal matching works."""
        assert adaptor._matches({'x': 5}, {'x': {'lte': 7}}) == True
        assert adaptor._matches({'x': 5}, {'x': {'lte': 5}}) == True
        assert adaptor._matches({'x': 5}, {'x': {'lte': 4}}) == False
    
    def test_range_match(self, adaptor):
        """Combined gte/lte range matching works."""
        condition = {'x': {'gte': 3, 'lte': 7}}
        assert adaptor._matches({'x': 5}, condition) == True
        assert adaptor._matches({'x': 3}, condition) == True
        assert adaptor._matches({'x': 7}, condition) == True
        assert adaptor._matches({'x': 2}, condition) == False
        assert adaptor._matches({'x': 8}, condition) == False
    
    def test_list_match(self, adaptor):
        """Value-in-list matching works."""
        assert adaptor._matches({'x': 2}, {'x': [1, 2, 3]}) == True
        assert adaptor._matches({'x': 5}, {'x': [1, 2, 3]}) == False
    
    def test_boolean_match(self, adaptor):
        """Boolean matching works."""
        assert adaptor._matches({'flag': True}, {'flag': True}) == True
        assert adaptor._matches({'flag': False}, {'flag': True}) == False
    
    def test_empty_conditions(self, adaptor):
        """Empty conditions always match (fallback)."""
        assert adaptor._matches({'anything': 'value'}, {}) == True
        assert adaptor._matches({}, {}) == True
    
    def test_missing_predicate(self, adaptor):
        """Missing predicate fails match."""
        assert adaptor._matches({}, {'required': True}) == False
        assert adaptor._matches({'other': 5}, {'required': True}) == False
    
    def test_multiple_conditions(self, adaptor):
        """All conditions must be satisfied (AND)."""
        conditions = {'a': True, 'b': 5, 'c': {'gte': 3}}
        
        # All satisfied
        assert adaptor._matches({'a': True, 'b': 5, 'c': 4}, conditions) == True
        
        # One fails
        assert adaptor._matches({'a': False, 'b': 5, 'c': 4}, conditions) == False
        assert adaptor._matches({'a': True, 'b': 6, 'c': 4}, conditions) == False
        assert adaptor._matches({'a': True, 'b': 5, 'c': 2}, conditions) == False


class TestGetAllMatching:
    """Test get_all_matching method."""
    
    def test_returns_all_matches(self):
        """get_all_matching returns all matching definitions."""
        adaptor = AnalysisAdaptor()
        
        # Predicates that match fallback
        predicates = {
            'node_count': 10,
            'all_absorbing': False,
            'has_from': False,
            'has_to': False,
        }
        
        matches = adaptor.get_all_matching(predicates)
        
        # Should at least match the fallback
        assert len(matches) >= 1
        assert any(m.id == 'general_selection' for m in matches)


class TestConvenienceFunctions:
    """Test module-level convenience functions."""
    
    def test_match_analysis_type(self):
        """match_analysis_type convenience function works."""
        predicates = {
            'node_count': 1,
            'has_from': True,
            'has_to': False,
        }
        result = match_analysis_type(predicates)
        assert result.id == 'from_node_outcomes'


class TestListAnalysisTypes:
    """Test listing available analysis types."""
    
    def test_list_types(self):
        """list_analysis_types returns all types."""
        adaptor = AnalysisAdaptor()
        types = adaptor.list_analysis_types()
        
        assert len(types) > 0
        assert all('id' in t for t in types)
        assert all('name' in t for t in types)
        assert all('runner' in t for t in types)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
