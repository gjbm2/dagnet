"""
Connection Capabilities Loader

Loads provider capabilities from connections.yaml to inform MSMDC query generation.

═══════════════════════════════════════════════════════════════════════════════
NOTE: As of 4-Dec-25, Amplitude now supports native exclude via inline 
behavioral cohort segment filters. The `supports_native_exclude` flag for
amplitude-prod has been set to TRUE in connections.yaml.

This means MSMDC's minus()/plus() compilation logic will NO LONGER be triggered
for Amplitude queries. The compilation code remains for providers that don't
support native excludes.
═══════════════════════════════════════════════════════════════════════════════
"""

import yaml
from typing import Dict, Any, Optional
from pathlib import Path


def load_connection_capabilities() -> Dict[str, Dict[str, Any]]:
    """
    Load connection capabilities from connections.yaml.
    
    Returns:
        Dict mapping connection_name -> capabilities dict
        Example: {
            "amplitude-prod": {
                "supports_native_exclude": False,
                "supports_visited": True,
                "supports_ordered": True,
                "max_funnel_length": 10
            }
        }
    """
    # Find connections.yaml (relative to this file)
    lib_dir = Path(__file__).parent
    connections_path = lib_dir.parent / "public" / "defaults" / "connections.yaml"
    
    if not connections_path.exists():
        print(f"[WARNING] connections.yaml not found at {connections_path}")
        return {}
    
    try:
        with open(connections_path, 'r') as f:
            connections_data = yaml.safe_load(f)
        
        capabilities_map = {}
        
        for conn in connections_data.get('connections', []):
            conn_name = conn.get('name')
            capabilities = conn.get('capabilities', {})
            
            if conn_name:
                capabilities_map[conn_name] = capabilities
        
        return capabilities_map
    
    except Exception as e:
        print(f"[ERROR] Failed to load connection capabilities: {e}")
        return {}


def get_default_provider_capability(provider: str) -> Dict[str, Any]:
    """
    Return default capabilities for a provider type.
    
    Used as fallback when connection-specific capabilities aren't found.
    """
    defaults = {
        "amplitude": {
            # NOTE: Changed to True on 4-Dec-25 - Amplitude supports native exclude
            # via inline behavioral cohort segment filters in the s= parameter
            "supports_native_exclude": True,
            "supports_visited": True,
            "supports_ordered": True,
            "max_funnel_length": 10
        },
        "statsig": {
            "supports_native_exclude": False,
            "supports_visited": False,
            "supports_ordered": False
        },
        "google-sheets": {
            "supports_native_exclude": False,
            "supports_visited": False,
            "supports_ordered": False
        },
        "postgres": {
            "supports_native_exclude": True,
            "supports_visited": True,
            "supports_ordered": True
        }
    }
    
    return defaults.get(provider, {
        "supports_native_exclude": False,
        "supports_visited": False,
        "supports_ordered": False
    })


def supports_native_exclude(connection_name: Optional[str], provider: Optional[str] = None) -> bool:
    """
    Check if a connection/provider supports native exclude() operation.
    
    Args:
        connection_name: Name of the connection (e.g., "amplitude-prod")
        provider: Provider type (e.g., "amplitude") - fallback if connection not found
    
    Returns:
        True if provider supports native exclude, False otherwise
    """
    # Load capabilities
    capabilities_map = load_connection_capabilities()
    
    # Try connection-specific first
    if connection_name and connection_name in capabilities_map:
        return capabilities_map[connection_name].get('supports_native_exclude', False)
    
    # Fall back to provider defaults
    if provider:
        defaults = get_default_provider_capability(provider)
        return defaults.get('supports_native_exclude', False)
    
    # Ultra-conservative default: assume no exclude support
    return False

