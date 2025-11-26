"""
Tests for Query DSL parser.

Tests both:
1. Direct Python parsing
2. HTTP roundtrip (TS -> Python -> TS simulation)
3. Analytics-specific parsing (optional from/to)
"""

import pytest
from lib.query_dsl import parse_query, parse_query_strict, validate_query, QueryParseError


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
    
    def test_missing_from_optional(self):
        """Query without from() is valid by default (analytics mode)."""
        is_valid, error = validate_query("to(b)")
        assert is_valid
        assert error is None
    
    def test_missing_to_optional(self):
        """Query without to() is valid by default (analytics mode)."""
        is_valid, error = validate_query("from(a)")
        assert is_valid
        assert error is None
    
    def test_missing_from_strict(self):
        """Query without from() should fail when endpoints required."""
        is_valid, error = validate_query("to(b)", require_endpoints=True)
        assert not is_valid
        assert "from" in error.lower()
    
    def test_missing_to_strict(self):
        """Query without to() should fail when endpoints required."""
        is_valid, error = validate_query("from(a)", require_endpoints=True)
        assert not is_valid
        assert "to" in error.lower()
    
    def test_constraints_only_valid(self):
        """Constraints-only query is valid for analytics."""
        is_valid, error = validate_query("visited(x).visited(y)")
        assert is_valid
        assert error is None
    
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
    
    def test_visited_any_single_call(self):
        """visitedAny groups parse and reconstruct."""
        query = "from(a).to(b).visitedAny(x,y,z)"
        parsed = parse_query(query)
        assert parsed.visited_any == [["x","y","z"]]
        assert "visitedAny(x,y,z)" in parsed.raw
    
    def test_mixed_visited_and_visited_any(self):
        """Both visited (AND) and visitedAny (OR) appear."""
        query = "from(a).to(b).visited(p).visitedAny(x,y)"
        parsed = parse_query(query)
        assert parsed.visited == ["p"]
        assert parsed.visited_any == [["x","y"]]
        assert "visited(p)" in parsed.raw
        assert "visitedAny(x,y)" in parsed.raw


class TestAnalyticsQueries:
    """Test analytics-specific parsing (optional from/to)."""
    
    def test_constraints_only(self):
        """Parse query with only visited constraints (no from/to)."""
        query = "visited(a).visited(b).visited(c)"
        parsed = parse_query(query)
        
        assert parsed.from_node is None
        assert parsed.to_node is None
        assert parsed.visited == ["a", "b", "c"]
        assert not parsed.has_path_endpoints
    
    def test_visited_any_only(self):
        """Parse query with only visitedAny (no from/to)."""
        query = "visitedAny(branch-a,branch-b,branch-c)"
        parsed = parse_query(query)
        
        assert parsed.from_node is None
        assert parsed.to_node is None
        assert parsed.visited_any == [["branch-a", "branch-b", "branch-c"]]
    
    def test_from_only(self):
        """Parse query with from but no to."""
        query = "from(start).visitedAny(a,b)"
        parsed = parse_query(query)
        
        assert parsed.from_node == "start"
        assert parsed.to_node is None
        assert parsed.visited_any == [["a", "b"]]
    
    def test_to_only(self):
        """Parse query with to but no from."""
        query = "visited(x).visited(y).to(end)"
        parsed = parse_query(query)
        
        assert parsed.from_node is None
        assert parsed.to_node == "end"
        assert parsed.visited == ["x", "y"]
    
    def test_has_path_endpoints_true(self):
        """has_path_endpoints returns True when both from and to present."""
        query = "from(a).to(b)"
        parsed = parse_query(query)
        assert parsed.has_path_endpoints
    
    def test_has_path_endpoints_false(self):
        """has_path_endpoints returns False when either from or to missing."""
        assert not parse_query("from(a)").has_path_endpoints
        assert not parse_query("to(b)").has_path_endpoints
        assert not parse_query("visited(x)").has_path_endpoints
    
    def test_all_constraint_nodes(self):
        """all_constraint_nodes returns all referenced constraint nodes."""
        query = "from(a).to(b).visited(c,d).exclude(e).visitedAny(f,g)"
        parsed = parse_query(query)
        
        nodes = parsed.all_constraint_nodes
        assert "c" in nodes
        assert "d" in nodes
        assert "e" in nodes
        assert "f" in nodes
        assert "g" in nodes
        # from/to are NOT constraint nodes
        assert "a" not in nodes
        assert "b" not in nodes
    
    def test_raw_reconstruction_no_from(self):
        """Raw reconstruction works without from."""
        query = "visited(x).to(end)"
        parsed = parse_query(query)
        raw = parsed.raw
        
        assert "from(" not in raw
        assert "to(end)" in raw
        assert "visited(x)" in raw
    
    def test_raw_reconstruction_no_to(self):
        """Raw reconstruction works without to."""
        query = "from(start).visited(x)"
        parsed = parse_query(query)
        raw = parsed.raw
        
        assert "from(start)" in raw
        assert "to(" not in raw
        assert "visited(x)" in raw
    
    def test_parse_query_strict_requires_from(self):
        """parse_query_strict raises on missing from."""
        with pytest.raises(QueryParseError) as exc:
            parse_query_strict("to(b)")
        assert "from" in str(exc.value).lower()
    
    def test_parse_query_strict_requires_to(self):
        """parse_query_strict raises on missing to."""
        with pytest.raises(QueryParseError) as exc:
            parse_query_strict("from(a)")
        assert "to" in str(exc.value).lower()
    
    def test_parse_query_strict_accepts_full(self):
        """parse_query_strict accepts full from/to query."""
        parsed = parse_query_strict("from(a).to(b).visited(c)")
        assert parsed.from_node == "a"
        assert parsed.to_node == "b"
        assert parsed.visited == ["c"]


if __name__ == "__main__":
    # Run with: python -m pytest tests/test_query_dsl.py -v
    pytest.main([__file__, "-v"])

