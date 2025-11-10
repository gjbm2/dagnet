#!/bin/bash
# Test Amplitude API to investigate mean vs k/n discrepancy
# Based on actual edge data from the graph

API_KEY="b2e8b9addbb55ebab5b54938407fd0fa"
SECRET_KEY="716dfa8ea6e2aa4a4e8cef3cdf3b6fb3"

# Date range (from edge data)
START_DATE="20251103"
END_DATE="20251110"

# URL-encoded parameters (properly encoded)
E1_ENCODED="%7B%22event_type%22%3A%22Household%20Created%22%7D"
E2_ENCODED="%7B%22event_type%22%3A%22ServiceLevel%20Confirmed%22%2C%22filters%22%3A%5B%7B%22subprop_type%22%3A%22event%22%2C%22subprop_key%22%3A%22level%22%2C%22subprop_op%22%3A%22is%22%2C%22subprop_value%22%3A%5B%22DO_MOST_OF_IT_FOR_ME%22%2C%22DO_ALL_OF_IT_FOR_ME%22%5D%7D%5D%7D"
S_ENCODED="%5B%7B%22prop%22%3A%22userdata_cohort%22%2C%22op%22%3A%22is%20not%22%2C%22values%22%3A%5B%229z057h6i%22%5D%7D%5D"

# Build the curl command with -g flag (disable globbing for JSON in query params)
echo "Fetching data from Amplitude API..."
echo ""

curl -g --location --request GET \
  "https://amplitude.com/api/2/funnels?e=${E1_ENCODED}&e=${E2_ENCODED}&start=${START_DATE}&end=${END_DATE}&i=1&s=${S_ENCODED}" \
  -u "${API_KEY}:${SECRET_KEY}" \
  --header "Accept: application/json" \
  > amplitude_response.json

echo ""
echo "Response saved to amplitude_response.json"
echo ""
echo "Analyzing response..."
echo ""

# Use Python to parse JSON (works without jq)
python3 << 'PYTHON_EOF'
import json
import sys

try:
    with open('amplitude_response.json', 'r') as f:
        data = json.load(f)
    
    print("=== RESPONSE STATUS ===")
    if 'code' in data:
        print(f"Error: {data.get('code')} - {data.get('message', 'Unknown error')}")
        sys.exit(1)
    
    if 'data' not in data or len(data['data']) == 0:
        print("No data found in response")
        sys.exit(1)
    
    funnel_data = data['data'][0]
    
    print("=== AGGREGATE VALUES ===")
    if 'steps' in funnel_data and len(funnel_data['steps']) >= 2:
        from_count = funnel_data['steps'][0].get('count', 0)
        to_count = funnel_data['steps'][1].get('count', 0)
        
        print(f"from_count (step 0): {from_count}")
        print(f"to_count (step 1):   {to_count}")
        
        if from_count > 0:
            calculated_mean = to_count / from_count
            print(f"Calculated mean (to_count/from_count): {calculated_mean:.10f}")
            
            print("")
            print("=== COMPARISON ===")
            print("Expected from graph:")
            print("  n = 1765")
            print("  k = 1076")
            print("  mean = 0.5894932644146895")
            print("")
            print("From API response:")
            print(f"  from_count = {from_count}")
            print(f"  to_count = {to_count}")
            print(f"  calculated mean = {calculated_mean:.10f}")
            print("")
            print(f"Discrepancy: Graph mean (0.589) vs Calculated ({calculated_mean:.10f})")
            print(f"Difference: {abs(0.5894932644146895 - calculated_mean):.10f}")
        else:
            print("ERROR: from_count is 0")
    else:
        print("No steps found in response")
    
    print("")
    print("=== DAILY BREAKDOWN ===")
    if 'dayFunnels' in funnel_data:
        day_funnels = funnel_data['dayFunnels']
        print(f"Found dayFunnels with {len(day_funnels.get('xValues', []))} days")
        if 'series' in day_funnels and len(day_funnels['series']) > 0:
            print(f"First day data: {day_funnels['series'][0]}")
    else:
        print("No dayFunnels found")
    
    print("")
    print("=== FULL RESPONSE STRUCTURE ===")
    print("Top-level keys:", list(funnel_data.keys()))
    if 'conversionRate' in funnel_data:
        print(f"conversionRate field: {funnel_data['conversionRate']}")
    if 'rate' in funnel_data:
        print(f"rate field: {funnel_data['rate']}")
    
except FileNotFoundError:
    print("ERROR: amplitude_response.json not found")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"ERROR: Failed to parse JSON: {e}")
    print("Response content:")
    with open('amplitude_response.json', 'r') as f:
        print(f.read()[:500])
    sys.exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
PYTHON_EOF

