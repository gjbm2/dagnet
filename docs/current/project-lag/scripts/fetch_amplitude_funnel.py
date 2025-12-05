#!/usr/bin/env python3
"""
Fetch funnel data from Amplitude API with latency-aware settings.

This script constructs and executes Amplitude funnel queries with proper
conversion window (cs) settings for latency tracking.

Usage:
    # Set credentials first:
    export AMPLITUDE_API_KEY="your_api_key"
    export AMPLITUDE_SECRET_KEY="your_secret_key"
    
    # Then run:
    python fetch_amplitude_funnel.py --output axy_funnel_2025.json

Configuration:
    - API credentials from environment variables (AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY)
    - Conversion window (cs) defaults to 45 days (3,888,000 seconds)
    - Date range defaults to last 90 days

Reference:
    Amplitude Dashboard REST API: https://developers.amplitude.com/docs/dashboard-rest-api
    Key parameter: cs (conversion seconds) - max time for user to complete funnel
    Default: 2,592,000 (30 days), we use 3,888,000 (45 days) for latency tracking
"""

import argparse
import json
import os
import sys
import requests
from datetime import datetime, timedelta
from base64 import b64encode


# =============================================================================
# CONFIGURATION
# =============================================================================

# Amplitude API credentials from environment
API_KEY = os.environ.get("AMPLITUDE_API_KEY")
SECRET_KEY = os.environ.get("AMPLITUDE_SECRET_KEY")

# API endpoint
AMPLITUDE_API_URL = "https://amplitude.com/api/2/funnels"

# Conversion window in seconds
# 30 days = 2,592,000 (Amplitude default)
# 45 days = 3,888,000 (our default for latency tracking)
# 90 days = 7,776,000 (maximum recommended)
DEFAULT_CONVERSION_WINDOW_DAYS = 45
SECONDS_PER_DAY = 86400


# =============================================================================
# EVENT DEFINITIONS
# =============================================================================

# Event definitions matching our graph nodes
# These map to the events in our DAG

EVENTS = {
    # A: Household Created (graph start node)
    "household-created": {
        "event_type": "Household Created",
        "filters": []
    },
    
    # X: Switch Registered (intermediate node)
    "switch-registered": {
        "event_type": "Blueprint CheckpointReached",
        "filters": [
            {
                "subprop_type": "event",
                "subprop_key": "checkpoint",
                "subprop_op": "is",
                "subprop_value": ["SwitchRegistered"]
            }
        ]
    },
    
    # Y: Switch Success (final node)
    "switch-success": {
        "event_type": "Blueprint SwitchSuccess",
        "filters": []
    }
}


# =============================================================================
# FUNNEL DEFINITIONS
# =============================================================================

# Pre-defined funnels for common queries
FUNNELS = {
    # 3-step funnel: A → X → Y (full path with latency data for both edges)
    "axy": {
        "name": "Household → Switch Registered → Switch Success",
        "events": ["household-created", "switch-registered", "switch-success"],
        "description": "Full 3-step funnel with A→X and X→Y latency data"
    },
    
    # 2-step funnel: X → Y (just the final edge)
    "xy": {
        "name": "Switch Registered → Switch Success",
        "events": ["switch-registered", "switch-success"],
        "description": "2-step funnel for X→Y edge only (no A→X latency)"
    },
    
    # 2-step funnel: A → X (just the first edge)
    "ax": {
        "name": "Household → Switch Registered",
        "events": ["household-created", "switch-registered"],
        "description": "2-step funnel for A→X edge only"
    }
}


# =============================================================================
# API FUNCTIONS
# =============================================================================

def build_auth_header(api_key: str, secret_key: str) -> str:
    """Build Basic auth header from API key and secret."""
    credentials = f"{api_key}:{secret_key}"
    encoded = b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


def build_event_param(event_id: str) -> dict:
    """Build event parameter from event definition."""
    event_def = EVENTS.get(event_id)
    if not event_def:
        raise ValueError(f"Unknown event: {event_id}")
    
    param = {"event_type": event_def["event_type"]}
    if event_def.get("filters"):
        param["filters"] = event_def["filters"]
    
    return param


def fetch_funnel(
    funnel_id: str,
    start_date: str,
    end_date: str,
    conversion_window_days: int = DEFAULT_CONVERSION_WINDOW_DAYS,
    mode: str = "ordered",
    interval: int = 1,  # 1 = daily breakdown
) -> dict:
    """
    Fetch funnel data from Amplitude API.
    
    Args:
        funnel_id: Key from FUNNELS dict (e.g., "axy", "xy", "ax")
        start_date: Start date in YYYYMMDD format
        end_date: End date in YYYYMMDD format
        conversion_window_days: Max days for user to complete funnel (default: 45)
        mode: "ordered" (default), "unordered", or "sequential"
        interval: 1=daily, 7=weekly, 30=monthly
    
    Returns:
        JSON response from Amplitude API
    """
    funnel = FUNNELS.get(funnel_id)
    if not funnel:
        raise ValueError(f"Unknown funnel: {funnel_id}. Available: {list(FUNNELS.keys())}")
    
    # Build event parameters
    events = [build_event_param(event_id) for event_id in funnel["events"]]
    
    # Build query parameters
    params = {
        "start": start_date,
        "end": end_date,
        "mode": mode,
        "n": "new",  # New users (cohort-style)
        "i": interval,  # Daily breakdown
        "cs": conversion_window_days * SECONDS_PER_DAY,  # Conversion window in seconds
    }
    
    # Add event parameters (multiple 'e' params)
    # requests library handles this with a list of tuples
    param_tuples = [(k, v) for k, v in params.items()]
    for event in events:
        param_tuples.append(("e", json.dumps(event)))
    
    # Make request
    headers = {
        "Authorization": build_auth_header(API_KEY, SECRET_KEY),
    }
    
    print(f"Fetching funnel: {funnel['name']}")
    print(f"  Events: {funnel['events']}")
    print(f"  Date range: {start_date} to {end_date}")
    print(f"  Conversion window: {conversion_window_days} days ({conversion_window_days * SECONDS_PER_DAY} seconds)")
    print(f"  Mode: {mode}, Interval: {interval}")
    print()
    
    response = requests.get(
        AMPLITUDE_API_URL,
        params=param_tuples,
        headers=headers,
    )
    
    if response.status_code != 200:
        print(f"Error: {response.status_code}")
        print(response.text)
        raise Exception(f"API request failed: {response.status_code}")
    
    return response.json()


def format_date(dt: datetime) -> str:
    """Format datetime as YYYYMMDD for Amplitude API."""
    return dt.strftime("%Y%m%d")


# =============================================================================
# MAIN
# =============================================================================

def main():
    # Check for credentials
    if not API_KEY or not SECRET_KEY:
        print("Error: Amplitude credentials not set.")
        print()
        print("Set environment variables before running:")
        print('  export AMPLITUDE_API_KEY="your_api_key"')
        print('  export AMPLITUDE_SECRET_KEY="your_secret_key"')
        print()
        print("Or inline:")
        print('  AMPLITUDE_API_KEY="..." AMPLITUDE_SECRET_KEY="..." python fetch_amplitude_funnel.py ...')
        return 1
    
    parser = argparse.ArgumentParser(
        description="Fetch Amplitude funnel data with latency-aware settings"
    )
    parser.add_argument(
        "--funnel", "-f",
        choices=list(FUNNELS.keys()),
        default="axy",
        help="Funnel to fetch (default: axy = A→X→Y)"
    )
    parser.add_argument(
        "--start", "-s",
        help="Start date (YYYYMMDD). Default: 90 days ago"
    )
    parser.add_argument(
        "--end", "-e",
        help="End date (YYYYMMDD). Default: yesterday"
    )
    parser.add_argument(
        "--days", "-d",
        type=int,
        default=90,
        help="Number of days to fetch (if --start not specified). Default: 90"
    )
    parser.add_argument(
        "--conversion-window", "-c",
        type=int,
        default=DEFAULT_CONVERSION_WINDOW_DAYS,
        help=f"Conversion window in days. Default: {DEFAULT_CONVERSION_WINDOW_DAYS}"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output JSON file (default: stdout)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print request details without making API call"
    )
    
    args = parser.parse_args()
    
    # Calculate date range
    if args.end:
        end_date = args.end
    else:
        end_date = format_date(datetime.now() - timedelta(days=1))
    
    if args.start:
        start_date = args.start
    else:
        # Calculate start from end_date minus days
        end_dt = datetime.strptime(end_date, "%Y%m%d")
        start_dt = end_dt - timedelta(days=args.days - 1)
        start_date = format_date(start_dt)
    
    funnel = FUNNELS[args.funnel]
    
    if args.dry_run:
        print("=== DRY RUN ===")
        print(f"Funnel: {args.funnel} - {funnel['name']}")
        print(f"Description: {funnel['description']}")
        print(f"Events: {funnel['events']}")
        print(f"Date range: {start_date} to {end_date}")
        print(f"Conversion window: {args.conversion_window} days")
        print()
        print("Event definitions:")
        for event_id in funnel["events"]:
            print(f"  {event_id}: {json.dumps(build_event_param(event_id), indent=4)}")
        return 0
    
    # Fetch data
    data = fetch_funnel(
        funnel_id=args.funnel,
        start_date=start_date,
        end_date=end_date,
        conversion_window_days=args.conversion_window,
    )
    
    # Output
    if args.output:
        with open(args.output, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Written to {args.output}")
        
        # Print summary
        if "data" in data and data["data"]:
            d = data["data"][0]
            print(f"\nSummary:")
            print(f"  Events: {d.get('events', [])}")
            print(f"  Cumulative raw: {d.get('cumulativeRaw', [])}")
            print(f"  Median trans times (ms): {d.get('medianTransTimes', [])}")
    else:
        print(json.dumps(data, indent=2))
    
    return 0


if __name__ == "__main__":
    exit(main())

