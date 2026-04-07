# Manage Hash Mappings Playbook

How to maintain snapshot continuity when editing event or context files.

**Why this matters**: Editing an event or context file changes the `core_hash` used to look up historical snapshots. Without a hash mapping, old snapshots become orphaned — the system can't find them under the new hash. Historical data cannot be re-fetched (Amplitude retention is finite, snapshots are point-in-time observations). A hash mapping bridges old → new so both are queryable.

---

## When Hash Mappings Are Needed

Any edit to these fields changes the hash:

**Event files**:
- `provider_event_names` (changing the Amplitude event name)
- `amplitude_filters` (adding, removing, or changing filter values)

**Context files**:
- `values` (adding, removing, or reordering values)
- `otherPolicy` (changing how "other" is computed)
- `type` (changing context type)
- Value source mappings (changing what a value maps to in Amplitude)

**Changes that do NOT affect the hash**:
- `description`, `category`, `tags`, `metadata` on event files
- (Note: `name` on context files currently IS in the hash — this is a known limitation)

---

## Workflow: CLI Tools

Three CLI tools in `graph-editor/scripts/` handle hash mapping operations. Run from the `graph-editor/` directory.

### Step 1: Check for Hash Changes

Before or after editing, run `diff-hash` to detect which edges are affected:

```bash
cd graph-editor

npx tsx scripts/diff-hash.ts \
  --file <data-dir>/events/my-event.yaml \
  --graph <data-dir>/graphs/my-graph.json \
  --events-dir <data-dir>/events \
  --contexts-dir <data-dir>/contexts
```

Output shows which edges changed hashes:
```
Changed file:  my-event.yaml (event: my-event)
Affected edges in my-graph.json:
  node-a → node-b:  abc123 → def456  CHANGED
  node-c → node-d:  ghi789 → ghi789  unchanged
```

If no edges show CHANGED, no mapping is needed.

### Step 2: Create Mappings

For each CHANGED edge, create a mapping entry:

```bash
npx tsx scripts/add-mapping.ts \
  --mappings <data-dir>/hash-mappings.json \
  --old abc123 \
  --new def456 \
  --reason "changed amplitude_filters on my-event for variant support"
```

The tool validates format, prevents duplicates, and prevents self-links.

### Step 3: Verify

Run `compute-hash` to confirm the new hash matches what was mapped:

```bash
npx tsx scripts/compute-hash.ts \
  --graph <data-dir>/graphs/my-graph.json \
  --edge node-a-to-node-b \
  --events-dir <data-dir>/events \
  --contexts-dir <data-dir>/contexts
```

### Step 4: Commit

Include the edited file(s) AND `hash-mappings.json` in the same commit:

```bash
graph-ops/scripts/commit-and-push.sh "Updated my-event filters + hash mappings"
```

---

## Workflow: In-App (Commit Guard)

When committing via the DagNet app, the commit-time hash guard handles this automatically:

1. Edit event/context files (form editor or YAML)
2. A tab header warning appears: "Event/context definition changed — snapshot hashes will be checked on commit"
3. On commit, a modal appears showing affected parameters grouped by file → graph
4. Select which parameters should get hash mappings (default: all selected)
5. Confirm — mappings are written to `hash-mappings.json` and included in the commit atomically

---

## Agentic Workflow (Claude / AI Assistants)

When editing event or context files in the data repo, agents MUST follow this protocol:

1. **Before editing**: run `diff-hash` to capture current hashes for all affected edges in all relevant graphs
2. **Make the edit**
3. **After editing**: run `diff-hash` again to detect hash changes
4. **For each changed hash**: run `add-mapping` with the old and new `core_hash` and a descriptive reason
5. **Include `hash-mappings.json`** in the commit alongside the edited files
6. **Verify**: run the integrity check to confirm hash chain continuity (see Verification below)
7. **If uncertain** whether a change is hash-breaking (e.g. changing a `description` field), run `diff-hash` anyway — the tool will confirm "unchanged" and the agent can proceed without a mapping

### Verification: Hash Chain Integrity Check

After creating mappings, **always verify** that the hash chain is intact. The integrity service (Phase 9) traces the full mapping chain for every parameter and reports breaks.

**CLI (recommended for agents)**:
```bash
bash graph-ops/scripts/validate-graph.sh graphs/<graph-name>.json --deep
```

Look for `hash-continuity` issues in the output:
- **info** "Hash chain intact across N signature epochs" — all good, mappings are working
- **warning** "Hash chain broken Nd ago" — a mapping is missing. Run `diff-hash` to identify the gap and `add-mapping` to bridge it
- **warning** "Parameter has no snapshot data (graph is Nd old)" — parameter has never been fetched, which may indicate a misconfiguration

**In-app**: File Menu → "Check Integrity..." runs the same check. Hash continuity issues appear in the report under the 🔑 category.

The check traces every `query_signature` stored on every parameter value, computes whether it's reachable from the current hash via the mapping closure, and reports the earliest date where the chain breaks. A fully intact chain means all historical snapshot data is accessible.

The deep check (File Menu → "Check Integrity" or Refresh button in Graph Issues panel) also queries the snapshot DB to verify that snapshots actually exist under plausible hashes. This covers both Class 1 (epoch changes from `dataInterestsDSL` edits) and Class 2 (definition changes bridged by mappings). Issues appear under the 📡 `snapshot-coverage` category.

### What NOT to do

- Never edit `hash-mappings.json` by hand — use `add-mapping` to ensure format correctness
- Never skip the `diff-hash` step because "it's just a small change" — any edit to `amplitude_filters`, `provider_event_names`, source mappings, or `otherPolicy` is hash-breaking
- Never create mappings speculatively — only create them when `diff-hash` confirms a hash change
- Never skip the verification step — `diff-hash` confirms individual hashes changed, but only the integrity check confirms the full chain is intact across all parameters

---

## New Files Don't Need Mappings

When creating a brand new event or context file, there are no historical snapshots to preserve. Skip the `diff-hash` step — there's nothing to compare against.

---

---

## Pattern: Variant Contexts with Behavioural Segment Filters

When an event has a property that discriminates between variants (e.g. `blueprintVariant` on the "Blueprint Viewed" event), you can lift this into a context with behavioural segment filters. This lets you compare variant performance without editing event files.

### Example: Blueprint Variants

The event "Blueprint Viewed" has a property `blueprintVariant` with values like `onboardingBlueprintLowIntent` and `onboardingBlueprintHighIntent`. To track these as a context:

```yaml
id: blueprint-variant
name: Blueprint Variant
type: categorical
otherPolicy: explicit
values:
  # Named variants: "user has done Blueprint Viewed where blueprintVariant = X"
  - id: low-intent
    label: Low Intent
    sources:
      amplitude:
        type: behavioral
        event_type: "Blueprint Viewed"
        filter_property: blueprintVariant
        filter_value: onboardingBlueprintLowIntent
        time_type: rolling
        time_value: 366

  - id: high-intent
    label: High Intent
    sources:
      amplitude:
        type: behavioral
        event_type: "Blueprint Viewed"
        filter_property: blueprintVariant
        filter_value: onboardingBlueprintHighIntent
        time_type: rolling
        time_value: 366

  # Other: "user has done Blueprint Viewed but NOT with these variant values"
  - id: other
    label: Other variant
    sources:
      amplitude:
        type: behavioral
        event_type: "Blueprint Viewed"
        filter_property: blueprintVariant
        filter_op: is not
        filter_values:
          - onboardingBlueprintLowIntent
          - onboardingBlueprintHighIntent
        time_type: rolling
        time_value: 366

  # None: "user has NOT done Blueprint Viewed at all"
  - id: none
    label: No blueprint
    sources:
      amplitude:
        type: behavioral
        event_type: "Blueprint Viewed"
        behavioral_op: "="
        behavioral_value: 0
        time_type: rolling
        time_value: 366

metadata:
  created_at: 30-Mar-26
  version: 1.0.0
  status: active
```

### What each value produces in the Amplitude API

| Value | Amplitude segment | Population |
|-------|------------------|------------|
| `low-intent` | "user has done Blueprint Viewed where blueprintVariant = onboardingBlueprintLowIntent, >= 1 time" | Users who saw the low-intent blueprint |
| `high-intent` | "user has done Blueprint Viewed where blueprintVariant = onboardingBlueprintHighIntent, >= 1 time" | Users who saw the high-intent blueprint |
| `other` | "user has done Blueprint Viewed where blueprintVariant is not [low, high], >= 1 time" | Users who saw a blueprint with some other variant value |
| `none` | "user has done Blueprint Viewed = 0 times" | Users who never saw any blueprint |

MECE: low-intent + high-intent + other + none = all users.

### Key fields on behavioural source mappings

| Field | Required | Purpose |
|-------|----------|---------|
| `type: behavioral` | Yes | Distinguishes from property-based mappings |
| `event_type` | Yes | The Amplitude event name |
| `filter_property` | No | Event property to filter on |
| `filter_value` | No | Single value (implies `filter_op: is`) |
| `filter_op` | No | `is` (default) or `is not` |
| `filter_values` | No | Array of values (use with `is not` for complement) |
| `behavioral_op` | No | `>=` (default, user performed) or `=` (user did NOT perform) |
| `behavioral_value` | No | Count threshold (default: 1 for `>=`, 0 for `=`) |
| `time_type` | No | `rolling` (default) |
| `time_value` | No | Lookback days (default: 366) |

### Adding to a graph

Add the context to the graph's `dataInterestsDSL`:

```
(window(-30d:);cohort(-30d:)).context(channel).context(blueprint-variant)
```

No event file changes needed. Each variant slice is fetched with the appropriate segment filter. Adding new variant values later just requires editing the context file and creating hash mappings (see workflow above).

---

## Troubleshooting

### "No edges in this graph reference event/context X"

The event/context isn't used in that graph. Check other graphs, or confirm the event_id binding on the graph's nodes.

### diff-hash shows CHANGED but you believe the change is non-breaking

Some changes appear hash-breaking but are semantically equivalent (e.g. reordering values in a context — the normalisation sorts by id, so order shouldn't matter). If `diff-hash` says CHANGED, trust it — the hash actually changed. Create the mapping to be safe.

### Forgot to create mappings before committing

If you've already committed without mappings, you can still create them after the fact:
1. Use `git show HEAD~1:events/my-event.yaml` to get the old file content
2. Compute the old hash using `compute-hash` with the old file content
3. Compute the new hash with the current file
4. Run `add-mapping` and commit the updated `hash-mappings.json`

Alternatively, use the Signature Links UI in the DagNet app (right-click on an edge → View signature links) to create mappings manually.
