# DagNet Release Notes
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


