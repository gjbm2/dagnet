#!/usr/bin/env bash
#
# Spike: Capture Amplitude front-end API traffic for funnel chart creation.
#
# This opens a Playwright-controlled Chromium browser pointed at Amplitude.
# All network traffic is recorded to a HAR file.
#
# INSTRUCTIONS:
#   1. Run this script.
#   2. In the browser that opens:
#      a. Log in to Amplitude.
#      b. Create a new funnel chart (Create > Chart > Funnel).
#      c. Add 2-3 events to the funnel.
#      d. Click Save. Note the chart URL.
#      e. Change the date range. Note if the URL changes.
#      f. Change a segment filter. Note if the URL changes.
#      g. Close the browser.
#   3. The HAR file is written to /tmp/amp-funnel-spike.har.
#   4. Run the analysis script:
#      python3 scripts/analyse-funnel-har.py /tmp/amp-funnel-spike.har
#
# Follows the same pattern as the custom events discovery
# (see graph-ops/amplitude/custom-events-api.md).

set -euo pipefail

HAR_PATH="${1:-/tmp/amp-funnel-spike.har}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Amplitude Funnel API Spike — HAR Capture"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  HAR output: ${HAR_PATH}"
echo ""
echo "  In the browser that opens:"
echo "    1. Log in to Amplitude"
echo "    2. Create a new funnel chart (Create > Chart > Funnel)"
echo "    3. Add 2-3 events to the funnel steps"
echo "    4. Click Save — note the chart URL"
echo "    5. Change the date range — note if URL changes"
echo "    6. Change a segment filter — note if URL changes"
echo "    7. Close the browser to write the HAR"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""

cd "$(dirname "$0")/../graph-editor"

PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" \
  npx playwright open \
    --save-har "$HAR_PATH" \
    "https://app.amplitude.com"

echo ""
echo "HAR saved to: ${HAR_PATH}"
echo ""
echo "Next: analyse the captured traffic:"
echo "  python3 scripts/analyse-funnel-har.py ${HAR_PATH}"
echo ""
