# DagNet 0.9.0-alpha Release Notes

**Release Date:** November 11, 2025

## Overview

DagNet 0.9.0-alpha introduces comprehensive data connection capabilities, enabling seamless integration with external analytics platforms and data sources. This release focuses on production-ready data synchronization, time-series analysis, and batch operations.

## Major Features

### Data Adapter Service (DAS)

A complete implementation of the Data Adapter Service, providing a flexible adapter system for connecting to external data sources:

- **Adapter Pipeline**: Five-stage transformation pipeline (pre-request, request, extraction, transform, upsert)
- **Multiple Providers**: Built-in support for Amplitude, Google Sheets, Statsig, and PostgreSQL
- **Custom Adapters**: Extensible system for creating custom adapters for any HTTP or SQL data source
- **Query DSL Integration**: Automatic transformation of DagNet query DSL to provider-specific API requests

### Time-Series Data Support

- **Daily Breakdowns**: Store and aggregate daily `n` and `k` values in parameter files
- **Window Aggregation**: Aggregate data across date ranges with naive pooling and statistical enhancement
- **Incremental Fetching**: Only fetch missing days when expanding date windows
- **Query Signature Validation**: Automatic detection of query parameter changes to ensure data consistency

### Window Selector & Data Coverage

- **Date Range Picker**: Drag-select date range component with presets (Today, Last 7/30/90 days)
- **Automatic Coverage Checking**: Real-time validation of data availability for selected window
- **Smart Fetch Button**: Automatically enables/disables based on data coverage
- **Batch Fetching**: Direct bulk operations without modal interruption

### Batch Operations

- **Bulk Data Fetching**: Fetch data for multiple parameters, cases, and nodes simultaneously
- **Progress Tracking**: Real-time progress indicators with toast notifications
- **Operation Logs**: Detailed log files showing what was fetched and where
- **Selective Processing**: Check/uncheck items before processing

### Enhanced Update Manager

- **Three-Way Sync**: Improved synchronization between graph, file, and external sources
- **Override Respect**: Proper handling of manual overrides vs. automated updates
- **Evidence Tracking**: Stale evidence exclusion for manual edits
- **Query Flow**: Unidirectional query sync (graph → file only)

### Statistical Enhancement

- **Inverse-Variance Weighting**: TypeScript-based statistical enhancement for time-series data
- **Pluggable Architecture**: Extensible system for adding new statistical methods
- **Python Backend Integration**: Offload complex methods (MCMC, Bayesian, trend-aware) to Python
- **Metadata Tracking**: Comprehensive metadata for enhancement methods and data points

## UI Improvements

### Data Menu

- **New Top Menu**: Dedicated "Data" menu between "Objects" and "Repository"
- **Context-Aware Operations**: Menu items adapt based on selected nodes/edges
- **Batch Operations**: Quick access to bulk data operations
- **Credentials Management**: Moved from File menu for better organization
- **Connections Dialog**: Centralized connection management

### Window Selector

- **Compact Mode**: Automatically shrinks when data is fully available
- **Visual Feedback**: Clear indication of data coverage status
- **Preset Buttons**: Quick access to common date ranges
- **Drag-Select**: Intuitive date range selection

### Lightning Menu (Zap Icon)

- **Connection Names**: Display connection names in menu items
- **Event Support**: Proper handling of event nodes
- **Window Integration**: Passes window state to data operations

## Technical Improvements

### Code Quality

- **TypeScript Strict Mode**: All type errors resolved
- **Test Coverage**: 242/242 tests passing (100%)
- **Python Tests**: 118/118 tests passing (100%)
- **Reduced Logging**: Cleaner console output, focused on data operations

### Performance

- **Debounced Coverage Checks**: Efficient window validation
- **Incremental Storage**: Only store new data, not entire merged datasets
- **Query Chaining**: Multiple contiguous date ranges fetched in parallel
- **Cached Credentials**: OAuth token caching for Google service accounts

### Documentation

- **Data Connections Guide**: Comprehensive documentation for adapters and connections
- **Updated User Guide**: Added data connections and batch operations sections
- **API Reference**: Updated with new data operation endpoints
- **Release Notes**: This document

## Breaking Changes

None. This is an alpha release adding new features without breaking existing functionality.

## Known Issues

- **Conditional Probability Migration**: Some conditional probability code still uses old format (see TODO.md)
- **Statsig & Case Syncing**: Set aside for future release (see TODO.md)
- **Contexts**: Partially implemented, full support coming in future release

## Migration Guide

### For Existing Users

No migration required. Existing graphs and parameters continue to work as before.

### For New Data Connections

1. **Configure Credentials**: Go to `Data > Credentials` to set up API keys
2. **Select Connection**: Choose a connection from the parameter connection selector
3. **Set Connection String**: Configure provider-specific parameters (if needed)
4. **Fetch Data**: Use the ⚡ icon or right-click menu to fetch data

See [Data Connections & Adapters](./data-connections.md) for detailed setup instructions.

## What's Next

### Planned for 0.9 Beta

- **Full Conditional Probability Migration**: Complete migration to string-based format
- **Context Support**: Full implementation of context parameters
- **Statsig Integration**: Complete case variant syncing
- **Additional Adapters**: More built-in adapters for common data sources
- **Query Builder UI**: Visual query builder for complex queries

### Future Releases

- **Real-Time Sync**: WebSocket-based real-time data updates
- **Advanced Analytics**: More statistical methods and visualization
- **Collaboration Features**: Multi-user editing and conflict resolution
- **Export Formats**: Additional export formats and integrations

## Contributors

This release represents significant work on the data connections system. Special thanks to all contributors and testers.

## Support

- **Documentation**: [docs/](graph-editor/public/docs/)
- **Issues**: [GitHub Issues](https://github.com/gjbm2/dagnet/issues)
- **Email**: greg@nous.co

---

**Full Changelog**: See [PROJECT_CONNECT_STATUS_REVIEW.md](../PROJECT_CONNECT_STATUS_REVIEW.md) for detailed implementation status.

