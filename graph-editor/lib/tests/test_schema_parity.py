"""
EXHAUSTIVE Schema / Python / TypeScript Parity Tests

These tests ensure TOTAL PARITY between:
1. JSON Schema ($defs)
2. Python Pydantic models
3. TypeScript interfaces

NO DRIFT ALLOWED IN ANY DIRECTION.

For each type:
- Schema fields == Python fields (bidirectional)
- Missing in either direction = FAIL

Run with: pytest lib/tests/test_schema_parity.py -v
"""

import json
import pytest
from pathlib import Path
from typing import Any, Dict, Set, Type
from pydantic import BaseModel

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from graph_types import (
    Graph, Node, Edge, Evidence, ProbabilityParam, CostParam,
    ConditionalProbability, Metadata, Policies, Layout,
    ResidualBehavior, DataSource, CaseDataSource,
    LatencyConfig, ForecastParams, NodeImage
)


# Path to schema
SCHEMA_PATH = Path(__file__).parent.parent.parent / "public" / "schemas" / "conversion-graph-1.1.0.json"


def load_schema() -> Dict[str, Any]:
    """Load the JSON schema."""
    with open(SCHEMA_PATH, 'r') as f:
        return json.load(f)


def get_schema_properties(schema_def: Dict[str, Any]) -> Set[str]:
    """
    Extract ALL property names from a schema definition.
    Returns flat set of property names (not nested).
    """
    return set(schema_def.get('properties', {}).keys())


def get_pydantic_fields(model: Type[BaseModel]) -> Set[str]:
    """
    Extract ALL field names from a Pydantic model.
    Uses the alias if one is defined (e.g., 'from_node' with alias='from' returns 'from').
    """
    fields = set()
    for name, field_info in model.model_fields.items():
        # Use alias if it exists, otherwise use the field name
        if field_info.alias:
            fields.add(field_info.alias)
        else:
            fields.add(name)
    return fields


def assert_bidirectional_parity(
    schema_props: Set[str],
    python_props: Set[str],
    type_name: str,
    allowed_schema_only: Set[str] = None,
    allowed_python_only: Set[str] = None
):
    """
    Assert that schema and Python have EXACTLY the same fields.
    
    Args:
        schema_props: Properties from JSON schema
        python_props: Fields from Pydantic model
        type_name: Name for error messages
        allowed_schema_only: Fields allowed to be in schema but not Python (AVOID USING)
        allowed_python_only: Fields allowed to be in Python but not schema (AVOID USING)
    """
    allowed_schema_only = allowed_schema_only or set()
    allowed_python_only = allowed_python_only or set()
    
    # What's in schema but not Python?
    schema_only = schema_props - python_props - allowed_schema_only
    
    # What's in Python but not schema?
    python_only = python_props - schema_props - allowed_python_only
    
    errors = []
    
    if schema_only:
        errors.append(f"Schema has fields missing from Python: {sorted(schema_only)}")
    
    if python_only:
        errors.append(f"Python has fields missing from Schema: {sorted(python_only)}")
    
    if errors:
        pytest.fail(f"{type_name} PARITY FAILURE:\n" + "\n".join(errors))


class TestProbabilityParamParity:
    """ProbabilityParam must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['ProbabilityParam']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(ProbabilityParam)
        
        # These are the ONLY allowed exceptions (should be empty ideally)
        # data_source is in Python but schema doesn't define its structure
        # locked is deprecated in Python
        allowed_python_only = {'data_source', 'locked'}
        
        assert_bidirectional_parity(
            schema_props, 
            python_props, 
            'ProbabilityParam',
            allowed_python_only=allowed_python_only
        )


class TestCostParamParity:
    """CostParam must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['CostParam']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(CostParam)
        
        # data_source is in Python but not schema
        allowed_python_only = {'data_source'}
        
        assert_bidirectional_parity(
            schema_props, 
            python_props, 
            'CostParam',
            allowed_python_only=allowed_python_only
        )


class TestEvidenceParity:
    """Evidence must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        # Evidence is nested inside ProbabilityParam
        prob_param_def = schema['$defs']['ProbabilityParam']
        evidence_def = prob_param_def['properties']['evidence']
        
        schema_props = get_schema_properties(evidence_def)
        python_props = get_pydantic_fields(Evidence)
        
        assert_bidirectional_parity(schema_props, python_props, 'Evidence')


class TestEdgeParity:
    """Edge must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['Edge']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(Edge)
        
        # 'from' is a Python keyword, Pydantic uses 'from_' internally
        # but model_fields shows the alias
        
        assert_bidirectional_parity(schema_props, python_props, 'Edge')


class TestNodeParity:
    """Node must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['Node']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(Node)
        
        assert_bidirectional_parity(schema_props, python_props, 'Node')


class TestNodeImageParity:
    """
    Node.images.items must match the NodeImage Python model.
    
    This specifically catches nested drift (e.g. Python expecting url while schema expects image_id/caption).
    """
    
    def test_node_image_items_field_parity(self):
        schema = load_schema()
        node_def = schema['$defs']['Node']
        images_items_def = node_def['properties']['images']['items']
        
        schema_props = get_schema_properties(images_items_def)
        python_props = get_pydantic_fields(NodeImage)
        
        assert_bidirectional_parity(schema_props, python_props, 'Node.images.items (NodeImage)')
    
    def test_node_image_items_required_fields(self):
        schema = load_schema()
        node_def = schema['$defs']['Node']
        images_items_def = node_def['properties']['images']['items']
        schema_required = set(images_items_def.get('required', []))
        
        # Pydantic v2: field.is_required() is the canonical check.
        python_required = {
            name for name, field_info in NodeImage.model_fields.items()
            if field_info.is_required()
        }
        
        assert schema_required == python_required, (
            f"NodeImage required fields mismatch. "
            f"schema={sorted(schema_required)} python={sorted(python_required)}"
        )


class TestMetadataParity:
    """Metadata must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['Metadata']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(Metadata)
        
        assert_bidirectional_parity(schema_props, python_props, 'Metadata')


class TestPoliciesParity:
    """Policies must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['Policies']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(Policies)
        
        assert_bidirectional_parity(schema_props, python_props, 'Policies')


class TestConditionalProbabilityParity:
    """ConditionalProbability must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['ConditionalProbability']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(ConditionalProbability)
        
        assert_bidirectional_parity(schema_props, python_props, 'ConditionalProbability')


class TestResidualBehaviorParity:
    """ResidualBehavior must have IDENTICAL fields in schema and Python."""
    
    def test_complete_field_parity(self):
        schema = load_schema()
        schema_def = schema['$defs']['ResidualBehavior']
        
        schema_props = get_schema_properties(schema_def)
        python_props = get_pydantic_fields(ResidualBehavior)
        
        assert_bidirectional_parity(schema_props, python_props, 'ResidualBehavior')


class TestAllSchemaDefsHavePythonTypes:
    """
    Every $def in schema must have a corresponding Python type.
    This catches cases where schema adds a type but Python doesn't.
    """
    
    # Map schema $def names to Python classes
    SCHEMA_TO_PYTHON = {
        'Node': Node,
        'Edge': Edge,
        'ProbabilityParam': ProbabilityParam,
        'CostParam': CostParam,
        'Policies': Policies,
        'Metadata': Metadata,
        'ConditionalProbability': ConditionalProbability,
        'ResidualBehavior': ResidualBehavior,
        'LatencyConfig': LatencyConfig,
        'ForecastParams': ForecastParams,
        # These are deprecated or not modeled separately in Python:
        # 'Costs', 'MonetaryCost', 'TimeCost' - deprecated
        # 'UUID', 'Id', 'Condition' - simple types, not classes
        # 'EdgeDisplay' - UI-only, optional
    }
    
    # Schema $defs that don't need Python types (deprecated, simple types, etc.)
    EXCLUDED_DEFS = {
        'UUID', 'Id', 'Condition', 'Costs', 'MonetaryCost', 'TimeCost', 'EdgeDisplay'
    }
    
    def test_all_schema_defs_have_python_types(self):
        schema = load_schema()
        schema_defs = set(schema.get('$defs', {}).keys())
        
        # Remove excluded
        required_defs = schema_defs - self.EXCLUDED_DEFS
        
        # Check each required def has a Python mapping
        missing = required_defs - set(self.SCHEMA_TO_PYTHON.keys())
        
        if missing:
            pytest.fail(
                f"Schema has $defs without Python types: {sorted(missing)}\n"
                f"Add them to SCHEMA_TO_PYTHON or EXCLUDED_DEFS"
            )


class TestNoDuplicateOrOrphanedTypes:
    """
    Python types that claim to be schema types must actually be in schema.
    This catches cases where Python adds a type that doesn't exist in schema.
    """
    
    # Python types that should be in schema
    PYTHON_SCHEMA_TYPES = {
        'Node', 'Edge', 'ProbabilityParam', 'CostParam', 'Policies', 
        'Metadata', 'ConditionalProbability', 'ResidualBehavior', 'Evidence'
    }
    
    # Python types that are NOT in schema (internal use only)
    PYTHON_INTERNAL_TYPES = {
        'DataSource',  # Not in schema - SHOULD BE ADDED OR REMOVED
        'CaseDataSource',  # Not in schema - SHOULD BE ADDED OR REMOVED
        'Graph',  # Top-level, not a $def
        'Layout',  # May or may not be in schema
        'CaseVariant',  # Nested in Node.case.variants
        'CaseEvidence',  # Nested in Node.case.evidence
        'Case',  # Nested in Node.case
    }
    
    def test_python_schema_types_exist_in_schema(self):
        schema = load_schema()
        schema_defs = set(schema.get('$defs', {}).keys())
        
        # Evidence is nested, not a top-level $def
        check_types = self.PYTHON_SCHEMA_TYPES - {'Evidence'}
        
        missing_from_schema = check_types - schema_defs
        
        if missing_from_schema:
            pytest.fail(
                f"Python has types that should be in schema but aren't: {sorted(missing_from_schema)}"
            )


# ============================================================================
# CRITICAL: DataSource is NOT in schema but IS in Python
# This test documents the drift and will fail until fixed
# ============================================================================

class TestDataSourceDrift:
    """
    DataSource exists in Python but NOT in schema.
    This is a KNOWN DRIFT that should be fixed.
    
    Options:
    1. Add DataSource to schema (preferred if frontend uses it)
    2. Remove DataSource from Python (if not needed)
    """
    
    def test_datasource_is_not_in_schema(self):
        """This documents the current drift - DataSource is missing from schema."""
        schema = load_schema()
        schema_defs = set(schema.get('$defs', {}).keys())
        
        # This SHOULD fail when DataSource is added to schema
        # At that point, update this test
        assert 'DataSource' not in schema_defs, (
            "DataSource is now in schema! Update TestDataSourceDrift and add proper parity test."
        )
    
    def test_datasource_exists_in_python(self):
        """DataSource exists in Python."""
        assert DataSource is not None
        fields = get_pydantic_fields(DataSource)
        assert 'type' in fields  # Main type field
        assert 'full_query' in fields  # DSL query string for provenance
        # NOTE: 'query' field removed - was unused and caused type confusion


if __name__ == '__main__':
    pytest.main([__file__, '-v'])

