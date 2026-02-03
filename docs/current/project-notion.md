# Timeline Annotations with Notion Integration

**Status**: Scoping  
**Date**: 3-Feb-26

---

## 1. Overview

This document scopes a feature to **pin comments/facts to timelines** and surface them contextually when users run queries over relevant date ranges.

### 1.1 Core Use Cases

1. **Marketing campaigns**: "Ran Facebook campaign 1-Dec-25 to 15-Dec-25" — surface when analysing conversion data in that window
2. **Product changes**: "Changed checkout flow layout on 20-Jan-26" — flag when comparing before/after metrics
3. **Incidents**: "Payment provider outage 5-Feb-26 14:00–18:00" — explain anomalies in funnel data
4. **Seasonal events**: "Black Friday 2025" — cross-workspace annotation for known traffic patterns

### 1.2 Key Requirements

| Requirement | Priority | Notes |
|-------------|----------|-------|
| Pin annotations to date ranges | Must | Point-in-time or start/end range |
| Optional param association | Should | Link to specific edges/nodes |
| Surface in query results UI | Must | Proactive disclosure when query overlaps |
| CRUD operations in DagNet | Must | Users can create/edit locally |
| Read from Notion table | Should | Sync team knowledge into DagNet |
| Write to Notion table | Could | Two-way sync (Phase 3) |

---

## 2. Data Model

### 2.1 TimelineAnnotation

```typescript
interface TimelineAnnotation {
  id: string;                    // UUID
  title: string;                 // Short description
  description?: string;          // Longer notes (markdown)
  
  // Time bounds
  start_date: string;            // ISO date (stored), display as d-MMM-yy
  end_date?: string;             // Optional - null means point-in-time
  
  // Classification
  annotation_type: AnnotationType;
  
  // Scope
  workspace_scope?: string;      // repo-branch, or null for global
  param_ids?: string[];          // Associated param IDs (edges/nodes)
  
  // Notion sync metadata
  notion_page_id?: string;       // For sync tracking
  notion_last_synced_at?: string;
  
  // Audit
  created_at: string;
  updated_at: string;
  created_by?: string;           // User identifier (future)
}

type AnnotationType = 
  | 'campaign'      // Marketing/growth campaigns
  | 'release'       // Product releases
  | 'incident'      // Outages, bugs, issues
  | 'experiment'    // A/B test periods (distinct from case() DSL)
  | 'seasonal'      // Black Friday, holidays, etc.
  | 'note';         // General annotation
```

### 2.2 Storage

**Local (IndexedDB)**:
- Store: `timeline_annotations`
- Key: `id`
- Indexed by: `start_date`, `end_date`, `workspace_scope`

**Notion (external)**:
- Database with properties mapped to annotation fields
- See §4.2 for schema mapping

---

## 3. Architecture

### 3.1 Service Layer

```
┌─────────────────────────────────────────────────────────────┐
│                    UI Components                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │AnnotationPanel│ │AnalyticsPanel│ │AnnotationMarkers │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
└─────────┼─────────────────┼───────────────────┼─────────────┘
          │                 │                   │
          ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│              timelineAnnotationService.ts                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │   CRUD     │  │  Query by  │  │  Notion Sync       │    │
│  │ Operations │  │ Date Range │  │  (read/write)      │    │
│  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘    │
└────────┼───────────────┼───────────────────┼────────────────┘
         │               │                   │
         ▼               ▼                   ▼
┌─────────────────┐            ┌─────────────────────────────┐
│   IndexedDB     │            │      Notion API             │
│ (local store)   │            │  (via DAS connection)       │
└─────────────────┘            └─────────────────────────────┘
```

### 3.2 Query Integration Flow

When a query executes:

1. **Extract date range** from query DSL
   - Window mode: `window.start` / `window.end`
   - Cohort mode: `cohort.start` / `cohort.end`

2. **Query annotation service**
   ```typescript
   const annotations = await timelineAnnotationService.getOverlapping({
     startDate: queryWindow.start,
     endDate: queryWindow.end,
     workspaceScope: currentWorkspace,
     paramIds: relevantParamIds  // Optional filter
   });
   ```

3. **Pass to result display**
   - AnalyticsPanel receives annotations alongside query results
   - Renders markers/indicators in chart
   - Populates sidebar panel if annotations exist

### 3.3 Service Interface

```typescript
interface TimelineAnnotationService {
  // CRUD
  create(annotation: Omit<TimelineAnnotation, 'id' | 'created_at' | 'updated_at'>): Promise<TimelineAnnotation>;
  update(id: string, updates: Partial<TimelineAnnotation>): Promise<TimelineAnnotation>;
  delete(id: string): Promise<void>;
  getById(id: string): Promise<TimelineAnnotation | null>;
  
  // Queries
  getAll(workspaceScope?: string): Promise<TimelineAnnotation[]>;
  getOverlapping(params: {
    startDate: string;
    endDate: string;
    workspaceScope?: string;
    paramIds?: string[];
    includeGlobal?: boolean;  // Include workspace_scope=null annotations
  }): Promise<TimelineAnnotation[]>;
  
  // Notion sync
  syncFromNotion(): Promise<SyncResult>;
  syncToNotion(annotation: TimelineAnnotation): Promise<void>;  // Phase 3
}
```

---

## 4. Notion Integration

### 4.1 Connection Configuration

Add to `connections.yaml`:

```yaml
- name: notion-annotations
  provider: notion
  kind: http
  auth_type: notion-integration
  description: "Timeline annotations from Notion database"
  enabled: true
  credsRef: notion
  capabilities:
    supports_native_exclude: false
    supports_visited: false
    supports_ordered: false
  defaults:
    api_version: "2022-06-28"
  connection_string_schema:
    type: object
    required: [database_id]
    properties:
      database_id:
        type: string
        description: "Notion database ID for annotations"
  adapter:
    request:
      url_template: "https://api.notion.com/v1/databases/{{{connection_string.database_id}}}/query"
      method: POST
      headers:
        Authorization: "Bearer {{credentials.notion_token}}"
        Notion-Version: "{{connection.api_version}}"
        Content-Type: "application/json"
      body_template: |
        {
          "filter": {
            "and": [
              {
                "property": "Start Date",
                "date": { "on_or_before": "{{window.end}}" }
              },
              {
                "or": [
                  { "property": "End Date", "date": { "on_or_after": "{{window.start}}" } },
                  { "property": "End Date", "date": { "is_empty": true } }
                ]
              }
            ]
          }
        }
    response:
      extract:
        - name: results
          jmes: "results"
    transform:
      - name: annotations
        jsonata: |
          results.{
            "notion_page_id": id,
            "title": properties.Name.title[0].plain_text,
            "description": properties.Description.rich_text[0].plain_text,
            "start_date": properties."Start Date".date.start,
            "end_date": properties."End Date".date.end,
            "annotation_type": properties.Type.select.name,
            "param_ids": properties."Param IDs".multi_select.name
          }
```

### 4.2 Notion Database Schema

Users should create a Notion database with these properties:

| Property | Type | Required | Notes |
|----------|------|----------|-------|
| Name | Title | Yes | Annotation title |
| Description | Text | No | Longer description |
| Start Date | Date | Yes | Can include time |
| End Date | Date | No | Leave empty for point-in-time |
| Type | Select | No | campaign, release, incident, experiment, seasonal, note |
| Param IDs | Multi-select | No | Associated DagNet param IDs |
| Workspace | Select | No | repo-branch scope, or "Global" |

### 4.3 Credentials

Add to `credentials.yaml`:

```yaml
notion:
  notion_token: "secret_xxx"  # Internal integration token
```

---

## 5. UI Design

### 5.1 Query Results Integration

**Inline Chart Markers**:
- Vertical dashed lines at annotation start/end dates
- Colour-coded by annotation type
- Hover tooltip shows title
- Click opens annotation detail

**Annotations Sidebar**:
- Collapsible panel in AnalyticsPanel
- Shows all overlapping annotations for current query
- Grouped by type
- Links to Notion page (if synced)

```
┌─────────────────────────────────────────────────────────────┐
│ Analysis Results                              [Annotations ▼]│
├─────────────────────────────────────────────────────────────┤
│                                                │ 📢 Campaign │
│   ┌────────────────────────────────────┐      │ FB Q4 Push  │
│   │         📊 Chart                    │      │ 1-Dec – 15-D│
│   │    |    |    |    |    |    |      │      │             │
│   │    | ┊  |  ┊ |    |    |    |      │      │ 🚀 Release  │
│   │    | ┊  |  ┊ |    |    |    |      │      │ Checkout v2 │
│   │    | ┊──┊──┊─┊    |    |    |      │      │ 20-Dec-25   │
│   │    |    |    |    |    |    |      │      │             │
│   └────────────────────────────────────┘      │ [+ Add]     │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Annotation Management Panel

Dedicated panel (accessible from app menu or sidebar) for:
- Viewing all annotations (filterable by type, workspace, date)
- Creating new annotations
- Editing existing annotations
- Manual Notion sync trigger
- Sync status indicator

---

## 6. Implementation Phases

### Phase 0: Foundation (Local-Only)

**Scope**:
- Data model and TypeScript types
- `timelineAnnotationService.ts` with IndexedDB storage
- Basic CRUD operations
- Simple list view UI (no query integration yet)

**Files**:
- `src/types/timelineAnnotation.ts`
- `src/services/timelineAnnotationService.ts`
- `src/components/panels/AnnotationManagementPanel.tsx`

**Value**: Establishes patterns, users can start annotating immediately.

### Phase 1: Query Integration

**Scope**:
- Hook into AnalyticsPanel query execution
- Extract date ranges from window/cohort DSL
- Query overlapping annotations
- Render markers in chart
- Annotations sidebar in results

**Files**:
- Modify `src/components/AnalyticsPanel.tsx`
- Add `src/components/charts/AnnotationMarkers.tsx`
- Add `src/components/panels/AnnotationsSidebar.tsx`

**Value**: Core feature realised — annotations surface contextually.

### Phase 2: Notion Read

**Scope**:
- Add `notion-annotations` connection to `connections.yaml`
- Notion credentials support in credentials manager
- One-way sync: Notion → IndexedDB
- Manual sync trigger in UI
- Sync status and error handling

**Files**:
- Modify `public/defaults/connections.yaml`
- Add Notion adapter logic
- Modify `timelineAnnotationService.ts` for sync
- Add sync UI to AnnotationManagementPanel

**Value**: Team knowledge from Notion visible in DagNet.

### Phase 3: Notion Write

**Scope**:
- Two-way sync: DagNet ↔ Notion
- Create annotations in DagNet, push to Notion
- Conflict detection (warn if Notion changed since last sync)
- Soft-delete handling

**Complexity**: Higher — requires careful conflict resolution.

**Value**: Single source of truth, annotations discoverable outside DagNet.

---

## 7. Open Questions

### 7.1 Scope Model

**Question**: Should annotations be workspace-scoped or global?

**Options**:
1. **Workspace-only**: Each repo-branch has its own annotations
2. **Global + Workspace**: Global annotations (Black Friday) visible everywhere, workspace-specific for project context
3. **Hierarchical**: Organisation → Workspace → Graph

**Recommendation**: Option 2 (Global + Workspace) — covers most use cases without complexity.

### 7.2 Query Matching Granularity

**Question**: How precise should annotation → query matching be?

**Options**:
1. **Date overlap only**: Any annotation overlapping query window
2. **Date + Param**: Only if annotation's `param_ids` includes queried params
3. **Smart matching**: Include annotations for upstream/downstream params

**Recommendation**: Start with Option 1 (simple), add Option 2 filter as enhancement.

### 7.3 Notion Database Ownership

**Question**: Who creates/owns the Notion database?

**Options**:
1. **User creates**: Document schema, user creates in their Notion workspace
2. **DagNet creates**: API call to create database with correct schema
3. **Template**: Provide Notion template link for duplication

**Recommendation**: Option 1 (document schema) for simplicity; consider template later.

### 7.4 Real-time vs Batch Sync

**Question**: How often to sync from Notion?

**Options**:
1. **On-demand**: User clicks "Sync" button
2. **On app load**: Sync when workspace loads
3. **Polling**: Background sync every N minutes
4. **Webhook**: Notion notifies on change (requires public endpoint)

**Recommendation**: Start with Option 1 + 2 (manual + on-load). Polling adds complexity; webhooks require infrastructure.

---

## 8. Risk Assessment

| Component | Complexity | Risk | Mitigation |
|-----------|------------|------|------------|
| Data model & service | Low | Low | Follows existing patterns |
| IndexedDB storage | Low | Low | Well-established in codebase |
| Query date extraction | Medium | Low | Window/cohort parsing exists |
| UI surfacing in results | Medium | Medium | Iterative design, user feedback |
| Notion read integration | Medium | Medium | New provider, test thoroughly |
| Notion write + sync | High | High | Defer to Phase 3, simple conflict model |

---

## 9. Dependencies

- **Notion API access**: Requires Notion integration token with database access
- **Chart library support**: Need to verify annotation marker rendering in current chart components
- **IndexedDB schema migration**: Adding new object store

---

## 10. Future Considerations

- **Annotation templates**: Pre-defined annotation types with common fields
- **Bulk import**: CSV/JSON import for historical annotations
- **Annotation analytics**: "Show me all campaigns and their impact on conversion"
- **Slack integration**: Post annotation summaries to Slack channels
- **Annotation sharing**: Share specific annotations via URL
