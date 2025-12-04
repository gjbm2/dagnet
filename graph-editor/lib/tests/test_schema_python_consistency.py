"""
Schema / Python Types Consistency Tests

Validates that Python Pydantic models align with their corresponding JSON schemas.
Tests both directions:
1. Schema properties exist in Python types (via Pydantic model validation)
2. Python type properties are allowed by schema (via inspecting JSON schema)

This prevents drift between schemas and types when fields are added/removed/renamed.

Mirrors the TypeScript test: src/services/__tests__/schemaTypesConsistency.test.ts
"""

import json
import pytest
from pathlib import Path
from typing import Any, Dict, Set

# Import Python types from graph_types
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from graph_types import (
    Graph, Node, Edge, Evidence, ProbabilityParam, CostParam,
    ConditionalProbability, Metadata, Policies
)

# Path to schema files
PUBLIC_DIR = Path(__file__).parent.parent.parent / "public"
SCHEMA_DIR = PUBLIC_DIR / "schemas"


def load_schema(schema_path: str) -> Dict[str, Any]:
    """Load and parse a JSON schema file."""
    full_path = PUBLIC_DIR / schema_path
    if not full_path.exists():
        raise FileNotFoundError(f"Schema file not found: {full_path}")
    
    with open(full_path, 'r') as f:
        return json.load(f)


def get_schema_property_names(schema: Dict[str, Any], prefix: str = '') -> Set[str]:
    """Extract all property names from a JSON schema (including nested)."""
    props = set()
    
    properties = schema.get('properties', {})
    for name, prop_def in properties.items():
        full_name = f"{prefix}.{name}" if prefix else name
        props.add(full_name)
        
        # Recurse into nested objects
        if prop_def.get('type') == 'object' and 'properties' in prop_def:
            props.update(get_schema_property_names(prop_def, full_name))
    
    return props


def get_pydantic_field_names(model_class) -> Set[str]:
    """Extract field names from a Pydantic model."""
    return set(model_class.model_fields.keys())


class TestGraphSchemaConsistency:
    """Test Graph schema matches Python Graph model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        return load_schema('schemas/conversion-graph-1.1.0.json')
    
    def test_top_level_properties_match(self, schema):
        """Schema top-level properties should exist in Python Graph model."""
        schema_props = set(schema.get('properties', {}).keys())
        python_props = get_pydantic_field_names(Graph)
        
        # Schema properties that must be in Python
        expected = {'nodes', 'edges', 'policies', 'metadata'}
        assert expected.issubset(schema_props), f"Schema missing: {expected - schema_props}"
        assert expected.issubset(python_props), f"Python missing: {expected - python_props}"
    
    def test_minimal_graph_validates(self, schema):
        """Minimal Graph should pass Pydantic validation."""
        minimal_graph = {
            'nodes': [{
                'uuid': '123e4567-e89b-12d3-a456-426614174000',
                'id': 'start',
                'label': 'Start Node'
            }],
            'edges': [],
            'policies': {
                'default_outcome': 'success'
            },
            'metadata': {
                'version': '1.0.0',
                'created_at': '1-Dec-25'  # UK format
            }
        }
        
        # Should parse with Pydantic
        graph = Graph(**minimal_graph)
        assert graph.nodes[0].id == 'start'
        assert graph.metadata.created_at == '1-Dec-25'
    
    def test_graph_with_uk_dates_validates(self, schema):
        """Graph with UK format dates should pass Pydantic validation."""
        graph_with_dates = {
            'nodes': [{
                'uuid': '123e4567-e89b-12d3-a456-426614174000',
                'id': 'checkout',
                'label': 'Checkout'
            }, {
                'uuid': '223e4567-e89b-12d3-a456-426614174001',
                'id': 'purchase',
                'label': 'Purchase'
            }],
            'edges': [{
                'uuid': '323e4567-e89b-12d3-a456-426614174002',
                'from': 'checkout',
                'to': 'purchase',
                'p': {
                    'mean': 0.5,
                    'evidence': {
                        'n': 100,
                        'k': 50,
                        'window_from': '24-Nov-25',  # UK format
                        'window_to': '30-Nov-25',    # UK format
                        'retrieved_at': '1-Dec-25',  # UK format
                        'source': 'amplitude-prod'  # Connection name
                    }
                }
            }],
            'policies': {'default_outcome': 'success'},
            'metadata': {
                'version': '1.0.0',
                'created_at': '1-Dec-25',
                'updated_at': '2-Dec-25'
            }
        }
        
        # Should parse with Pydantic
        graph = Graph(**graph_with_dates)
        assert graph.edges[0].p.evidence.window_from == '24-Nov-25'
        assert graph.metadata.updated_at == '2-Dec-25'
    
    def test_graph_with_iso_dates_validates(self, schema):
        """Graph with ISO format dates should also pass validation."""
        graph_with_iso = {
            'nodes': [{
                'uuid': '123e4567-e89b-12d3-a456-426614174000',
                'id': 'start',
                'label': 'Start'
            }],
            'edges': [],
            'policies': {'default_outcome': 'success'},
            'metadata': {
                'version': '1.0.0',
                'created_at': '2025-12-01T00:00:00Z',  # ISO format
                'updated_at': '2025-12-02T12:00:00Z'
            }
        }
        
        # Should parse with Pydantic
        graph = Graph(**graph_with_iso)
        assert '2025-12-01' in graph.metadata.created_at


class TestEdgeSchemaConsistency:
    """Test Edge schema matches Python Edge model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        return full_schema.get('$defs', {}).get('Edge', {})
    
    def test_handle_values_match(self, schema):
        """fromHandle and toHandle enums should match between schema and Python."""
        from_handle_schema = set(schema.get('properties', {}).get('fromHandle', {}).get('enum', []))
        to_handle_schema = set(schema.get('properties', {}).get('toHandle', {}).get('enum', []))
        
        # Both should include the -out variants
        expected_handles = {'left', 'right', 'top', 'bottom', 'left-out', 'right-out', 'top-out', 'bottom-out'}
        
        assert from_handle_schema == expected_handles, f"fromHandle missing: {expected_handles - from_handle_schema}"
        assert to_handle_schema == expected_handles, f"toHandle missing: {expected_handles - to_handle_schema}"
        
        # Python model should accept these values
        edge_data = {
            'uuid': '123e4567-e89b-12d3-a456-426614174000',
            'from': 'node-a',
            'to': 'node-b',
            'fromHandle': 'left-out',
            'toHandle': 'left-out',
            'p': {'mean': 0.5}
        }
        edge = Edge(**edge_data)
        assert edge.fromHandle == 'left-out'
        assert edge.toHandle == 'left-out'
    
    def test_query_fields_exist(self, schema):
        """Edge should have query and n_query fields in both schema and Python."""
        schema_props = set(schema.get('properties', {}).keys())
        python_props = get_pydantic_field_names(Edge)
        
        query_fields = {'query', 'query_overridden', 'n_query', 'n_query_overridden'}
        
        assert query_fields.issubset(schema_props), f"Schema missing: {query_fields - schema_props}"
        assert query_fields.issubset(python_props), f"Python missing: {query_fields - python_props}"
        
        # Python model should accept these
        edge = Edge(
            uuid='123e4567-e89b-12d3-a456-426614174000',
            **{'from': 'node-a'},  # Use dict unpacking for 'from' keyword
            to='node-b',
            query='from(node-a).to(node-b)',
            query_overridden=True,
            n_query='from(node-a).to(node-c)',
            n_query_overridden=False,
            p=ProbabilityParam(mean=0.5)
        )
        assert edge.query == 'from(node-a).to(node-b)'
        assert edge.n_query == 'from(node-a).to(node-c)'


class TestEvidenceSchemaConsistency:
    """Test Evidence schema matches Python Evidence model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        prob_param = full_schema.get('$defs', {}).get('ProbabilityParam', {})
        return prob_param.get('properties', {}).get('evidence', {})
    
    def test_date_fields_accept_uk_format(self, schema):
        """Evidence date fields should accept UK format strings."""
        # Schema should NOT have format: date-time (which requires ISO)
        props = schema.get('properties', {})
        
        for date_field in ['window_from', 'window_to', 'retrieved_at']:
            field_def = props.get(date_field, {})
            # Should be type: string without format: date-time
            assert field_def.get('type') == 'string', f"{date_field} should be string"
            assert 'format' not in field_def or field_def.get('format') != 'date-time', \
                f"{date_field} should not require date-time format"
        
        # Python model should accept UK format
        evidence = Evidence(
            n=100,
            k=50,
            window_from='24-Nov-25',
            window_to='30-Nov-25',
            retrieved_at='1-Dec-25',
            source='amplitude'
        )
        assert evidence.window_from == '24-Nov-25'
        assert evidence.window_to == '30-Nov-25'
        assert evidence.retrieved_at == '1-Dec-25'


class TestMetadataSchemaConsistency:
    """Test Metadata schema matches Python Metadata model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        return full_schema.get('$defs', {}).get('Metadata', {})
    
    def test_date_fields_accept_uk_format(self, schema):
        """Metadata date fields should accept UK format strings."""
        props = schema.get('properties', {})
        
        for date_field in ['created_at', 'updated_at']:
            field_def = props.get(date_field, {})
            # Should be type: string without format: date-time
            assert field_def.get('type') == 'string', f"{date_field} should be string"
            assert 'format' not in field_def or field_def.get('format') != 'date-time', \
                f"{date_field} should not require date-time format"
        
        # Python model should accept UK format
        metadata = Metadata(
            version='1.0.0',
            created_at='1-Dec-25',
            updated_at='2-Dec-25'
        )
        assert metadata.created_at == '1-Dec-25'
        assert metadata.updated_at == '2-Dec-25'


class TestProbabilityParamConsistency:
    """Test ProbabilityParam schema matches Python model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        return full_schema.get('$defs', {}).get('ProbabilityParam', {})
    
    def test_override_fields_exist(self, schema):
        """ProbabilityParam should have override fields in both schema and Python."""
        schema_props = set(schema.get('properties', {}).keys())
        python_props = get_pydantic_field_names(ProbabilityParam)
        
        override_fields = {'mean_overridden', 'stdev_overridden', 'distribution_overridden'}
        
        assert override_fields.issubset(schema_props), f"Schema missing: {override_fields - schema_props}"
        assert override_fields.issubset(python_props), f"Python missing: {override_fields - python_props}"


class TestCostParamConsistency:
    """Test CostParam schema matches Python model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        return full_schema.get('$defs', {}).get('CostParam', {})
    
    def test_override_fields_exist(self, schema):
        """CostParam should have override fields in both schema and Python."""
        schema_props = set(schema.get('properties', {}).keys())
        python_props = get_pydantic_field_names(CostParam)
        
        override_fields = {'mean_overridden', 'stdev_overridden', 'distribution_overridden'}
        
        assert override_fields.issubset(schema_props), f"Schema missing: {override_fields - schema_props}"
        # CostParam may not have all override fields yet - check what's there
        for field in override_fields:
            if field in schema_props:
                assert field in python_props, f"Python missing: {field}"


class TestConditionalProbabilityConsistency:
    """Test ConditionalProbability schema matches Python model."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        full_schema = load_schema('schemas/conversion-graph-1.1.0.json')
        return full_schema.get('$defs', {}).get('ConditionalProbability', {})
    
    def test_query_override_field_exists(self, schema):
        """ConditionalProbability should have query_overridden field."""
        schema_props = set(schema.get('properties', {}).keys())
        python_props = get_pydantic_field_names(ConditionalProbability)
        
        assert 'query_overridden' in schema_props, "Schema missing query_overridden"
        assert 'query_overridden' in python_props, "Python missing query_overridden"


class TestSchema110Features:
    """Test schema 1.1.0 new features are reflected in Python types."""
    
    @pytest.fixture
    def schema(self) -> Dict[str, Any]:
        return load_schema('schemas/conversion-graph-1.1.0.json')
    
    def test_node_type_field_exists(self, schema):
        """Node should have type field with normal/case enum."""
        node_def = schema.get('$defs', {}).get('Node', {})
        type_field = node_def.get('properties', {}).get('type', {})
        
        assert type_field.get('type') == 'string'
        assert 'normal' in type_field.get('enum', [])
        assert 'case' in type_field.get('enum', [])
        
        # Python model should have type field
        python_props = get_pydantic_field_names(Node)
        assert 'type' in python_props, "Python Node missing type field"
    
    def test_metadata_name_field_exists(self, schema):
        """Metadata should have name field."""
        metadata_def = schema.get('$defs', {}).get('Metadata', {})
        name_field = metadata_def.get('properties', {}).get('name', {})
        
        assert name_field.get('type') == 'string'
        
        # Python model should have name field
        python_props = get_pydantic_field_names(Metadata)
        assert 'name' in python_props, "Python Metadata missing name field"
    
    def test_case_id_description_explains_fallback(self, schema):
        """Edge.case_id description should explain case.id vs uuid fallback."""
        edge_def = schema.get('$defs', {}).get('Edge', {})
        case_id_field = edge_def.get('properties', {}).get('case_id', {})
        description = case_id_field.get('description', '')
        
        # Should mention both case.id and uuid
        assert 'case.id' in description.lower() or 'node.case.id' in description.lower()
        assert 'uuid' in description.lower()
    
    def test_no_internal_flags_in_schema(self, schema):
        """Internal flags like _noHistory should NOT be in schema."""
        prob_param_def = schema.get('$defs', {}).get('ProbabilityParam', {})
        props = prob_param_def.get('properties', {})
        
        # _noHistory is an internal UI flag that should never be persisted
        assert '_noHistory' not in props, "_noHistory should not be in schema"


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
