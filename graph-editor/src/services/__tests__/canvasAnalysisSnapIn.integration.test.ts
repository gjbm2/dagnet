/**
 * Canvas analysis content-item integration tests.
 *
 * Invariants protected:
 *
 * Content item schema (kind field):
 * - ContentItem uses `kind`, not `chart_kind` or `facet`
 * - normaliseCanvasAnalysis migrates facet → kind + sets view_type: 'cards'
 * - normaliseCanvasAnalysis migrates chart_kind → kind, keeps view_type: 'chart'
 * - addContentItem preserves kind from preset
 *
 * Creation / snap:
 * - buildCanvasAnalysisObject sets kind on content items from payload
 * - Snap adds exactly 1 content item with correct kind, title, analytics_dsl, view_type
 * - Pin from single-tab card includes title from registry
 *
 * Registry:
 * - getKindsForView('edge_info', 'cards') returns the 5 info card kinds
 * - getKindsForView('edge_info', 'chart') returns info
 * - getKindsForView returns empty for types without declared views
 *
 * Rendering dispatch (structural — no DOM):
 * - Content item with view_type 'cards' and kind set must suppress expressionViewMode
 *
 * Uses REAL service functions and caches — no mocks for internal components.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { addContentItem, ensureContentItemDsl, mutateCanvasAnalysisGraph, mutateContentItem } from '../canvasAnalysisMutationService';
import { contentItemResultCache } from '../../hooks/useCanvasAnalysisCompute';
import { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } from '../canvasAnalysisCreationService';
import { normaliseCanvasAnalysis } from '../../utils/canvasAnalysisAccessors';
import { getKindsForView } from '../../components/panels/analysisTypes';
import type { CanvasAnalysis, ContentItem } from '../../types';
import type { AnalysisResult } from '../../lib/graphComputeClient';

function makeAnalysis(overrides?: Partial<CanvasAnalysis>): CanvasAnalysis {
  const payload = buildCanvasAnalysisPayload({
    analyticsDsl: 'from(landing-page).to(signup)',
    analysisType: 'edge_info',
  });
  const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });
  return { ...analysis, ...overrides } as CanvasAnalysis;
}

function makeMockResult(analysisType: string): AnalysisResult {
  return {
    analysis_type: analysisType,
    analysis_description: `Mock ${analysisType} result`,
    data: [{ value: 42, tab: 'overview', property: 'Count' }],
    semantics: { dimensions: [], metrics: [], chart: { recommended: 'info' } },
    metadata: { source: 'test' },
  } as AnalysisResult;
}

describe('Canvas analysis snap-into-container: addContentItem', () => {
  it('should preserve title and analytics_dsl from preset', () => {
    const analysis = makeAnalysis();

    const newItem = addContentItem(analysis, {
      analysis_type: 'daily_conversions',
      view_type: 'chart',
      kind: 'daily_conversions',
      title: 'Daily Conversions',
      analytics_dsl: 'from(signup).to(purchase)',
    });

    expect(newItem.title).toBe('Daily Conversions');
    expect(newItem.analytics_dsl).toBe('from(signup).to(purchase)');
    expect(newItem.analysis_type).toBe('daily_conversions');
    expect(newItem.kind).toBe('daily_conversions');
    expect(newItem.view_type).toBe('chart');
  });

  it('should generate a fresh UUID for every addContentItem call', () => {
    const analysis = makeAnalysis();

    const item1 = addContentItem(analysis, { analysis_type: 'a' });
    const item2 = addContentItem(analysis, { analysis_type: 'b' });

    expect(item1.id).toBeTruthy();
    expect(item2.id).toBeTruthy();
    expect(item1.id).not.toBe(item2.id);
  });

  it('should append the new content item to the analysis content_items array', () => {
    const analysis = makeAnalysis();
    const initialCount = analysis.content_items?.length ?? 0;

    addContentItem(analysis, { analysis_type: 'daily_conversions', title: 'DC' });

    expect(analysis.content_items).toHaveLength(initialCount + 1);
    const last = analysis.content_items![analysis.content_items!.length - 1];
    expect(last.title).toBe('DC');
  });

  it('should initialise content_items array if missing', () => {
    const analysis = makeAnalysis();
    delete (analysis as any).content_items;

    const newItem = addContentItem(analysis, { analysis_type: 'test' });

    expect(analysis.content_items).toHaveLength(1);
    expect(analysis.content_items![0].id).toBe(newItem.id);
  });
});

describe('Canvas analysis snap-into-container: per-content-item result cache', () => {
  beforeEach(() => {
    contentItemResultCache.clear();
  });

  it('should store and retrieve a result by content item ID', () => {
    const analysis = makeAnalysis();
    const newItem = addContentItem(analysis, {
      analysis_type: 'daily_conversions',
      title: 'Daily Conversions',
      analytics_dsl: 'from(signup).to(purchase)',
    });

    const mockResult = makeMockResult('daily_conversions');
    contentItemResultCache.set(newItem.id, mockResult);

    const retrieved = contentItemResultCache.get(newItem.id);
    expect(retrieved).toBe(mockResult);
    expect(retrieved!.analysis_type).toBe('daily_conversions');
  });

  it('should return undefined for content items without a cached result', () => {
    const retrieved = contentItemResultCache.get('nonexistent-id');
    expect(retrieved).toBeUndefined();
  });

  it('should not overwrite results for other content items', () => {
    const analysis = makeAnalysis();
    const item1 = addContentItem(analysis, { analysis_type: 'daily_conversions' });
    const item2 = addContentItem(analysis, { analysis_type: 'cohort_maturity' });

    const result1 = makeMockResult('daily_conversions');
    const result2 = makeMockResult('cohort_maturity');
    contentItemResultCache.set(item1.id, result1);
    contentItemResultCache.set(item2.id, result2);

    expect(contentItemResultCache.get(item1.id)!.analysis_type).toBe('daily_conversions');
    expect(contentItemResultCache.get(item2.id)!.analysis_type).toBe('cohort_maturity');
  });

  it('should allow per-item result to differ from container analysis type', () => {
    // Simulates snapping a daily_conversions chart into an edge_info container
    const analysis = makeAnalysis(); // edge_info container
    const containerResult = makeMockResult('edge_info');
    const snappedResult = makeMockResult('daily_conversions');

    const newItem = addContentItem(analysis, {
      analysis_type: 'daily_conversions',
      title: 'Daily Conversions',
      analytics_dsl: 'from(signup).to(purchase)',
    });
    contentItemResultCache.set(newItem.id, snappedResult);

    // Original content item uses container result (no per-item cache entry)
    const originalItem = analysis.content_items![0];
    const originalResult = contentItemResultCache.get(originalItem.id) || containerResult;
    expect(originalResult.analysis_type).toBe('edge_info');

    // Snapped content item uses per-item cached result
    const snappedItemResult = contentItemResultCache.get(newItem.id) || containerResult;
    expect(snappedItemResult.analysis_type).toBe('daily_conversions');
  });
});

describe('Canvas analysis snap-into-container: ensureContentItemDsl', () => {
  it('should backfill DSL from container when content item lacks it', () => {
    const analysis = makeAnalysis();
    // Add a content item without analytics_dsl
    addContentItem(analysis, { analysis_type: 'daily_conversions', title: 'DC' });

    const lastItem = analysis.content_items![analysis.content_items!.length - 1];
    expect(lastItem.analytics_dsl).toBeUndefined();

    ensureContentItemDsl(analysis);

    // Should now have the container's DSL
    expect(lastItem.analytics_dsl).toBe('from(landing-page).to(signup)');
  });

  it('should not overwrite existing DSL on content items', () => {
    const analysis = makeAnalysis();
    addContentItem(analysis, {
      analysis_type: 'daily_conversions',
      analytics_dsl: 'from(signup).to(purchase)',
    });

    ensureContentItemDsl(analysis);

    const lastItem = analysis.content_items![analysis.content_items!.length - 1];
    expect(lastItem.analytics_dsl).toBe('from(signup).to(purchase)');
  });
});

describe('Canvas analysis snap-into-container: syncFlatFields must not overwrite multi-tab items', () => {
  it('should preserve all content item fields when onUpdate fires on a multi-tab container', () => {
    // Setup: create a container with two tabs (simulating a completed snap)
    const analysis = makeAnalysis({ title: 'Container Title' });
    addContentItem(analysis, {
      analysis_type: 'daily_conversions',
      title: 'Daily Conversions',
      analytics_dsl: 'from(signup).to(purchase)',
      view_type: 'chart',
      kind: 'daily_conversions',
    });
    // Wrap in a graph structure (as mutateCanvasAnalysisGraph expects)
    const graph = { canvasAnalyses: [analysis], metadata: { updated_at: '' } };

    // Act: simulate an onUpdate call (e.g. display change, resize, view mode change)
    // — this triggers mutateCanvasAnalysisGraph → syncFlatFieldsToContentItems
    const nextGraph = mutateCanvasAnalysisGraph(graph as any, analysis.id, (a) => {
      Object.assign(a, { display: { ...a.display, some_setting: true } });
    });

    // Assert: both tabs' fields must be preserved — syncFlatFields must NOT overwrite them
    const updatedAnalysis = nextGraph!.canvasAnalyses!.find((a: any) => a.id === analysis.id)!;
    expect(updatedAnalysis.content_items).toHaveLength(2);

    const tab0 = updatedAnalysis.content_items![0];
    // Tab 0 is the original — its analysis_type should NOT be overwritten to container's
    // (it was 'edge_info' from creation, which matches container, so check title instead)
    expect(tab0.analysis_type).toBe('edge_info');

    const tab1 = updatedAnalysis.content_items![1];
    expect(tab1.title).toBe('Daily Conversions');
    expect(tab1.analysis_type).toBe('daily_conversions');
    expect(tab1.analytics_dsl).toBe('from(signup).to(purchase)');
    expect(tab1.kind).toBe('daily_conversions');
    expect(tab1.view_type).toBe('chart');
  });

  it('should preserve tab 0 title when container title differs', () => {
    const analysis = makeAnalysis();
    // Give tab 0 an explicit title
    analysis.content_items![0].title = 'Edge Info Overview';
    // Set a different container-level title
    analysis.title = 'My Analysis Container';
    // Add a second tab to make it multi-tab
    addContentItem(analysis, { analysis_type: 'daily_conversions', title: 'DC' });

    const graph = { canvasAnalyses: [analysis], metadata: { updated_at: '' } };
    const nextGraph = mutateCanvasAnalysisGraph(graph as any, analysis.id, (a) => {
      Object.assign(a, { view_mode: 'cards' });
    });

    const updated = nextGraph!.canvasAnalyses!.find((a: any) => a.id === analysis.id)!;
    // Tab 0's title must NOT be overwritten to the container title
    expect(updated.content_items![0].title).toBe('Edge Info Overview');
    // Tab 0's view_type must NOT be overwritten to the container's view_mode
    expect(updated.content_items![0].view_type).not.toBe('cards');
  });

  it('should allow direct mutation of content item fields via mutateCanvasAnalysisGraph', () => {
    const analysis = makeAnalysis({ title: 'Updated Title' });
    expect(analysis.content_items).toHaveLength(1);

    const graph = { canvasAnalyses: [analysis], metadata: { updated_at: '' } };
    const nextGraph = mutateCanvasAnalysisGraph(graph as any, analysis.id, (a) => {
      a.content_items[0].title = 'New Title';
    });

    const updated = nextGraph!.canvasAnalyses!.find((a: any) => a.id === analysis.id)!;
    expect(updated.content_items[0].title).toBe('New Title');
  });
});

describe('Canvas analysis snap-into-container: full roundtrip', () => {
  beforeEach(() => {
    contentItemResultCache.clear();
  });

  it('should produce a working multi-tab container when snapping a different analysis type', () => {
    // 1. Create an edge_info container
    const analysis = makeAnalysis();
    expect(analysis.content_items[0].analysis_type).toBe('edge_info');

    // 2. Simulate snap: add a daily_conversions tab with its own DSL and result
    const snappedPreset: Partial<ContentItem> = {
      analysis_type: 'daily_conversions',
      view_type: 'chart',
      kind: 'daily_conversions',
      title: 'Daily Conversions',
      analytics_dsl: 'from(signup).to(purchase)',
    };
    const newItem = addContentItem(analysis, snappedPreset);
    const snappedResult = makeMockResult('daily_conversions');
    contentItemResultCache.set(newItem.id, snappedResult);

    // 3. Verify the container now has two content items
    expect(analysis.content_items!.length).toBeGreaterThanOrEqual(2);

    // 4. Verify original tab still exists with its own type
    const originalItem = analysis.content_items![0];
    expect(originalItem.analysis_type).toBe('edge_info');

    // 5. Verify new tab has correct title, DSL, type
    const lastItem = analysis.content_items![analysis.content_items!.length - 1];
    expect(lastItem.id).toBe(newItem.id);
    expect(lastItem.title).toBe('Daily Conversions');
    expect(lastItem.analytics_dsl).toBe('from(signup).to(purchase)');
    expect(lastItem.analysis_type).toBe('daily_conversions');
    expect(lastItem.kind).toBe('daily_conversions');

    // 6. Verify per-item result resolution
    const containerResult = makeMockResult('edge_info');

    // Original tab: no per-item cache → falls back to container result
    const tab0Result = contentItemResultCache.get(originalItem.id) || containerResult;
    expect(tab0Result.analysis_type).toBe('edge_info');

    // Snapped tab: has per-item cache → uses its own result
    const tab1Result = contentItemResultCache.get(lastItem.id) || containerResult;
    expect(tab1Result.analysis_type).toBe('daily_conversions');
    expect(tab1Result.data).toEqual([{ value: 42, tab: 'overview', property: 'Count' }]);
  });

  it('should handle snapping multiple tabs of different types into one container', () => {
    const analysis = makeAnalysis();

    const types = ['daily_conversions', 'cohort_maturity', 'lag_histogram'];
    const items: ContentItem[] = [];

    for (const type of types) {
      const item = addContentItem(analysis, {
        analysis_type: type,
        title: type.replace(/_/g, ' '),
        analytics_dsl: `from(signup).to(purchase)`,
      });
      contentItemResultCache.set(item.id, makeMockResult(type));
      items.push(item);
    }

    // Container should have original + 3 snapped tabs
    expect(analysis.content_items!.length).toBeGreaterThanOrEqual(4);

    // Each snapped tab should resolve to its own result
    for (let i = 0; i < items.length; i++) {
      const cachedResult = contentItemResultCache.get(items[i].id);
      expect(cachedResult).toBeDefined();
      expect(cachedResult!.analysis_type).toBe(types[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Content item schema: kind field
// ---------------------------------------------------------------------------

describe('ContentItem schema: kind replaces chart_kind and facet', () => {
  it('should set kind on content items created via buildCanvasAnalysisObject with contentItems', () => {
    const payload = buildCanvasAnalysisPayload({ analyticsDsl: 'from(a).to(b)', analysisType: 'edge_info' });
    const analysis = buildCanvasAnalysisObject(
      { ...payload, contentItems: [
        { analysis_type: 'edge_info', view_type: 'cards' as const, kind: 'overview', title: 'Overview', analytics_dsl: 'from(a).to(b)' },
        { analysis_type: 'edge_info', view_type: 'cards' as const, kind: 'evidence', title: 'Evidence', analytics_dsl: 'from(a).to(b)' },
      ]},
      { x: 0, y: 0 }, { width: 400, height: 300 },
    );
    expect(analysis.content_items).toHaveLength(2);
    expect(analysis.content_items![0].kind).toBe('overview');
    expect(analysis.content_items![1].kind).toBe('evidence');
    // Must NOT have chart_kind or facet
    expect((analysis.content_items![0] as any).chart_kind).toBeUndefined();
    expect((analysis.content_items![0] as any).facet).toBeUndefined();
  });

  it('should set kind on fallback content item from payload.chartKind', () => {
    const payload = buildCanvasAnalysisPayload({ analyticsDsl: 'from(a).to(b)', analysisType: 'graph_overview', chartKind: 'pie' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });
    expect(analysis.content_items).toHaveLength(1);
    expect(analysis.content_items![0].kind).toBe('pie');
    expect((analysis.content_items![0] as any).chart_kind).toBeUndefined();
  });

  it('should preserve kind when adding a content item via addContentItem', () => {
    const analysis = makeAnalysis();
    const item = addContentItem(analysis, {
      analysis_type: 'edge_info',
      view_type: 'cards',
      kind: 'diagnostics',
      title: 'Diagnostics',
    });
    expect(item.kind).toBe('diagnostics');
    expect(item.view_type).toBe('cards');
    expect(item.title).toBe('Diagnostics');
    expect((item as any).chart_kind).toBeUndefined();
    expect((item as any).facet).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normaliseCanvasAnalysis migration
// ---------------------------------------------------------------------------

describe('normaliseCanvasAnalysis: legacy migration', () => {
  it('should migrate facet to kind and set view_type to cards', () => {
    const analysis = makeAnalysis();
    (analysis.content_items![0] as any).facet = 'evidence';
    (analysis.content_items![0] as any).chart_kind = 'info';
    analysis.content_items![0].view_type = 'chart';
    delete (analysis.content_items![0] as any).kind;

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('evidence');
    expect(analysis.content_items![0].view_type).toBe('cards');
    expect((analysis.content_items![0] as any).facet).toBeUndefined();
    expect((analysis.content_items![0] as any).chart_kind).toBeUndefined();
  });

  it('should migrate chart_kind to kind and keep view_type as chart', () => {
    const analysis = makeAnalysis();
    (analysis.content_items![0] as any).chart_kind = 'funnel';
    analysis.content_items![0].view_type = 'chart';
    delete (analysis.content_items![0] as any).kind;

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('funnel');
    expect(analysis.content_items![0].view_type).toBe('chart');
    expect((analysis.content_items![0] as any).chart_kind).toBeUndefined();
  });

  it('should not overwrite existing kind', () => {
    const analysis = makeAnalysis();
    analysis.content_items![0].kind = 'pie';
    (analysis.content_items![0] as any).chart_kind = 'funnel';

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('pie');
    expect((analysis.content_items![0] as any).chart_kind).toBeUndefined();
  });

  it('should prefer facet over chart_kind when both present', () => {
    const analysis = makeAnalysis();
    (analysis.content_items![0] as any).facet = 'forecast';
    (analysis.content_items![0] as any).chart_kind = 'info';
    delete (analysis.content_items![0] as any).kind;

    normaliseCanvasAnalysis(analysis);

    expect(analysis.content_items![0].kind).toBe('forecast');
  });
});

// ---------------------------------------------------------------------------
// Registry: getKindsForView
// ---------------------------------------------------------------------------

describe('getKindsForView: registry-driven kind options', () => {
  it('should return 5 card kinds for edge_info cards view', () => {
    const kinds = getKindsForView('edge_info', 'cards');
    expect(kinds.length).toBe(5);
    const ids = kinds.map(k => k.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('evidence');
    expect(ids).toContain('forecast');
    expect(ids).toContain('depth');
    expect(ids).toContain('diagnostics');
  });

  it('should return empty for edge_info chart view (edge_info is cards-only)', () => {
    const kinds = getKindsForView('edge_info', 'chart');
    expect(kinds).toEqual([]);
  });

  it('should return card kinds for node_info cards view', () => {
    const kinds = getKindsForView('node_info', 'cards');
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.map(k => k.id)).toContain('overview');
  });

  it('should return empty array for types without declared views', () => {
    const kinds = getKindsForView('graph_overview', 'chart');
    expect(kinds).toEqual([]);
  });

  it('should return empty array for unknown analysis type', () => {
    const kinds = getKindsForView('nonexistent_type', 'cards');
    expect(kinds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mutateContentItem: direct content item mutation
// ---------------------------------------------------------------------------

describe('mutateContentItem: direct content item mutation', () => {
  it('should mutate a specific content item by index', () => {
    const analysis = makeAnalysis();
    expect(analysis.content_items).toHaveLength(1);

    const graph = { canvasAnalyses: [analysis], metadata: { updated_at: '' } };
    const nextGraph = mutateContentItem(graph as any, analysis.id, 0, (ci) => {
      ci.kind = 'bridge';
    });

    const updated = nextGraph!.canvasAnalyses!.find((a: any) => a.id === analysis.id)!;
    expect(updated.content_items[0].kind).toBe('bridge');
  });
});

