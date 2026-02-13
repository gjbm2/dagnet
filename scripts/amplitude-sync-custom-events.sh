#!/usr/bin/env bash
#
# Sync Amplitude custom events from one project to another.
#
# Usage:
#   1. Log in to app.amplitude.com in a browser
#   2. Open DevTools > Network, find any request to app.amplitude.com
#   3. Copy the Cookie header value
#   4. Run:
#      ./scripts/amplitude-sync-custom-events.sh \
#        --cookie "PASTE_COOKIE_HERE" \
#        --org 126433 \
#        --source 334050 \
#        --target 785524 \
#        [--dry-run]
#
# What it does:
#   - Lists all custom events in the source project
#   - Lists all custom events in the target project
#   - For each source event not in the target (by display name): creates it
#   - For each source event already in the target: updates if definition differs
#   - Prints a summary of actions taken
#
# Auth: Uses session cookies (not API key/secret). Sessions expire — get fresh cookies each run.
#

set -euo pipefail

# Parse args
COOKIE=""
ORG_ID=""
SOURCE_APP=""
TARGET_APP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cookie)  COOKIE="$2"; shift 2;;
    --org)     ORG_ID="$2"; shift 2;;
    --source)  SOURCE_APP="$2"; shift 2;;
    --target)  TARGET_APP="$2"; shift 2;;
    --dry-run) DRY_RUN=true; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$COOKIE" || -z "$ORG_ID" || -z "$SOURCE_APP" || -z "$TARGET_APP" ]]; then
  echo "Missing required args. See usage at top of script."
  exit 1
fi

GQL_URL="https://app.amplitude.com/t/graphql/org-url/project-vault"

# GraphQL query to list custom events
LIST_QUERY='query CustomEvents($appId: ID!) {
  customEvents(appId: $appId, allowedSuggestionStatuses: [NULL, ACCEPTED, SUGGESTED]) {
    id
    appId
    categoryName: category
    definition
    description
    display: displayName
    deleted: isDeleted
    hidden: isHidden
    autotrack: isAutotrack
    __typename
  }
}'

# GraphQL mutation to create a custom event
CREATE_MUTATION='mutation CreateCustomEvent($appId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  createCustomEvent(appId: $appId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents {
      id
      display: displayName
      __typename
    }
    __typename
  }
}'

# GraphQL mutation to update a custom event
UPDATE_MUTATION='mutation UpdateCustomEvent($appId: ID!, $customEventId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  updateCustomEvent(appId: $appId, customEventId: $customEventId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents {
      id
      display: displayName
      __typename
    }
    __typename
  }
}'

gql_request() {
  local query="$1"
  local opName="$2"
  local vars="$3"
  
  curl -s "$GQL_URL?q=$opName" \
    -H 'content-type: application/json' \
    -H "cookie: $COOKIE" \
    -H "x-org: $ORG_ID" \
    -H 'origin: https://app.amplitude.com' \
    --data-raw "$(python3 -c "
import json, sys
print(json.dumps({
    'operationName': '$opName',
    'variables': json.loads('''$vars'''),
    'query': '''$query'''
}))
")"
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Amplitude Custom Event Sync                               ║"
echo "║  Source: $SOURCE_APP → Target: $TARGET_APP                 ║"
echo "║  Dry run: $DRY_RUN                                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo

# List source custom events
echo "Fetching source project ($SOURCE_APP) custom events..."
SOURCE_JSON=$(gql_request "$LIST_QUERY" "CustomEvents" "{\"appId\":\"$SOURCE_APP\"}")
echo "$SOURCE_JSON" > /tmp/amp-sync-source.json

# List target custom events
echo "Fetching target project ($TARGET_APP) custom events..."
TARGET_JSON=$(gql_request "$LIST_QUERY" "CustomEvents" "{\"appId\":\"$TARGET_APP\"}")
echo "$TARGET_JSON" > /tmp/amp-sync-target.json

# Diff and sync
python3 << 'PYEOF'
import json, subprocess, sys, os

dry_run = os.environ.get('DRY_RUN', 'false') == 'true'
target_app = os.environ.get('TARGET_APP', '')
cookie = os.environ.get('COOKIE', '')
org_id = os.environ.get('ORG_ID', '')

with open('/tmp/amp-sync-source.json') as f:
    source_data = json.load(f)
with open('/tmp/amp-sync-target.json') as f:
    target_data = json.load(f)

source_ces = source_data.get('data', {}).get('customEvents', [])
target_ces = target_data.get('data', {}).get('customEvents', [])

if not isinstance(source_ces, list):
    print(f"ERROR: Could not load source custom events. Response: {json.dumps(source_data)[:500]}")
    sys.exit(1)
if not isinstance(target_ces, list):
    print(f"ERROR: Could not load target custom events. Response: {json.dumps(target_data)[:500]}")
    sys.exit(1)

# Filter to active (non-deleted) events
source_active = [ce for ce in source_ces if isinstance(ce, dict) and not ce.get('deleted')]
target_active = [ce for ce in target_ces if isinstance(ce, dict) and not ce.get('deleted')]

print(f"\nSource: {len(source_active)} active custom events")
print(f"Target: {len(target_active)} active custom events\n")

# Build target lookup by display name
target_by_name = {ce.get('display', ''): ce for ce in target_active}

created = 0
updated = 0
skipped = 0
errors = 0

for ce in source_active:
    name = ce.get('display', '')
    definition = ce.get('definition', [])
    description = ce.get('description', '') or ''
    category = ce.get('categoryName', '') or ''
    is_autotrack = ce.get('autotrack', False)
    
    if not name:
        print(f"  SKIP: event with id={ce.get('id')} has no display name")
        skipped += 1
        continue
    
    existing = target_by_name.get(name)
    
    if existing:
        # Check if definition differs
        existing_def = existing.get('definition', [])
        if json.dumps(definition, sort_keys=True) == json.dumps(existing_def, sort_keys=True):
            print(f"  OK: \"{name}\" — already exists with same definition")
            skipped += 1
            continue
        else:
            action = "UPDATE"
            target_id = existing.get('id')
            print(f"  UPDATE: \"{name}\" (id={target_id}) — definition differs")
    else:
        action = "CREATE"
        print(f"  CREATE: \"{name}\" — {len(definition)} constituent event(s)")
    
    if dry_run:
        continue
    
    # Execute mutation
    GQL_URL = "https://app.amplitude.com/t/graphql/org-url/project-vault"
    
    if action == "CREATE":
        mutation = """mutation CreateCustomEvent($appId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  createCustomEvent(appId: $appId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents { id display: displayName __typename }
    __typename
  }
}"""
        variables = {
            "appId": target_app,
            "name": name,
            "definition": definition,
            "description": description,
            "isAutotrack": is_autotrack,
            "category": category,
        }
    else:
        mutation = """mutation UpdateCustomEvent($appId: ID!, $customEventId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  updateCustomEvent(appId: $appId, customEventId: $customEventId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents { id display: displayName __typename }
    __typename
  }
}"""
        variables = {
            "appId": target_app,
            "customEventId": target_id,
            "name": name,
            "definition": definition,
            "description": description,
            "isAutotrack": is_autotrack,
            "category": category,
        }
    
    op_name = "CreateCustomEvent" if action == "CREATE" else "UpdateCustomEvent"
    payload = json.dumps({
        "operationName": op_name,
        "variables": variables,
        "query": mutation,
    })
    
    import urllib.request
    req = urllib.request.Request(
        f"{GQL_URL}?q={op_name}",
        data=payload.encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'x-org': org_id,
            'Origin': 'https://app.amplitude.com',
        },
    )
    
    try:
        resp = urllib.request.urlopen(req)
        resp_body = json.loads(resp.read().decode('utf-8'))
        if resp_body.get('errors'):
            print(f"    ERROR: {resp_body['errors']}")
            errors += 1
        else:
            if action == "CREATE":
                created += 1
            else:
                updated += 1
            print(f"    ✓ {action} succeeded")
    except Exception as e:
        print(f"    ERROR: {e}")
        errors += 1

print(f"\n{'DRY RUN ' if dry_run else ''}Summary: {created} created, {updated} updated, {skipped} unchanged, {errors} errors")
PYEOF
