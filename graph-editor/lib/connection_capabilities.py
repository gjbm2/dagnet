"""
Connection Capabilities — provider-level capability defaults.

The Python backend is logically decoupled from the frontend and must NOT read
files from frontend directories (public/, src/, etc.). Provider capabilities
are determined from the provider type alone, using hardcoded defaults below.

If connection-specific capability overrides are ever needed, the frontend must
send them in the API request — NOT via a shared file.

═══════════════════════════════════════════════════════════════════════════════
NOTE: As of 4-Dec-25, Amplitude supports native exclude via inline
behavioral cohort segment filters. The `supports_native_exclude` default
for amplitude is TRUE.

This means MSMDC's minus()/plus() compilation logic will NOT be triggered
for Amplitude queries. The compilation code remains for providers that don't
support native excludes.
═══════════════════════════════════════════════════════════════════════════════
"""

from typing import Dict, Any, Optional


# ─────────────────────────────────────────────────────────────
# Provider-level defaults (single source of truth for Python)
# ─────────────────────────────────────────────────────────────

_PROVIDER_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "amplitude": {
        "supports_native_exclude": True,
        "supports_visited": True,
        "supports_ordered": True,
        "max_funnel_length": 10,
    },
    "statsig": {
        "supports_native_exclude": False,
        "supports_visited": False,
        "supports_ordered": False,
    },
    "google-sheets": {
        "supports_native_exclude": False,
        "supports_visited": False,
        "supports_ordered": False,
    },
    "postgres": {
        "supports_native_exclude": True,
        "supports_visited": True,
        "supports_ordered": True,
    },
}

_CONSERVATIVE_DEFAULT: Dict[str, Any] = {
    "supports_native_exclude": False,
    "supports_visited": False,
    "supports_ordered": False,
}


def get_default_provider_capability(provider: str) -> Dict[str, Any]:
    """
    Return default capabilities for a provider type.

    This is the sole source of capability information in the Python backend.
    """
    return _PROVIDER_DEFAULTS.get(provider, dict(_CONSERVATIVE_DEFAULT))


def supports_native_exclude(connection_name: Optional[str] = None, provider: Optional[str] = None) -> bool:
    """
    Check if a provider supports native exclude() operation.

    Uses provider-type defaults only. The ``connection_name`` parameter is
    accepted for call-site compatibility but is not used for lookup — all
    connections of a given provider type share the same capabilities.

    Args:
        connection_name: Ignored (kept for call-site compatibility).
        provider: Provider type (e.g., "amplitude").

    Returns:
        True if provider supports native exclude, False otherwise.
    """
    if provider:
        return get_default_provider_capability(provider).get('supports_native_exclude', False)

    # No provider specified — conservative default.
    return False
