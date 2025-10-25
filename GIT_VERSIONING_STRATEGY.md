# Git-Based Versioning Strategy

**Purpose:** Leverage Git for immutable versioning while maintaining semantic version convenience

---

## The Key Insight

Git already provides:
- ✅ **Immutable history** (commits, tags)
- ✅ **Branching** (main, staging, feature branches)
- ✅ **Version snapshots** (tags like `v2.1.0`)
- ✅ **Audit trail** (who changed what, when)

**We should use Git as the source of truth, not duplicate it!**

---

## Dual Reference System

### Version References Support Both Formats

```yaml
# Parameter definition
id: checkout-conversion
name: "Checkout Conversion Rate"

# Option 1: Semantic version (human-friendly)
graph_compatibility:
  graph_id: "checkout-flow"
  version: "2.1.0"  # Resolves to git tag v2.1.0

# Option 2: Git reference (immutable)
graph_compatibility:
  graph_id: "checkout-flow"
  git_ref: "v2.1.0"  # Git tag
  # OR
  git_ref: "abc123def"  # Specific commit
  # OR
  git_ref: "main"  # Latest on branch (mutable!)

# Option 3: Both (recommended)
graph_compatibility:
  graph_id: "checkout-flow"
  version: "2.1.0"  # Human-readable
  git_ref: "v2.1.0"  # Immutable reference
  commit_sha: "abc123def456"  # Exact commit (auto-populated)
```

---

## Git Tag Strategy

### Semantic Versions = Git Tags

When you version a graph:
```bash
# 1. Update version in graph file
# graph.json: "version": "2.1.0"

# 2. Commit the change
git add graphs/checkout-flow.json
git commit -m "Version 2.1.0: Add review step to checkout flow"

# 3. Create Git tag (automated or manual)
git tag -a v2.1.0 -m "Version 2.1.0: Add review step"

# 4. Push with tags
git push origin main --tags
```

**Result:** `v2.1.0` tag points to exact commit with that graph version

---

## Version Resolution System

### How Parameters Resolve Graph Versions

```typescript
export async function resolveGraphVersion(
  graphId: string,
  versionRef: string | GitRef
): Promise<GraphSnapshot> {
  
  // 1. Determine reference type
  if (typeof versionRef === 'string') {
    // Semantic version string
    if (/^\d+\.\d+\.\d+$/.test(versionRef)) {
      // Convert to Git tag
      const gitTag = `v${versionRef}`;
      return fetchGraphAtTag(graphId, gitTag);
    }
    
    // Branch name
    if (['main', 'staging', 'develop'].includes(versionRef)) {
      return fetchGraphAtBranch(graphId, versionRef);
    }
    
    // Git tag
    if (versionRef.startsWith('v')) {
      return fetchGraphAtTag(graphId, versionRef);
    }
    
    // Commit SHA
    if (/^[a-f0-9]{7,40}$/.test(versionRef)) {
      return fetchGraphAtCommit(graphId, versionRef);
    }
  }
  
  throw new Error(`Invalid version reference: ${versionRef}`);
}

async function fetchGraphAtTag(
  graphId: string,
  tag: string
): Promise<GraphSnapshot> {
  // Fetch from GitHub API
  const url = `https://api.github.com/repos/${org}/${repo}/contents/graphs/${graphId}.json?ref=${tag}`;
  const response = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}` }
  });
  const data = await response.json();
  
  return {
    graph: JSON.parse(atob(data.content)),
    commit_sha: data.sha,
    tag: tag,
    committed_at: data.commit.committer.date
  };
}
```

---

## Mutable vs Immutable References

### Mutable (Latest)

```yaml
# Parameter tracks latest version (auto-updates)
graph_compatibility:
  graph_id: "checkout-flow"
  git_ref: "main"  # Always fetches latest from main branch
  auto_update: true
```

**Use case:** Development, staging environments

**Pros:**
- ✅ Always uses latest graph version
- ✅ No manual updates needed

**Cons:**
- ❌ Parameters might break if graph changes unexpectedly
- ❌ Not reproducible (main branch changes)

---

### Immutable (Pinned)

```yaml
# Parameter pinned to specific version
graph_compatibility:
  graph_id: "checkout-flow"
  version: "2.1.0"
  git_ref: "v2.1.0"
  commit_sha: "abc123def456789"  # Exact commit
  pinned_at: "2025-10-21T00:00:00Z"
```

**Use case:** Production, historical analysis

**Pros:**
- ✅ Reproducible (always same graph version)
- ✅ Safe (graph can't change unexpectedly)
- ✅ Historical analysis works correctly

**Cons:**
- ❌ Manual updates required
- ❌ Might miss bug fixes

---

## Recommended Strategy: Pin in Production, Track in Development

### Development Environment
```yaml
# Parameters in development follow main branch
graph_compatibility:
  git_ref: "main"
  auto_update: true
```

### Staging Environment
```yaml
# Parameters in staging follow staging branch
graph_compatibility:
  git_ref: "staging"
  auto_update: true
```

### Production Environment
```yaml
# Parameters in production pinned to tagged versions
graph_compatibility:
  version: "2.1.0"
  git_ref: "v2.1.0"
  commit_sha: "abc123def456789"
  pinned: true
```

---

## GitHub API Integration

### Fetching Specific Graph Versions

```typescript
export class GitGraphLoader {
  constructor(
    private org: string,
    private repo: string,
    private token: string
  ) {}
  
  /**
   * Load graph at specific version
   */
  async loadGraph(
    graphId: string,
    ref: string = 'main'
  ): Promise<Graph> {
    const url = `https://api.github.com/repos/${this.org}/${this.repo}/contents/graphs/${graphId}.json?ref=${ref}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load graph: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    return {
      ...JSON.parse(atob(data.content)),
      _metadata: {
        commit_sha: data.sha,
        git_ref: ref,
        loaded_at: new Date().toISOString()
      }
    };
  }
  
  /**
   * List all versions (tags) of a graph
   */
  async listVersions(graphId: string): Promise<GraphVersion[]> {
    // Get all tags
    const tagsUrl = `https://api.github.com/repos/${this.org}/${this.repo}/git/refs/tags`;
    const tagsResponse = await fetch(tagsUrl, {
      headers: { 'Authorization': `token ${this.token}` }
    });
    const tags = await tagsResponse.json();
    
    const versions: GraphVersion[] = [];
    
    for (const tag of tags) {
      // Check if graph exists at this tag
      try {
        const graph = await this.loadGraph(graphId, tag.ref.replace('refs/tags/', ''));
        versions.push({
          version: graph.version,
          git_tag: tag.ref.replace('refs/tags/', ''),
          commit_sha: tag.object.sha,
          created_at: tag.object.date
        });
      } catch {
        // Graph doesn't exist at this tag, skip
      }
    }
    
    return versions.sort((a, b) => 
      compareVersions(b.version, a.version)  // Newest first
    );
  }
  
  /**
   * Get commit history for a graph
   */
  async getGraphHistory(
    graphId: string,
    limit: number = 50
  ): Promise<GraphCommit[]> {
    const url = `https://api.github.com/repos/${this.org}/${this.repo}/commits?path=graphs/${graphId}.json&per_page=${limit}`;
    
    const response = await fetch(url, {
      headers: { 'Authorization': `token ${this.token}` }
    });
    
    const commits = await response.json();
    
    return commits.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      url: c.html_url
    }));
  }
}
```

---

## Version Selector UI

### Graph Version Picker

```
┌─ Select Graph Version ────────────────────────────────────────┐
│                                                                │
│  Graph: checkout-flow                                          │
│                                                                │
│  ⦿ Latest (main branch)                                       │
│    Current version: 2.1.0                                      │
│    Last updated: 2 hours ago                                   │
│    ⚠️ Mutable - may change                                     │
│                                                                │
│  ○ Pinned to version:                                          │
│    [v2.1.0              ▼]                                    │
│    • v2.1.0 (current) - abc123d - 2 hours ago                │
│    • v2.0.0 - def456a - 3 weeks ago                           │
│    • v1.5.0 - 789bcde - 2 months ago                          │
│    ✓ Immutable - reproducible                                 │
│                                                                │
│  ○ Specific commit:                                            │
│    [abc123def456_____]                                         │
│    ✓ Immutable - exact snapshot                               │
│                                                                │
│  ○ Other branch:                                               │
│    [staging            ▼]                                     │
│    ⚠️ Mutable - may change                                     │
│                                                                │
│  [Cancel]  [Select]                                            │
└────────────────────────────────────────────────────────────────┘
```

---

## Parameter Schema Extension

```yaml
# Extended graph_compatibility field
graph_compatibility:
  type: object
  required: [graph_id]
  properties:
    graph_id:
      type: string
      description: "ID of the graph"
    
    # Human-readable version
    version:
      type: string
      pattern: '^\\d+\\.\\d+\\.\\d+$'
      description: "Semantic version (e.g., 2.1.0)"
    
    # Git reference (immutable)
    git_ref:
      type: string
      description: "Git tag, branch, or commit SHA"
      examples: ["v2.1.0", "main", "abc123def"]
    
    # Exact commit (auto-populated)
    commit_sha:
      type: string
      pattern: '^[a-f0-9]{40}$'
      description: "Full Git commit SHA (40 chars)"
    
    # When this reference was set
    pinned_at:
      type: string
      format: date-time
      description: "When this version reference was pinned"
    
    # Auto-update behavior
    auto_update:
      type: boolean
      default: false
      description: "Whether to auto-update to latest on git_ref"
    
    # Reference is mutable warning
    mutable:
      type: boolean
      description: "Whether this reference can change (branch vs tag)"
```

---

## Graph Metadata Extension

```json
{
  "id": "checkout-flow",
  "version": "2.1.0",
  "git_metadata": {
    "repository": "yourorg/dagnet-graphs",
    "path": "graphs/checkout-flow.json",
    "commit_sha": "abc123def456789",
    "git_tag": "v2.1.0",
    "committed_at": "2025-10-21T14:30:00Z",
    "committed_by": "user@example.com"
  }
}
```

---

## Deployment Workflow

### Development to Production

```
1. Developer changes graph locally
   ↓
2. Commits to feature branch
   git commit -m "Add review step"
   ↓
3. Opens PR to main
   ↓
4. CI checks:
   - Schema validation
   - Parameter compatibility analysis
   - Breaking change detection
   ↓
5. PR approved and merged to main
   ↓
6. Bump version, create tag
   git tag v2.1.0
   git push --tags
   ↓
7. Staging environment auto-deploys
   (uses git_ref: "staging")
   ↓
8. QA tests in staging
   ↓
9. Promote to production
   - Update production params to git_ref: "v2.1.0"
   - Parameters now pinned to specific version
   ↓
10. Production stable
    (pinned to immutable v2.1.0 tag)
```

---

## Historical Analysis with Git

### Query: "What was conversion rate on Oct 1st?"

```typescript
// 1. Find graph version at that date
const commit = await getCommitAtDate('checkout-flow', '2025-10-01');

// 2. Load graph at that commit
const graph = await loadGraphAtCommit('checkout-flow', commit.sha);

// 3. Find parameters compatible with that version
const params = await loadParametersForGraph(
  'checkout-flow',
  graph.version,
  commit.sha
);

// 4. Run analysis with that graph + params
const analysis = runAnalysis(graph, params);
```

**Result:** Reproducible historical analysis using Git history!

---

## Version Comparison

### Compare Two Graph Versions

```typescript
async function compareGraphVersions(
  graphId: string,
  version1: string,
  version2: string
): Promise<GraphDiff> {
  
  const graph1 = await loadGraph(graphId, version1);
  const graph2 = await loadGraph(graphId, version2);
  
  return {
    nodes_added: graph2.nodes.filter(n => 
      !graph1.nodes.find(n1 => n1.id === n.id)
    ),
    nodes_removed: graph1.nodes.filter(n => 
      !graph2.nodes.find(n2 => n2.id === n.id)
    ),
    edges_added: graph2.edges.filter(e => 
      !graph1.edges.find(e1 => e1.id === e.id)
    ),
    edges_removed: graph1.edges.filter(e => 
      !graph2.edges.find(e2 => e2.id === e.id)
    ),
    // ... more detailed diff
  };
}
```

**UI:**
```
┌─ Graph Diff: v2.0.0 → v2.1.0 ─────────────────────────────────┐
│                                                                │
│  + Added node: "review"                                        │
│  ~ Renamed edge: "signup" → "proceed-to-review"               │
│                                                                │
│  Affected parameters: 3                                        │
│  • checkout-conversion (needs update)                          │
│  • signup-rate (edge renamed)                                  │
│  • cart-abandonment (compatible)                               │
│                                                                │
│  Breaking changes: YES (edge renamed)                          │
│  Recommended version: 3.0.0 (major)                            │
└────────────────────────────────────────────────────────────────┘
```

---

## Implementation Priority

### Phase 1 (Include in v1)
- ✅ Add `git_ref` field to parameter compatibility
- ✅ Support version string OR git tag
- ✅ Basic resolution (tag → fetch from GitHub)

**Cost:** ~2-3 days

### Phase 2 (v2)
- ✅ Commit SHA tracking (exact immutable references)
- ✅ Branch support (main, staging)
- ✅ Auto-update mechanism
- ✅ Version history UI
- ✅ Graph diff tool

---

## Summary

### YES, use Git metadata for versioning because:

1. **Git already provides immutability** (commits, tags)
2. **Semantic versions map to Git tags** (v2.1.0 tag)
3. **Supports both latest and pinned** (branches vs tags)
4. **Reproducible historical analysis** (fetch exact commit)
5. **Audit trail built-in** (Git log)
6. **No version duplication** (single source of truth)

### Recommended Approach:

```yaml
# Production (pinned)
graph_compatibility:
  version: "2.1.0"        # Human-readable
  git_ref: "v2.1.0"       # Immutable Git tag
  commit_sha: "abc123..."  # Exact commit

# Development (latest)
graph_compatibility:
  git_ref: "main"         # Mutable branch reference
  auto_update: true
```

**Key benefit:** Parameters can reference **exact immutable snapshots** (Git commits/tags) while also supporting **latest mutable versions** (branches) for development!



