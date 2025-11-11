# Window-Based Data Retrieval & Display - Current State Review

## ✅ WHAT WE HAVE

### 1. **Window Selector UI**
- ✅ **Component**: `WindowSelector.tsx` - Date range picker (start/end dates)
- ✅ **Location**: Top-left of graph canvas (always visible)
- ✅ **State Management**: Window state persisted in `GraphStoreContext` (per-tab, saved to IndexedDB)
- ✅ **Preset Buttons**: Today, Last 7 days, Last 30 days, Last 90 days
- ✅ **"Show" Button**: Enabled only when window differs from current graph view
- ✅ **Functionality**: Aggregates cached daily data for selected window and updates graph

### 2. **External Source Data Retrieval**

#### ✅ **Incremental Fetch Logic**
- ✅ **Gap Detection**: `calculateIncrementalFetch()` identifies contiguous missing date ranges
- ✅ **Chained Requests**: Makes separate API requests for each contiguous gap
- ✅ **Query Signature**: SHA-256 hash for consistency checking (prevents mixing incompatible queries)
- ✅ **Smart Caching**: Only fetches missing dates, not entire window

#### ✅ **Data Fetching Flows**
- ✅ **Direct to Graph** (`getFromSourceDirect`):
  - Uses aggregate mode (no daily data storage)
  - Applies data directly to graph edge
  - Window parameter passed but used for aggregate queries only
  
- ✅ **Versioned to File** (`getFromSource` → `getFromSourceDirect` with `dailyMode=true`):
  - Fetches daily time-series data (`n_daily`, `k_daily`, `dates`)
  - Stores each gap as separate value entry in parameter file
  - Then aggregates from file to graph

#### ✅ **Chained Gap Fetching**
- ✅ Loops through each contiguous gap sequentially
- ✅ Shows progress: "Fetching gap 1/3 (2025-10-30 to 2025-11-02)"
- ✅ Collects all time-series data from all gaps
- ✅ Stores each gap as separate value entry

### 3. **File Data Handling**

#### ✅ **Parameter File Schema**
- ✅ `values[]` array supports multiple entries
- ✅ Each entry can have:
  - `n_daily`, `k_daily`, `dates` arrays (time-series data)
  - `window_from`, `window_to` (date range for this entry)
  - `query_signature` (for consistency checking)
  - `data_source` (type, retrieved_at, query, full_query)

#### ✅ **Data Storage**
- ✅ **Incremental Storage**: Only stores new days (not entire merged dataset)
- ✅ **Separate Entries**: Each gap stored as separate value entry
- ✅ **No Duplication**: Window aggregator combines entries when needed

#### ✅ **Window Aggregation**
- ✅ **Multi-Entry Support**: Aggregates across all value entries with daily data
- ✅ **Date Filtering**: Only includes dates within requested window
- ✅ **Gap Detection**: Identifies missing dates (start/middle/end)
- ✅ **Query Signature Validation**: Validates that all entries have matching query signatures
- ✅ **Signature Mismatch Warnings**: Warns when aggregating incompatible queries
- ✅ **Preference for Matching Signatures**: Prioritizes entries with matching signatures when aggregating
- ✅ **Statistical Enhancement**: Inverse-variance weighting (with Python pathway)
- ✅ **Missing Date Reporting**: Shows which dates are missing and where

### 4. **Graph Data Display**

#### ✅ **Window Aggregation to Graph**
- ✅ `getParameterFromFile()` with `window` parameter:
  - Collects daily data from all value entries
  - Filters to requested window
  - Aggregates (sums n/k, calculates mean/stdev)
  - Applies to graph edge via UpdateManager

#### ✅ **Window State Persistence**
- ✅ Window state saved to `TabState.editorState` (IndexedDB)
- ✅ Persists across sessions and tabs
- ✅ Loaded when graph tab opens

#### ✅ **UI Integration**
- ✅ Window passed from `WindowSelector` → `LightningMenu` → `dataOperationsService`
- ✅ Window passed from `EdgeContextMenu` → `dataOperationsService`
- ✅ Window used in "Get from Source" operations

### 5. **Missing Date Handling**

#### ✅ **Gap Detection**
- ✅ Identifies contiguous gaps in missing dates
- ✅ Reports gaps at start, middle, or end of window
- ✅ Provides detailed gap information (start, end, length)

#### ✅ **User Feedback**
- ✅ Toast notifications show missing date counts
- ✅ Console warnings with gap summaries
- ✅ Messages indicate where data is missing

## ❌ WHAT WE DON'T HAVE / MISSING

### 1. **Visual Display of Window Data**

#### ❌ **No Time-Series Visualization**
- ❌ No chart/graph showing daily `n`/`k`/`p` values over time
- ❌ No visual indication of which dates have data vs missing
- ❌ No way to see data quality at a glance

#### ❌ **No Window Indicator on Graph**
- ❌ Graph edges don't visually show which window they're displaying
- ❌ No badge/indicator showing "Oct 30 - Nov 10" on edges
- ❌ No way to see if different edges are using different windows

### 2. **Window Management**

#### ❌ **No Per-Edge Windows**
- ❌ Window is graph-level only (all edges use same window)
- ❌ Can't set different windows for different edges
- ❌ No way to compare different time periods side-by-side

#### ❌ **No Window History**
- ❌ Can't see previous windows that were applied
- ❌ No way to quickly switch between common windows (last 7 days, last 30 days, etc.)

#### ✅ **Window Presets** (IMPLEMENTED)
- ✅ Quick-select buttons: Today, Last 7 Days, Last 30 Days, Last 90 Days
- ⏳ Custom preset management (not needed for now)

### 3. **Data Quality & Validation**

#### ❌ **No Data Quality Warnings**
- ❌ No visual warnings when data has gaps
- ❌ No indication of data freshness (when was it last fetched?)
- ❌ No alerts for stale data

#### ✅ **Query Signature Validation** (IMPLEMENTED)
- ✅ Query signature computed and validated on aggregation
- ✅ Warns when aggregating incompatible queries
- ✅ Prefers entries with matching signatures
- ✅ Console warnings with details of mismatched entries

### 4. **Batch Operations**

#### ❌ **No Batch Window Updates**
- ❌ "Show" button updates all edges sequentially (not in parallel)
- ❌ No progress indicator for batch operations
- ❌ No way to cancel batch operation

#### ❌ **No Batch Fetching**
- ❌ Can't fetch missing dates for multiple parameters at once
- ❌ No "Refresh All" button to fetch latest data for all connected parameters

### 5. **Advanced Features**

#### ❌ **No Statistical Methods UI**
- ❌ Can't choose aggregation method (naive vs inverse-variance vs MCMC)
- ❌ No way to configure statistical enhancement settings
- ❌ No preview of different aggregation methods

#### ❌ **No Window-Based Filtering**
- ❌ Can't filter graph edges by window coverage
- ❌ No way to see which edges have data for selected window
- ❌ No "Show only edges with complete data" filter

#### ❌ **No Export/Import**
- ❌ Can't export window-aggregated data
- ❌ No way to share window configurations
- ❌ No batch export of time-series data

### 6. **Edge Cases & Error Handling**

#### ❌ **No Handling for Future Dates**
- ❌ Window selector allows future dates (should probably cap at today)
- ❌ No warning if requesting data that doesn't exist yet

#### ❌ **No Handling for Very Old Dates**
- ❌ No validation that requested dates are within data availability
- ❌ No way to know what date range has data available

#### ❌ **No Partial Failure Handling**
- ❌ If one gap fetch fails, entire operation fails
- ❌ No way to retry individual gaps
- ❌ No partial success reporting

## 🔄 CURRENT FLOW SUMMARY

### **Fetching Data (Versioned)**
1. User clicks "Get from Source" (versioned) in Lightning Menu or Edge Context Menu
2. `getFromSourceDirect()` called with `dailyMode=true` and `window` parameter
3. `calculateIncrementalFetch()` identifies missing dates and creates `fetchWindows[]`
4. For each gap:
   - API request made for that gap's date range
   - Time-series data collected
5. Each gap stored as separate value entry in parameter file
6. Data aggregated from file to graph (using latest aggregated value)

### **Displaying Window Data**
1. User selects date range in `WindowSelector`
2. User clicks "Show" button
3. `WindowSelector` finds all edges with daily data
4. For each edge:
   - `getParameterFromFile()` called with `window` parameter
   - Collects daily data from all value entries
   - Filters to requested window
   - Aggregates (sums n/k, calculates mean/stdev)
   - Applies to graph edge

### **Direct Fetching (No File)**
1. User clicks "Get from Source (direct)" in Lightning Menu or Edge Context Menu
2. `getFromSourceDirect()` called with `dailyMode=false` and `window` parameter
3. Single API request made (aggregate mode, no daily data)
4. Data applied directly to graph edge

## 📊 DATA FLOW DIAGRAM

```
┌─────────────────┐
│ WindowSelector  │
│  (UI Component) │
└────────┬────────┘
         │ window: {start, end}
         ▼
┌─────────────────────────┐
│ getFromSourceDirect()   │
│  (with dailyMode=true)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ calculateIncrementalFetch│
│  → fetchWindows[]       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ For each gap:           │
│  - API Request           │
│  - Collect time-series   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ mergeTimeSeriesIntoParam│
│  → Store each gap       │
│    as separate entry    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Parameter File          │
│  values[]:              │
│  - Entry 1: Oct 30-Nov 2│
│  - Entry 2: Nov 6-Nov 7 │
│  - Entry 3: Nov 10      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ getParameterFromFile()  │
│  (with window param)    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Window Aggregation:     │
│  - Collect all entries  │
│  - Filter to window     │
│  - Aggregate (sum n/k)  │
│  - Calculate mean/stdev │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ UpdateManager           │
│  → Apply to graph edge  │
└─────────────────────────┘
```

## 🎯 KEY STRENGTHS

1. **Efficient Fetching**: Only requests missing dates, not entire windows
2. **Gap Handling**: Properly handles missing dates at start/middle/end
3. **Incremental Storage**: Stores only new data, avoids duplication
4. **Multi-Entry Aggregation**: Combines data from multiple value entries
5. **Query Consistency**: Query signature prevents mixing incompatible data

## 🔧 KEY GAPS / IMPROVEMENTS NEEDED

1. **Visualization**: No way to see time-series data visually
2. **Per-Edge Windows**: All edges use same window (graph-level only)
3. **Batch Operations**: Sequential, not parallel; no progress tracking
4. **Data Quality UI**: No visual indicators for data completeness/freshness
5. **Error Recovery**: No way to retry failed gaps individually
6. **Window Presets**: No quick-select for common date ranges

