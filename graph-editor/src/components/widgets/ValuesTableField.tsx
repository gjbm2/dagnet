import React, { useState, useMemo, useCallback } from 'react';
import { FieldProps } from '@rjsf/utils';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type CellValueChangedEvent,
} from 'ag-grid-community';
import {
  Tabs,
  Tab,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Box,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

ModuleRegistry.registerModules([AllCommunityModule]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item in the values[] array. */
interface ValueItem {
  mean?: number;
  stdev?: number;
  n?: number;
  k?: number;
  distribution?: string;
  forecast?: number;
  window_from?: string;
  window_to?: string;
  cohort_from?: string;
  cohort_to?: string;
  sliceDSL?: string;
  context_id?: string;
  dates?: string[];
  k_daily?: number[];
  n_daily?: number[];
  median_lag_days?: number[];
  mean_lag_days?: number[];
  anchor_n_daily?: number[];
  anchor_median_lag_days?: number[];
  anchor_mean_lag_days?: number[];
  latency?: Record<string, unknown>;
  anchor_latency?: Record<string, unknown>;
  data_source?: Record<string, unknown>;
  query_signature?: string;
  [key: string]: unknown;
}

/** Row in the joined daily table. */
interface DailyRow {
  _index: number;
  date?: string;
  k?: number | null;
  n?: number | null;
  median_lag?: number | null;
  mean_lag?: number | null;
}

/** Row in the joined anchor table. */
interface AnchorRow {
  _index: number;
  anchor_n?: number | null;
  anchor_median_lag?: number | null;
  anchor_mean_lag?: number | null;
}

// ---------------------------------------------------------------------------
// AG Grid theme (compact, matches FormEditor context)
// ---------------------------------------------------------------------------

function buildCompactTheme(isDark: boolean) {
  return themeQuartz.withParams({
    fontSize: 11,
    headerHeight: 26,
    rowHeight: 24,
    spacing: 2,
    borderRadius: 0,
    wrapperBorderRadius: 4,
    headerColumnBorder: true,
    ...(isDark
      ? {
          backgroundColor: 'transparent',
          headerBackgroundColor: 'rgba(255,255,255,0.04)',
          oddRowBackgroundColor: 'rgba(255,255,255,0.02)',
          borderColor: 'rgba(255,255,255,0.08)',
          headerFontWeight: 600,
          foregroundColor: 'var(--text-primary, #e5e7eb)',
        }
      : {
          backgroundColor: 'transparent',
          headerBackgroundColor: 'rgba(0,0,0,0.02)',
          oddRowBackgroundColor: 'rgba(0,0,0,0.015)',
          borderColor: 'rgba(0,0,0,0.08)',
          headerFontWeight: 600,
          foregroundColor: 'var(--text-primary, #374151)',
        }),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Group value items by slice key: sliceDSL > context_id > '(all)'. */
function groupBySlice(items: ValueItem[]): Map<string, { indices: number[]; items: ValueItem[] }> {
  const map = new Map<string, { indices: number[]; items: ValueItem[] }>();
  items.forEach((item, idx) => {
    const key = item.sliceDSL || item.context_id || '(all)';
    if (!map.has(key)) map.set(key, { indices: [], items: [] });
    const group = map.get(key)!;
    group.indices.push(idx);
    group.items.push(item);
  });
  return map;
}

/** Build a human-readable window label. */
function windowLabel(item: ValueItem): string {
  const from = item.window_from || item.cohort_from || '?';
  const to = item.window_to || item.cohort_to;
  return to ? `${from} \u2192 ${to}` : from;
}

/** Build the joined daily rows from parallel arrays. */
function buildDailyRows(item: ValueItem): DailyRow[] {
  const len = Math.max(
    item.dates?.length ?? 0,
    item.k_daily?.length ?? 0,
    item.n_daily?.length ?? 0,
    item.median_lag_days?.length ?? 0,
    item.mean_lag_days?.length ?? 0,
  );
  if (len === 0) return [];
  const rows: DailyRow[] = [];
  for (let i = 0; i < len; i++) {
    rows.push({
      _index: i,
      date: item.dates?.[i] ?? undefined,
      k: item.k_daily?.[i] ?? null,
      n: item.n_daily?.[i] ?? null,
      median_lag: item.median_lag_days?.[i] ?? null,
      mean_lag: item.mean_lag_days?.[i] ?? null,
    });
  }
  return rows;
}

/** Build the joined anchor rows. */
function buildAnchorRows(item: ValueItem): AnchorRow[] {
  const len = Math.max(
    item.anchor_n_daily?.length ?? 0,
    item.anchor_median_lag_days?.length ?? 0,
    item.anchor_mean_lag_days?.length ?? 0,
  );
  if (len === 0) return [];
  const rows: AnchorRow[] = [];
  for (let i = 0; i < len; i++) {
    rows.push({
      _index: i,
      anchor_n: item.anchor_n_daily?.[i] ?? null,
      anchor_median_lag: item.anchor_median_lag_days?.[i] ?? null,
      anchor_mean_lag: item.anchor_mean_lag_days?.[i] ?? null,
    });
  }
  return rows;
}

/** Which daily columns actually have data? */
function dailyColumnsPresent(rows: DailyRow[]): Set<keyof DailyRow> {
  const cols = new Set<keyof DailyRow>();
  for (const r of rows) {
    if (r.date !== undefined) cols.add('date');
    if (r.k !== null && r.k !== undefined) cols.add('k');
    if (r.n !== null && r.n !== undefined) cols.add('n');
    if (r.median_lag !== null && r.median_lag !== undefined) cols.add('median_lag');
    if (r.mean_lag !== null && r.mean_lag !== undefined) cols.add('mean_lag');
  }
  return cols;
}

/** Which anchor columns actually have data? */
function anchorColumnsPresent(rows: AnchorRow[]): Set<keyof AnchorRow> {
  const cols = new Set<keyof AnchorRow>();
  for (const r of rows) {
    if (r.anchor_n !== null && r.anchor_n !== undefined) cols.add('anchor_n');
    if (r.anchor_median_lag !== null && r.anchor_median_lag !== undefined) cols.add('anchor_median_lag');
    if (r.anchor_mean_lag !== null && r.anchor_mean_lag !== undefined) cols.add('anchor_mean_lag');
  }
  return cols;
}

// Column header labels
const DAILY_HEADERS: Record<string, string> = {
  date: 'Date',
  k: 'k (successes)',
  n: 'n (trials)',
  median_lag: 'Median lag (d)',
  mean_lag: 'Mean lag (d)',
};
const ANCHOR_HEADERS: Record<string, string> = {
  anchor_n: 'Anchor n',
  anchor_median_lag: 'Anchor median lag (d)',
  anchor_mean_lag: 'Anchor mean lag (d)',
};

// Fields that map back to source arrays when edited
const DAILY_TO_SOURCE: Record<string, string> = {
  date: 'dates',
  k: 'k_daily',
  n: 'n_daily',
  median_lag: 'median_lag_days',
  mean_lag: 'mean_lag_days',
};
const ANCHOR_TO_SOURCE: Record<string, string> = {
  anchor_n: 'anchor_n_daily',
  anchor_median_lag: 'anchor_median_lag_days',
  anchor_mean_lag: 'anchor_mean_lag_days',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Summary statistics bar for a single value item. */
function SummaryBar({ item }: { item: ValueItem }) {
  const parts: string[] = [];
  if (item.mean !== undefined) parts.push(`mean=${fmt(item.mean)}`);
  if (item.k !== undefined && item.n !== undefined) parts.push(`k/n=${item.k}/${item.n}`);
  else if (item.n !== undefined) parts.push(`n=${item.n}`);
  if (item.stdev !== undefined) parts.push(`sd=${fmt(item.stdev)}`);
  if (item.forecast !== undefined) parts.push(`forecast=${fmt(item.forecast)}`);
  if (item.distribution) parts.push(item.distribution);

  if (parts.length === 0) return null;
  return (
    <div style={{
      display: 'flex',
      gap: '16px',
      padding: '6px 12px',
      fontSize: '12px',
      fontFamily: 'monospace',
      color: 'var(--text-secondary, #666)',
      borderBottom: '1px solid var(--border-primary, #e0e0e0)',
      flexWrap: 'wrap',
    }}>
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </div>
  );
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v);
}

/** AG Grid table for a set of rows + column defs. */
function DataGrid({
  rows,
  columns,
  headerMap,
  isDark,
  editable,
  onCellChanged,
}: {
  rows: any[];
  columns: Set<string>;
  headerMap: Record<string, string>;
  isDark: boolean;
  editable: boolean;
  onCellChanged?: (field: string, rowIndex: number, newValue: unknown) => void;
}) {
  const theme = useMemo(() => buildCompactTheme(isDark), [isDark]);

  const colDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [
      { field: '_index', headerName: '#', width: 50, maxWidth: 50, sortable: false, editable: false },
    ];
    const ordered = Object.keys(headerMap).filter(k => columns.has(k));
    for (const key of ordered) {
      const isNumeric = key !== 'date';
      defs.push({
        field: key,
        headerName: headerMap[key],
        editable,
        sortable: true,
        width: key === 'date' ? 110 : 100,
        type: isNumeric ? 'numericColumn' : undefined,
        valueFormatter: isNumeric
          ? (p: any) => (p.value !== null && p.value !== undefined ? fmt(p.value) : '\u2014')
          : undefined,
      });
    }
    return defs;
  }, [columns, headerMap, editable]);

  const handleCellChanged = useCallback(
    (event: CellValueChangedEvent) => {
      if (!onCellChanged) return;
      const field = event.colDef.field;
      const rowIndex = event.data._index as number;
      if (field && field !== '_index') {
        // Parse numeric values
        let val: unknown = event.newValue;
        if (typeof val === 'string') {
          const num = Number(val);
          if (!isNaN(num)) val = num;
        }
        onCellChanged(field, rowIndex, val);
      }
    },
    [onCellChanged],
  );

  // Cap height: show ~12 rows then scroll
  const height = Math.min(rows.length * 24 + 28, 320);

  return (
    <div style={{ width: '100%', height, padding: '0 12px' }}>
      <AgGridReact
        theme={theme}
        columnDefs={colDefs}
        rowData={rows}
        modules={[AllCommunityModule]}
        suppressMovableColumns
        suppressDragLeaveHidesColumns
        onCellValueChanged={handleCellChanged}
      />
    </div>
  );
}

/** Collapsible JSON view for opaque nested objects (latency, data_source, etc). */
function JsonSection({ label, data }: { label: string; data: unknown }) {
  const [open, setOpen] = useState(false);
  if (data === undefined || data === null) return null;
  const summary = Array.isArray(data)
    ? `[${data.length} items]`
    : typeof data === 'object'
      ? `{${Object.keys(data as object).length} keys}`
      : String(data);

  return (
    <div style={{ margin: '2px 0' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          cursor: 'pointer',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: 'var(--text-secondary, #888)',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-block', width: '10px', marginRight: '4px' }}>
          {open ? '\u25BE' : '\u25B8'}
        </span>
        <span style={{ opacity: 0.6 }}>{label}</span>
        {!open && <span style={{ marginLeft: '8px', opacity: 0.4 }}>{summary}</span>}
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 4px 16px',
          padding: '8px',
          fontSize: '11px',
          fontFamily: 'monospace',
          background: 'var(--bg-tertiary, #f5f5f5)',
          border: '1px solid var(--border-primary, #e0e0e0)',
          borderRadius: '4px',
          maxHeight: '200px',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Render a single value item: summary bar + daily table + anchor table + metadata. */
function ValueItemView({
  item,
  itemIndex,
  isDark,
  editable,
  onItemChange,
}: {
  item: ValueItem;
  itemIndex: number;
  isDark: boolean;
  editable: boolean;
  onItemChange: (itemIndex: number, updated: ValueItem) => void;
}) {
  const dailyRows = useMemo(() => buildDailyRows(item), [item]);
  const anchorRows = useMemo(() => buildAnchorRows(item), [item]);
  const dailyCols = useMemo(() => dailyColumnsPresent(dailyRows), [dailyRows]);
  const anchorCols = useMemo(() => anchorColumnsPresent(anchorRows), [anchorRows]);

  const handleDailyCellChanged = useCallback(
    (field: string, rowIndex: number, newValue: unknown) => {
      const sourceField = DAILY_TO_SOURCE[field];
      if (!sourceField) return;
      const updated = { ...item };
      const arr = [...((updated as any)[sourceField] || [])];
      arr[rowIndex] = newValue;
      (updated as any)[sourceField] = arr;
      onItemChange(itemIndex, updated);
    },
    [item, itemIndex, onItemChange],
  );

  const handleAnchorCellChanged = useCallback(
    (field: string, rowIndex: number, newValue: unknown) => {
      const sourceField = ANCHOR_TO_SOURCE[field];
      if (!sourceField) return;
      const updated = { ...item };
      const arr = [...((updated as any)[sourceField] || [])];
      arr[rowIndex] = newValue;
      (updated as any)[sourceField] = arr;
      onItemChange(itemIndex, updated);
    },
    [item, itemIndex, onItemChange],
  );

  return (
    <div>
      {dailyRows.length > 0 && (
        <div style={{ padding: '4px 0' }}>
          <div style={{
            fontSize: '10px',
            fontWeight: 600,
            color: 'var(--text-secondary, #999)',
            padding: '0 4px 2px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Daily ({dailyRows.length})
          </div>
          <DataGrid
            rows={dailyRows}
            columns={dailyCols as Set<string>}
            headerMap={DAILY_HEADERS}
            isDark={isDark}
            editable={editable}
            onCellChanged={handleDailyCellChanged}
          />
        </div>
      )}

      {anchorRows.length > 0 && (
        <div style={{ padding: '4px 0' }}>
          <div style={{
            fontSize: '10px',
            fontWeight: 600,
            color: 'var(--text-secondary, #999)',
            padding: '0 4px 2px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Anchor ({anchorRows.length})
          </div>
          <DataGrid
            rows={anchorRows}
            columns={anchorCols as Set<string>}
            headerMap={ANCHOR_HEADERS}
            isDark={isDark}
            editable={editable}
            onCellChanged={handleAnchorCellChanged}
          />
        </div>
      )}

      {/* Collapsible metadata sections */}
      <div style={{ padding: '4px 0' }}>
        <JsonSection label="latency" data={item.latency} />
        <JsonSection label="anchor_latency" data={item.anchor_latency} />
        <JsonSection label="data_source" data={item.data_source} />
        {item.query_signature && (
          <div style={{
            fontSize: '11px',
            fontFamily: 'monospace',
            color: 'var(--text-secondary, #888)',
            padding: '2px 4px',
          }}>
            <span style={{ opacity: 0.6 }}>query_signature</span>
            <span style={{ marginLeft: '8px', opacity: 0.4 }}>{item.query_signature}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main field component
// ---------------------------------------------------------------------------

/**
 * ValuesTableField — custom RJSF field for the parameter `values` array.
 *
 * Replaces the default RJSF array rendering with:
 *   1. Tabs by slice (sliceDSL / context_id)
 *   2. Accordions by retrieval window (window_from / window_to)
 *   3. Joined AG Grid tables for parallel daily arrays
 *
 * Register via `"ui:field": "ValuesTableField"` in the parameter UI schema.
 */
export function ValuesTableField(props: FieldProps) {
  const { formData, onChange, readonly, disabled } = props;
  const items: ValueItem[] = Array.isArray(formData) ? formData : [];
  const editable = !readonly && !disabled;
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';

  // Group by slice
  const sliceGroups = useMemo(() => groupBySlice(items), [items]);
  const sliceKeys = useMemo(() => Array.from(sliceGroups.keys()), [sliceGroups]);

  const [activeSlice, setActiveSlice] = useState(0);
  const safeSlice = Math.min(activeSlice, Math.max(0, sliceKeys.length - 1));

  // Track which window accordions are expanded (per slice)
  const [expandedWindows, setExpandedWindows] = useState<Set<string>>(() => new Set(['0']));

  const toggleWindow = useCallback((key: string) => {
    setExpandedWindows(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Propagate a change to a single value item back to RJSF
  const handleItemChange = useCallback(
    (globalIndex: number, updated: ValueItem) => {
      const newItems = [...items];
      newItems[globalIndex] = updated;
      onChange(newItems);
    },
    [items, onChange],
  );

  if (items.length === 0) {
    return (
      <Box sx={{
        p: 4,
        textAlign: 'center',
        color: 'text.secondary',
        fontStyle: 'italic',
        fontSize: '14px',
      }}>
        No values yet.
      </Box>
    );
  }

  const currentSliceKey = sliceKeys[safeSlice];
  const currentGroup = sliceGroups.get(currentSliceKey);

  return (
    <div style={{ marginTop: '8px' }}>
      {/* Slice tabs — only show if more than one slice */}
      {sliceKeys.length > 1 && (
        <Tabs
          value={safeSlice}
          onChange={(_e, v) => setActiveSlice(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{
            borderBottom: 1,
            borderColor: 'divider',
            mb: 1,
            '& .MuiTab-root': {
              textTransform: 'none',
              fontSize: '0.8rem',
              minHeight: 36,
              py: 0,
            },
          }}
        >
          {sliceKeys.map((key, i) => (
            <Tab key={i} label={key} />
          ))}
        </Tabs>
      )}

      {/* Window accordions within the active slice */}
      {currentGroup && currentGroup.items.map((item, localIdx) => {
        const globalIndex = currentGroup.indices[localIdx];
        const windowKey = `${safeSlice}-${localIdx}`;
        const isExpanded = expandedWindows.has(windowKey);

        return (
          <Accordion
            key={windowKey}
            expanded={isExpanded}
            onChange={() => toggleWindow(windowKey)}
            slotProps={{ transition: { unmountOnExit: true } }}
            sx={{
              mb: 0.5,
              '&:before': { display: 'none' },
              boxShadow: 'none',
              border: '1px solid var(--border-primary, #e0e0e0)',
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}
            >
              <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, mr: 2 }}>
                {windowLabel(item)}
              </Typography>
              <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                {item.mean !== undefined && `mean=${fmt(item.mean)}`}
                {item.k !== undefined && item.n !== undefined && ` \u00B7 k/n=${item.k}/${item.n}`}
                {item.dates?.length ? ` \u00B7 ${item.dates.length}d` : ''}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <ValueItemView
                item={item}
                itemIndex={globalIndex}
                isDark={isDark ?? false}
                editable={editable}
                onItemChange={handleItemChange}
              />
            </AccordionDetails>
          </Accordion>
        );
      })}
    </div>
  );
}
