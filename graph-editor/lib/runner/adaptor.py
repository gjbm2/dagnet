"""
Analysis Type Adaptor

Matches selection predicates to analysis type definitions.

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from pathlib import Path
from typing import Any, Optional
import yaml


class AnalysisDefinition:
    """Represents an analysis type definition."""
    
    def __init__(self, config: dict):
        self.id = config['id']
        self.name = config['name']
        self.description = config.get('description', '')
        self.when = config.get('when', {})
        self.runner = config['runner']
    
    def __repr__(self):
        return f"AnalysisDefinition(id={self.id!r}, name={self.name!r})"


class AnalysisAdaptor:
    """
    Matches selection predicates to analysis types.
    
    Loads analysis definitions from YAML config and provides
    matching logic based on predicate conditions.
    """
    
    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize adaptor with analysis type definitions.
        
        Args:
            config_path: Path to analysis_types.yaml. If None, uses default.
        """
        if config_path is None:
            config_path = Path(__file__).parent / 'analysis_types.yaml'
        
        with open(config_path) as f:
            config = yaml.safe_load(f)
        
        self.definitions = [
            AnalysisDefinition(d) for d in config['analyses']
        ]
    
    def match(self, predicates: dict) -> AnalysisDefinition:
        """
        Find the first matching analysis definition for given predicates.
        
        Args:
            predicates: Dict of selection predicates
        
        Returns:
            Matching AnalysisDefinition
        
        Raises:
            ValueError: If no matching definition found (shouldn't happen with fallback)
        """
        for defn in self.definitions:
            if self._matches(predicates, defn.when):
                return defn
        
        # Should never reach here if definitions include a fallback
        # But handle gracefully
        return AnalysisDefinition({
            'id': 'unknown',
            'name': 'Unknown Selection',
            'description': 'No matching analysis type found',
            'runner': 'general_stats_runner'
        })
    
    def get_all_matching(self, predicates: dict) -> list[AnalysisDefinition]:
        """
        Get all analysis definitions that match the predicates.
        
        Useful for showing available analysis types to user.
        
        Args:
            predicates: Dict of selection predicates
        
        Returns:
            List of matching AnalysisDefinitions (in priority order)
        """
        return [
            defn for defn in self.definitions
            if self._matches(predicates, defn.when)
        ]
    
    def _matches(self, predicates: dict, conditions: dict) -> bool:
        """
        Check if predicates satisfy all conditions.
        
        Args:
            predicates: Actual predicate values
            conditions: Required conditions from definition
        
        Returns:
            True if all conditions are satisfied
        """
        # Empty conditions = always match (fallback)
        if not conditions:
            return True
        
        for key, expected in conditions.items():
            actual = predicates.get(key)
            
            # Handle None/missing predicates
            if actual is None:
                return False
            
            if isinstance(expected, dict):
                # Range check: { gte: 3 } or { lte: 5 } or { gte: 2, lte: 10 }
                if 'gte' in expected and actual < expected['gte']:
                    return False
                if 'lte' in expected and actual > expected['lte']:
                    return False
                if 'gt' in expected and actual <= expected['gt']:
                    return False
                if 'lt' in expected and actual >= expected['lt']:
                    return False
            elif isinstance(expected, list):
                # Value in list: [1, 2, 3]
                if actual not in expected:
                    return False
            else:
                # Exact match
                if actual != expected:
                    return False
        
        return True
    
    def list_analysis_types(self) -> list[dict]:
        """
        List all available analysis types.
        
        Returns:
            List of dicts with id, name, description for each type
        """
        return [
            {
                'id': d.id,
                'name': d.name,
                'description': d.description,
                'runner': d.runner,
            }
            for d in self.definitions
        ]


# No caching during development - always reload YAML
def get_adaptor() -> AnalysisAdaptor:
    """Get a fresh AnalysisAdaptor instance (reloads YAML each time)."""
    return AnalysisAdaptor()


def match_analysis_type(predicates: dict) -> AnalysisDefinition:
    """
    Convenience function to match predicates to analysis type.
    
    Args:
        predicates: Selection predicates
    
    Returns:
        Matching AnalysisDefinition
    """
    return get_adaptor().match(predicates)

