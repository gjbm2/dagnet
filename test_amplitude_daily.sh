#!/bin/bash
# Test Amplitude API Daily Funnel Mode
# This script tests the daily mode (i=1) to verify the response format

# SET THESE VALUES:
API_KEY="YOUR_API_KEY_HERE"
SECRET_KEY="YOUR_SECRET_KEY_HERE"

# Test parameters
# Using events from your test setup (adjust as needed)
EVENT_1='{"event_type":"Household Created"}'
EVENT_2='{"event_type":"ServiceLevel Confirmed"}'
START_DATE="20241101"  # YYYYMMDD format - adjust to your data range
END_DATE="20241110"    # Last 10 days

# Build the curl command
# Note: Using -g flag to disable globbing (needed for JSON in query params)
curl -g --location --request GET \
  "https://amplitude.com/api/2/funnels?e=${EVENT_1}&e=${EVENT_2}&start=${START_DATE}&end=${END_DATE}&i=1" \
  -u "${API_KEY}:${SECRET_KEY}" \
  -H "Accept: application/json" \
  | jq '.' > amplitude_daily_test.json

echo "Response saved to amplitude_daily_test.json"
echo ""
echo "Expected structure:"
echo "  data[0].dayFunnels.series = [[n_day1, k_day1], [n_day2, k_day2], ...]"
echo "  data[0].dayFunnels.xValues = [\"2024-11-01\", \"2024-11-02\", ...]"
echo "  data[0].cumulativeRaw = [total_n, total_k]"
echo ""
echo "Check amplitude_daily_test.json for actual response"

