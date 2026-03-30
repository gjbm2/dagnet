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
6. **If uncertain** whether a change is hash-breaking (e.g. changing a `description` field), run `diff-hash` anyway — the tool will confirm "unchanged" and the agent can proceed without a mapping

### What NOT to do

- Never edit `hash-mappings.json` by hand — use `add-mapping` to ensure format correctness
- Never skip the `diff-hash` step because "it's just a small change" — any edit to `amplitude_filters`, `provider_event_names`, source mappings, or `otherPolicy` is hash-breaking
- Never create mappings speculatively — only create them when `diff-hash` confirms a hash change

---

## New Files Don't Need Mappings

When creating a brand new event or context file, there are no historical snapshots to preserve. Skip the `diff-hash` step — there's nothing to compare against.

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
