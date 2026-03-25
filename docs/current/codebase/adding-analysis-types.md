# Adding a New Analysis Type

**Date**: 25-Mar-26

Checklist for adding a new analysis type with chart rendering.
Follow exactly — no improvisation needed.

---

## 1. Register the analysis type

**File**: `graph-editor/src/components/panels/analysisTypes.ts`

Add an entry to the `ANALYSIS_TYPES` array:

```typescript
{
  id: 'my_analysis',
  name: 'My Analysis',
  shortDescription: 'One-line description',
  selectionHint: 'Use from(a).to(b)',
  icon: SomeLucideIcon,
  // Only include snapshotContract if the analysis needs snapshot DB data.
  // Omit entirely for local-compute-only types.
}
```

**Rules**:
- No `snapshotContract` → local FE compute, no snapshot pipeline
- With `snapshotContract` → goes through snapshot boot, subject
  resolution, and BE `handle_stats_enhance`

---

## 2. Map analysis type to chart kinds

**File**: `graph-editor/src/services/analysisTypeResolutionService.ts`

Add to `CHART_KINDS_BY_ANALYSIS_TYPE`:

```typescript
my_analysis: ['my_analysis', 'table'],
```

The first entry is the default chart kind. `'table'` gives the user
a table view option for free.

---

## 3. Inject into available analyses

**File**: `graph-editor/src/services/analysisTypeResolutionService.ts`

In `injectLocalAnalysisTypes()`, add the condition under which this
analysis type should appear in the dropdown:

```typescript
if (/* condition, e.g. parsed.from && parsed.to */) {
  analyses.push({
    id: 'my_analysis',
    name: 'My Analysis',
    description: '...',
    is_primary: false,
    chart_kinds: getChartKindsForAnalysisType('my_analysis'),
  });
}
```

---

## 4. Add the chart kind to the type system

**File**: `graph-editor/src/components/charts/AnalysisChartContainer.tsx`

Three places:

### 4a. ChartKind union type

```typescript
type ChartKind = '...' | 'my_analysis';
```

### 4b. normaliseChartKind

```typescript
if (kind === 'my_analysis') return 'my_analysis';
```

### 4c. inferredChartKind

```typescript
if (t === 'my_analysis') return 'my_analysis';
```

### 4d. labelForChartKind

```typescript
if (kind === 'my_analysis') return 'My Analysis';
```

---

## 5. Build the result

### For local-compute types (no snapshot data needed):

**File**: `graph-editor/src/services/localAnalysisComputeService.ts`

1. Add to `LOCAL_COMPUTE_TYPES`:
   ```typescript
   const LOCAL_COMPUTE_TYPES = new Set([..., 'my_analysis']);
   ```

2. Add case to `computeLocalResult`:
   ```typescript
   case 'my_analysis':
     return { success: true, result: buildMyAnalysisResult(graph, queryDsl) };
   ```

3. Implement the builder. **CRITICAL**: the result MUST include
   `semantics.chart.recommended`:
   ```typescript
   function buildMyAnalysisResult(graph, queryDsl): AnalysisResult {
     return {
       analysis_type: 'my_analysis',
       analysis_name: 'My Analysis',
       semantics: {
         chart: { recommended: 'my_analysis' },  // ← REQUIRED
         dimensions: [...],
         metrics: [...],
       },
       data: [...],
     };
   }
   ```

   Without `semantics.chart.recommended`, the chart container cannot
   resolve the chart kind and nothing will render.

### For snapshot-based types:

Handle in `graph-editor/lib/api_handlers.py` inside
`handle_stats_enhance`, keyed on `analysis_type`. The BE result
must also include `semantics.chart.recommended`.

---

## 6. Build the ECharts option

**File**: Create `graph-editor/src/services/analysisECharts/myAnalysisBuilder.ts`

Export a builder function:

```typescript
export function buildMyAnalysisEChartsOption(
  result: any,
  settings: Record<string, any>,
): any | null {
  // Return an ECharts option object, or null if data is insufficient
}
```

### Wire into dispatcher

**File**: `graph-editor/src/services/analysisEChartsService.ts`

1. Import the builder
2. Add case to `buildChartOption`:
   ```typescript
   case 'my_analysis':
     opt = buildMyAnalysisEChartsOption(result, resolvedSettings);
     break;
   ```

---

## 7. Add display settings

**File**: `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`

Add an entry to `CHART_DISPLAY_SETTINGS`:

```typescript
my_analysis: [
  ...COMMON_FONT_SIZE_SETTINGS,
  ...COMMON_LEGEND_SETTINGS,
  // analysis-specific settings:
  {
    key: 'my_setting',
    label: 'My Setting',
    type: 'radio',
    options: [...],
    defaultValue: '...',
    propsPanel: true,
    inline: 'brief',
    contextMenu: false,
    computeAffecting: false,
  },
  ...COMMON_TOOLTIP_SETTINGS,
  ...COMMON_ANIMATION_SETTINGS,
],
```

---

## 8. For snapshot-based types only

### 8a. Snapshot boot trace

**File**: `graph-editor/src/lib/snapshotBootTrace.ts`

Add to `isSnapshotBootChart`:

```typescript
if (analysisType === 'my_analysis') return true;
```

### 8b. Backend handler

**File**: `graph-editor/lib/api_handlers.py`

Add routing in `handle_stats_enhance` inside the per-subject loop,
keyed on `analysis_type` or `read_mode`.

---

## Summary: minimum file touches

| Type | Files to touch |
|------|---------------|
| Local compute + ECharts | 6 files: analysisTypes.ts, analysisTypeResolutionService.ts, AnalysisChartContainer.tsx, localAnalysisComputeService.ts, new builder .ts, analysisEChartsService.ts |
| + display settings | +1: analysisDisplaySettingsRegistry.ts |
| Snapshot-based | +2: snapshotBootTrace.ts, api_handlers.py |

---

## Common mistakes

1. **Forgetting `semantics.chart.recommended`** in the result builder.
   Without it, chart kind is undefined and nothing renders.

2. **Forgetting `inferredChartKind`** mapping in AnalysisChartContainer.
   The chart kind must be inferrable from the result's analysis_type.

3. **Adding `snapshotContract` when not needed.** If the analysis only
   reads from the in-memory graph, omit it. The snapshot pipeline adds
   complexity (boot coordination, subject resolution, BE round-trip).

4. **Not adding to `CHART_KINDS_BY_ANALYSIS_TYPE`.** The analysis won't
   appear in chart kind dropdowns without this mapping.
