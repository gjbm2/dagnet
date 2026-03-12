import React, { useMemo, useCallback, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type SortChangedEvent,
  type ColumnResizedEvent,
  type ColumnMovedEvent,
  type ColumnVisibleEvent,
} from 'ag-grid-community';
import type { AnalysisResult } from '../../lib/graphComputeClient';
import { resolveFontSizePx } from '../../lib/analysisDisplaySettingsRegistry';

// Register AG Grid modules once at module scope.
ModuleRegistry.registerModules([AllCommunityModule]);

// ---------------------------------------------------------------------------
// Public types (kept for backward compat with other importers)
// ---------------------------------------------------------------------------

export interface ColumnDef {
  key: string;
  label: string;
  numeric: boolean;
  format?: string;
  dimId?: string;
}

export interface AnalysisResultTableProps {
  result: AnalysisResult;
  /** Font size: numeric px, or legacy preset 'S'/'M'/'L'/'XL'. */
  fontSize?: number | string;
  striped?: boolean;
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  onSortChange?: (column: string, direction: 'asc' | 'desc') => void;
  hiddenColumns?: string[];
  onHiddenColumnsChange?: (hidden: string[]) => void;
  columnOrder?: string[];
  onColumnOrderChange?: (order: string[]) => void;
  /** Column widths as JSON string: Record<string, number> (px). */
  columnWidths?: string;
  onColumnWidthsChange?: (widths: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: number | null | undefined, format?: string): string {
  if (value === null || value === undefined) return '\u2014';
  if (!Number.isFinite(value)) return String(value);
  switch (format) {
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'currency_gbp':
      return `\u00A3${value.toFixed(2)}`;
    default:
      return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
}

// ---------------------------------------------------------------------------
// Theme — compact, matching canvas font conventions (S=8, M=9, L=10).
// ---------------------------------------------------------------------------

function buildTheme(fontPx: number, isDark: boolean) {
  const base = themeQuartz.withParams({
    fontSize: fontPx,
    headerHeight: Math.max(22, fontPx + 14),
    rowHeight: Math.max(20, fontPx + 12),
    spacing: 2,
    borderRadius: 0,
    wrapperBorderRadius: 0,
    headerColumnBorder: true,
    ...(isDark ? {
      backgroundColor: 'transparent',
      headerBackgroundColor: 'rgba(255,255,255,0.04)',
      oddRowBackgroundColor: 'rgba(255,255,255,0.02)',
      borderColor: 'rgba(255,255,255,0.08)',
      headerFontWeight: 600,
      foregroundColor: 'var(--text-primary, #e5e7eb)',
    } : {
      backgroundColor: 'transparent',
      headerBackgroundColor: 'rgba(0,0,0,0.02)',
      oddRowBackgroundColor: 'rgba(0,0,0,0.015)',
      borderColor: 'rgba(0,0,0,0.08)',
      headerFontWeight: 600,
      foregroundColor: 'var(--text-primary, #374151)',
    }),
  });
  return base;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const AnalysisResultTable = React.memo(function AnalysisResultTable(props: AnalysisResultTableProps): JSX.Element | null {
  const {
    result, fontSize = 'S',
    sortColumn, sortDirection = 'asc', onSortChange,
    hiddenColumns, onHiddenColumnsChange,
    columnOrder: columnOrderProp, onColumnOrderChange,
    columnWidths: columnWidthsStr, onColumnWidthsChange,
  } = props;

  const gridRef = useRef<AgGridReact>(null);

  // Detect dark mode from document attribute.
  const isDark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark';
  const fontPx = resolveFontSizePx(fontSize);

  const theme = useMemo(() => buildTheme(fontPx, isDark), [fontPx, isDark]);

  // Parse persisted widths.
  const persistedWidths = useMemo<Record<string, number>>(() => {
    if (!columnWidthsStr) return {};
    try { return JSON.parse(columnWidthsStr); } catch { return {}; }
  }, [columnWidthsStr]);

  const hiddenSet = useMemo(() => new Set(hiddenColumns || []), [hiddenColumns]);

  // ---- Build our column metadata from result semantics ----
  const columnMeta = useMemo((): ColumnDef[] => {
    const dims = result.semantics?.dimensions || [];
    const metrics = result.semantics?.metrics || [];
    const defs: ColumnDef[] = [];
    for (const d of dims) {
      const hasLabels = !!result.dimension_values?.[d.id];
      defs.push({ key: d.id, label: d.name || d.id, numeric: false });
      if (hasLabels) {
        defs.push({ key: `${d.id}__label`, label: `${d.name || d.id} (label)`, numeric: false, dimId: d.id });
      }
    }
    for (const m of metrics) {
      defs.push({ key: m.id, label: m.name || m.id, numeric: true, format: m.format });
    }
    return defs;
  }, [result.semantics, result.dimension_values]);

  // ---- Build AG Grid ColDefs ----
  // Order respects columnOrderProp; applies persisted widths, sort, and visibility.
  const agColumnDefs = useMemo((): ColDef[] => {
    let ordered = columnMeta;
    if (columnOrderProp && columnOrderProp.length > 0) {
      const orderMap = new Map(columnOrderProp.map((k, i) => [k, i]));
      ordered = [...columnMeta].sort((a, b) => {
        const ai = orderMap.get(a.key) ?? 9999;
        const bi = orderMap.get(b.key) ?? 9999;
        return ai - bi;
      });
    }

    // Scale default column width with font size: smaller font → narrower columns.
    const defaultColWidth = Math.round(fontPx * 10); // S=80, M=90, L=100

    return ordered.map((col): ColDef => {
      const def: ColDef = {
        field: col.key,
        headerName: col.label,
        sortable: !!onSortChange,
        resizable: !!onColumnWidthsChange,
        suppressMovable: !onColumnOrderChange,
        hide: hiddenSet.has(col.key),
        type: col.numeric ? 'numericColumn' : undefined,
        width: defaultColWidth,
      };

      // Apply persisted width (overrides default).
      const w = persistedWidths[col.key];
      if (w) def.width = w;

      // Apply persisted sort.
      if (sortColumn === col.key) {
        def.sort = sortDirection === 'desc' ? 'desc' : 'asc';
      }

      // Value formatter for numeric columns.
      if (col.numeric) {
        def.valueFormatter = (params) => formatValue(params.value, col.format);
      }

      return def;
    });
  }, [columnMeta, columnOrderProp, persistedWidths, sortColumn, sortDirection, hiddenSet, onSortChange, onColumnWidthsChange, onColumnOrderChange, fontPx]);

  // ---- Build row data ----
  const rowData = useMemo(() => {
    const data = result.data || [];
    if (data.length === 0) return [];

    return data.map((row: any) => {
      const processed: Record<string, any> = {};
      for (const col of columnMeta) {
        if (col.dimId) {
          const rawVal = row[col.dimId];
          const meta = result.dimension_values?.[col.dimId]?.[String(rawVal)];
          processed[col.key] = (meta as any)?.name ?? String(rawVal ?? '');
        } else if (col.numeric) {
          processed[col.key] = row[col.key] ?? null;
        } else {
          processed[col.key] = row[col.key] ?? '';
        }
      }
      return processed;
    });
  }, [result, columnMeta]);

  // ---- Event handlers — persist state changes back to parent ----

  const handleSortChanged = useCallback((event: SortChangedEvent) => {
    if (!onSortChange) return;
    const sortModel = event.api.getColumnState().filter(c => c.sort);
    if (sortModel.length > 0) {
      onSortChange(sortModel[0].colId, sortModel[0].sort === 'desc' ? 'desc' : 'asc');
    }
  }, [onSortChange]);

  const handleColumnResized = useCallback((event: ColumnResizedEvent) => {
    if (!onColumnWidthsChange || !event.finished) return;
    const widths: Record<string, number> = {};
    event.api.getColumnState().forEach(c => {
      if (c.width) widths[c.colId] = c.width;
    });
    onColumnWidthsChange(JSON.stringify(widths));
  }, [onColumnWidthsChange]);

  const handleColumnMoved = useCallback((event: ColumnMovedEvent) => {
    if (!onColumnOrderChange || !event.finished) return;
    const order = event.api.getColumnState().map(c => c.colId);
    onColumnOrderChange(order);
  }, [onColumnOrderChange]);

  const handleColumnVisible = useCallback((event: ColumnVisibleEvent) => {
    if (!onHiddenColumnsChange) return;
    const hidden = event.api.getColumnState()
      .filter(c => c.hide)
      .map(c => c.colId);
    onHiddenColumnsChange(hidden);
  }, [onHiddenColumnsChange]);

  // ---- Hidden columns restore bar ----
  const showAllColumns = useCallback(() => {
    if (onHiddenColumnsChange) onHiddenColumnsChange([]);
  }, [onHiddenColumnsChange]);

  const showColumn = useCallback((colKey: string) => {
    if (!onHiddenColumnsChange) return;
    onHiddenColumnsChange((hiddenColumns || []).filter(k => k !== colKey));
  }, [hiddenColumns, onHiddenColumnsChange]);

  // ---- Render ----
  if (columnMeta.length === 0 || rowData.length === 0) return null;

  const hiddenCount = hiddenSet.size;

  return (
    // nodrag + nowheel: tell ReactFlow to leave this subtree alone.
    // stopPropagation: belt-and-suspenders — no mousedown reaches the node handler.
    <div
      className="nodrag nowheel"
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Hidden columns restore bar */}
      {hiddenCount > 0 && onHiddenColumnsChange && (
        <div className="analysis-table-hidden-bar">
          <span>{hiddenCount} column{hiddenCount > 1 ? 's' : ''} hidden</span>
          <button type="button" onClick={showAllColumns}>Show all</button>
          {columnMeta.filter(c => hiddenSet.has(c.key)).map(c => (
            <button key={c.key} type="button" onClick={() => showColumn(c.key)} title={`Show ${c.label}`}>
              + {c.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          ref={gridRef}
          theme={theme}
          columnDefs={agColumnDefs}
          rowData={rowData}
          suppressMovableColumns={!onColumnOrderChange}
          onSortChanged={handleSortChanged}
          onColumnResized={handleColumnResized}
          onColumnMoved={handleColumnMoved}
          onColumnVisible={handleColumnVisible}
          suppressContextMenu
          suppressCellFocus
          headerHeight={Math.max(22, fontPx + 14)}
          rowHeight={Math.max(20, fontPx + 12)}
        />
      </div>
    </div>
  );
});
