#!/bin/bash
# Test Amplitude funnel query: Household Created → Delegation Completed
# 
# This query demonstrates what daily n/k data looks like for a multi-day conversion

# Load credentials from .env.amplitude.local (see local-env/amplitude.env.example)
ENV_FILE="$(git rev-parse --show-toplevel)/.env.amplitude.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy from local-env/amplitude.env.example and fill in your keys"
  exit 1
fi
source "$ENV_FILE"
API_KEY="${AMPLITUDE_API_KEY:?Set AMPLITUDE_API_KEY in .env.amplitude.local}"
SECRET_KEY="${AMPLITUDE_SECRET_KEY:?Set AMPLITUDE_SECRET_KEY in .env.amplitude.local}"

# Base64 encode for Basic auth
AUTH=$(echo -n "${API_KEY}:${SECRET_KEY}" | base64)

# Date range - use a window where we expect to see multi-day conversions.
# Using 60 days ago to 30 days ago (so cohorts have had 30+ days to mature).
#
# Portability note: use Python for date arithmetic (GNU `date -d` is not portable).
END_DATE=$(python3 -c "import datetime as d; print((d.date.today() - d.timedelta(days=30)).strftime('%Y%m%d'))")
START_DATE=$(python3 -c "import datetime as d; print((d.date.today() - d.timedelta(days=60)).strftime('%Y%m%d'))")

echo "Querying Amplitude: Household Created → Delegation Completed"
echo "Date range: ${START_DATE} to ${END_DATE}"
echo ""

# Event 1: Household Created (no filters)
EVENT1='{"event_type":"Household Created"}'

# Event 2: Household DelegationStatusChanged with property filter
# Filter: newDelegationStatus is any of ["ON"]
EVENT2='{"event_type":"Household DelegationStatusChanged","filters":[{"subprop_type":"event","subprop_key":"newDelegationStatus","subprop_op":"is","subprop_value":["ON"]}]}'

# URL encode the events
EVENT1_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${EVENT1}'))")
EVENT2_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${EVENT2}'))")

# Build the URL
# i=1 means daily breakdown
URL="https://amplitude.com/api/2/funnels?e=${EVENT1_ENCODED}&e=${EVENT2_ENCODED}&start=${START_DATE}&end=${END_DATE}&i=1"

echo "Request URL:"
echo "${URL}"
echo ""

# Make the request
curl -s "${URL}" \
  -H "Authorization: Basic ${AUTH}" \
  -H "Content-Type: application/json" \
  | python3 -c "
import json
import sys

data = json.load(sys.stdin)

# Pretty print key sections
print('=== AGGREGATE RESULTS ===')
if 'data' in data and len(data['data']) > 0:
    d = data['data'][0]
    print(f\"Events: {d.get('events', [])}\")
    print(f\"Cumulative: {d.get('cumulative', [])}\")
    print(f\"CumulativeRaw (n, k): {d.get('cumulativeRaw', [])}\")
    print(f\"Avg Trans Times (ms): {d.get('avgTransTimes', [])}\")
    print(f\"Median Trans Times (ms): {d.get('medianTransTimes', [])}\")
    
    print()
    print('=== DAILY BREAKDOWN ===')
    day_funnels = d.get('dayFunnels', {})
    if day_funnels:
        dates = day_funnels.get('xValues', [])
        series = day_funnels.get('series', [])
        print(f\"{'Date':<12} {'n':>6} {'k':>6} {'p':>8}\")
        print('-' * 34)
        for i, date in enumerate(dates[:15]):  # First 15 days
            if i < len(series):
                n, k = series[i]
                p = k/n if n > 0 else 0
                print(f\"{date:<12} {n:>6} {k:>6} {p:>8.1%}\")
        if len(dates) > 15:
            print(f'... and {len(dates) - 15} more days')
    
    print()
    print('=== DAILY TRANS TIMES ===')
    day_times = d.get('dayMedianTransTimes', {})
    if day_times:
        dates = day_times.get('xValues', [])
        series = day_times.get('series', [])
        print(f\"{'Date':<12} {'Median (ms)':>12} {'Hours':>8} {'Days':>8}\")
        print('-' * 42)
        for i, date in enumerate(dates[:10]):
            if i < len(series):
                ms = series[i][1] if len(series[i]) > 1 else series[i][0]
                hours = ms / (1000 * 60 * 60) if ms > 0 else 0
                days = hours / 24
                print(f\"{date:<12} {ms:>12} {hours:>8.1f} {days:>8.2f}\")
else:
    print('No data returned')
    print(json.dumps(data, indent=2))
"

# Also save raw JSON
echo ""
echo "Saving raw response to test_delegation_response.json..."
curl -s "${URL}" \
  -H "Authorization: Basic ${AUTH}" \
  -H "Content-Type: application/json" \
  > docs/current/project-lag/test_delegation_response.json 2>/dev/null || \
  curl -s "${URL}" \
  -H "Authorization: Basic ${AUTH}" \
  -H "Content-Type: application/json" \
  > test_delegation_response.json

echo "Done."






