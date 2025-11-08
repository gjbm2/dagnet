"""
Tests for Query DSL parser.

Tests both:
1. Direct Python parsing
2. HTTP roundtrip (TS -> Python -> TS simulation)
"""

import pytest
from lib.query_dsl import parse_query, validate_query, QueryParseError


class TestDSLParsing:
    """Test direct DSL string parsing."""
    
    def test_simple_query(self):
        """Parse simple from-to query."""
        query = "from(homepage).to(checkout)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "homepage"
        assert parsed.to_node == "checkout"
        assert parsed.exclude == []
        assert parsed.visited == []
    
    def test_query_with_visited(self):
        """Parse query with visited constraint."""
        query = "from(product).to(checkout).visited(promo)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "product"
        assert parsed.to_node == "checkout"
        assert parsed.visited == ["promo"]
    
    def test_query_with_exclude(self):
        """Parse query with exclude constraint."""
        query = "from(homepage).to(checkout).exclude(back-button)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "homepage"
        assert parsed.to_node == "checkout"
        assert parsed.exclude == ["back-button"]
    
    def test_query_with_multiple_excludes(self):
        """Parse query with multiple excludes."""
        query = "from(a).to(b).exclude(c,d,e)"
        parsed = parse_query(query)
        
        assert parsed.exclude == ["c", "d", "e"]
    
    def test_query_with_case(self):
        """Parse query with case filter."""
        query = "from(a).to(b).case(test-1:treatment)"
        parsed = parse_query(query)
        
        assert len(parsed.cases) == 1
        assert parsed.cases[0].key == "test-1"
        assert parsed.cases[0].value == "treatment"
    
    def test_complex_query(self):
        """Parse complex query with multiple constraints."""
        query = "from(start).to(end).visited(checkpoint).exclude(detour-a,detour-b)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "start"
        assert parsed.to_node == "end"
        assert parsed.visited == ["checkpoint"]
        assert parsed.exclude == ["detour-a", "detour-b"]
    
    def test_reconstruct_query(self):
        """Reconstructed query should match original (modulo order)."""
        original = "from(a).to(b).visited(c).exclude(d)"
        parsed = parse_query(original)
        reconstructed = parsed.raw
        
        # Parse both to compare structure
        original_parsed = parse_query(original)
        reconstructed_parsed = parse_query(reconstructed)
        
        assert original_parsed.from_node == reconstructed_parsed.from_node
        assert original_parsed.to_node == reconstructed_parsed.to_node
        assert set(original_parsed.visited) == set(reconstructed_parsed.visited)
        assert set(original_parsed.exclude) == set(reconstructed_parsed.exclude)


class TestDSLValidation:
    """Test query validation."""
    
    def test_valid_query(self):
        """Valid query should pass validation."""
        is_valid, error = validate_query("from(a).to(b)")
        assert is_valid
        assert error is None
    
    def test_missing_from(self):
        """Query without from() should fail."""
        is_valid, error = validate_query("to(b)")
        assert not is_valid
        assert "from" in error.lower()
    
    def test_missing_to(self):
        """Query without to() should fail."""
        is_valid, error = validate_query("from(a)")
        assert not is_valid
        assert "to" in error.lower()
    
    def test_validate_with_node_list(self):
        """Validation with node list should check references."""
        available_nodes = ["a", "b", "c"]
        
        is_valid, error = validate_query(
            "from(a).to(b).visited(c)",
            available_nodes=available_nodes
        )
        assert is_valid
    
    def test_invalid_node_reference(self):
        """Query referencing non-existent node should fail."""
        available_nodes = ["a", "b"]
        
        is_valid, error = validate_query(
            "from(a).to(b).visited(nonexistent)",
            available_nodes=available_nodes
        )
        assert not is_valid
        assert "nonexistent" in error
    
    def test_cannot_exclude_source(self):
        """Cannot exclude the source node."""
        available_nodes = ["a", "b"]
        
        is_valid, error = validate_query(
            "from(a).to(b).exclude(a)",
            available_nodes=available_nodes
        )
        assert not is_valid
        assert "source" in error.lower() or "from" in error.lower()
    
    def test_cannot_exclude_target(self):
        """Cannot exclude the target node."""
        available_nodes = ["a", "b"]
        
        is_valid, error = validate_query(
            "from(a).to(b).exclude(b)",
            available_nodes=available_nodes
        )
        assert not is_valid
        assert "target" in error.lower() or "to" in error.lower()


class TestDSLEdgeCases:
    """Test edge cases and error handling."""
    
    def test_empty_string(self):
        """Empty string should raise error."""
        with pytest.raises(QueryParseError):
            parse_query("")
    
    def test_none_value(self):
        """None should raise error."""
        with pytest.raises(QueryParseError):
            parse_query(None)
    
    def test_duplicate_visited_nodes(self):
        """Duplicate visited nodes should be deduplicated."""
        query = "from(a).to(b).visited(c).visited(c)"
        parsed = parse_query(query)
        
        # Should only have one 'c'
        assert parsed.visited.count("c") == 1
    
    def test_node_ids_with_hyphens(self):
        """Node IDs with hyphens should work."""
        query = "from(home-page).to(check-out)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "home-page"
        assert parsed.to_node == "check-out"
    
    def test_node_ids_with_underscores(self):
        """Node IDs can contain underscores."""
        query = "from(checkout_page).to(order_complete).visited(promo_viewed).exclude(cart_abandoned)"
        parsed = parse_query(query)
        assert parsed.from_node == "checkout_page"
        assert parsed.to_node == "order_complete"
        assert "promo_viewed" in parsed.visited
        assert "cart_abandoned" in parsed.exclude
    
    def test_node_ids_with_mixed_separators(self):
        """Node IDs can contain both underscores and hyphens."""
        query = "from(page_1-mobile).to(page_2-desktop)"
        parsed = parse_query(query)
        assert parsed.from_node == "page_1-mobile"
        assert parsed.to_node == "page_2-desktop"


if __name__ == "__main__":
    # Run with: python -m pytest tests/test_query_dsl.py -v
    pytest.main([__file__, "-v"])

