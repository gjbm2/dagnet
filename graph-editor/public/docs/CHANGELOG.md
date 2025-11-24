# DagNet Release Notes
## Version 0.94.1-beta
**Released:** November 24, 2025

Many registry and git fixes

---

## Version 0.94b
**Released:** November 23, 2025

Images and URLs on nodes

---

## Version 0.93b
**Released:** November 21, 2025

Fairly significant debugging. Amplitude retrieve now works for complex multi-parental nodes. Also resolved a number of dsync defects, cleaned up caching signatures and fixed a ton of smaller data pipeline bugs. 

---

## Version 0.92.4-beta
**Released:** November 20, 2025

Fixed Google sheets, Added reindexing and copying of node and edge param packs.

---

## Version 0.92.1-beta
**Released:** November 20, 2025

Prettier forms. Just for you, Ezra.

---

## Version 0.92b
**Released:** November 20, 2025

Fairly significant update to allow much more sophisticated programmatic retrieval from Google Sheets -- makes it possible to pull in data ranges with param packs properly labelled.

Also fixed a whole spate of bugs related to file interactions and event management. Still nea better UI schema for events and params, but... progress.

---

## Version 0.91.10-beta
**Released:** November 19, 2025

Bug: file registries weren't updating properly. Now resolved.

---

## Version 0.91.9-beta
**Released:** November 19, 2025

Added _this_ changelog. Meta.

---

## Version 0.91.7-beta
**Released:** November 19, 2025

Fixing init stuff to make it all nice & easy to get started. So never say I don't do nice stuff for you.

---

## Version 0.91b
**Released:** November 18, 2024

### 🎯 Major Features
- **Initial Credentials Setup**: New installations can bootstrap credentials using a server secret
- **Smart Node ID Renaming**: Automatic cascade updates to edges, queries, and conditions when renaming nodes
- **Comprehensive Testing**: 493 tests passing (375 TypeScript + 118 Python)

### ✨ Enhancements
- **Default "Start" Node**: New graphs automatically include a starter node
- **Enhanced Selector Improvements**: Better debouncing and validation for node ID changes
- **Scenario Layer Visibility**: "Current" layer now defaults to visible
- **Google Sheets Authentication**: Full service account integration with proper mocking

### 🐛 Bug Fixes
- Fixed drag flag getting stuck during node operations
- Fixed snapshot creation affecting all open graphs instead of just active one
- Fixed edge ID deduplication during node renames
- Fixed EnhancedSelector dropdown interaction issues

### 🧪 Testing
- Added comprehensive UpdateManager graph-to-graph tests
- Added Google Service Account authentication tests
- All 375 JavaScript/TypeScript tests passing
- All 118 Python tests passing

### 📚 Documentation
- Completely rewrote user guide with all current features
- Added version management documentation
- Updated all help docs to reflect current functionality

---

## Version 0.90b
**Released:** October 2024

### 🎯 Major Features
- Initial beta release
- Core graph editing functionality
- Parameter registry system
- Scenario management
- Git integration


