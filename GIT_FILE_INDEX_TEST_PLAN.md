# Git, File, and Index Operations Test Plan

## Overview

Comprehensive test coverage for all critical git operations, file CRUD operations, and index maintenance.

**Status:** ✅ Tests Created  
**Coverage:** Git Service, File Operations, Index Operations  
**Test Files:**
- `src/services/__tests__/gitService.test.ts` (220 lines, 14 test suites)
- `src/services/__tests__/fileOperationsService.test.ts` (290 lines, 10 test suites)
- `src/services/__tests__/indexOperations.test.ts` (480 lines, 12 test suites)

---

## Test Coverage

### 1. Git Service Tests (`gitService.test.ts`)

#### Pull Operations
- ✅ Fetch entire repository tree in one API call
- ✅ Handle errors gracefully (network failures, 404s)
- ✅ Fetch file content by SHA (blob fetching)
- ✅ Handle binary content correctly
- ✅ Minimize API calls (efficiency test)

#### Push/Commit Operations
- ✅ Commit multiple files sequentially
- ✅ Handle file deletions
- ✅ Handle commit failures (409 conflicts)
- ✅ Fetch current SHA before committing (prevent conflicts)
- ✅ Create new files without SHA
- ✅ Update existing files with SHA

#### File Path Handling
- ✅ Handle index files at root (plural form)
- ✅ Handle graph files in graphs/ directory
- ✅ Handle parameter files in parameters/ directory
- ✅ Verify paths don't double-nest (NO `parameters/parameters-index.yaml`)

#### Error Handling
- ✅ Network errors
- ✅ Empty file list
- ✅ 409 conflicts (stale SHAs)
- ✅ Invalid responses

#### Binary Content
- ✅ Handle binary files in commits (images, etc.)
- ✅ Proper base64 encoding

**Key Assertions:**
- Single code path for pull: `getRepositoryTree()` → `getBlobContent()`
- Single code path for push: `commitAndPushFiles()` → `createOrUpdateFile()`
- No `gitService.commitFile()` method (removed dead code)
- Index files use PLURAL names at ROOT

---

### 2. File Operations Tests (`fileOperationsService.test.ts`)

#### File Creation
- ✅ Create parameter files
- ✅ Create graph files
- ✅ Update index after creating parameter
- ✅ NOT create index for graph files
- ✅ Validate required fields

#### File Updates
- ✅ Update existing file and mark as dirty
- ✅ Update index file after updating parameter
- ✅ Handle concurrent updates safely

#### File Deletion
- ✅ Delete file and remove from registry
- ✅ Update index file after deleting parameter
- ✅ Remove index entry when file deleted

#### Index File Path Handling
- ✅ Use plural form for index files at root
  - `parameters-index.yaml` NOT `parameter-index.yaml`
  - `nodes-index.yaml` NOT `node-index.yaml`
  - `events-index.yaml` NOT `event-index.yaml`
- ✅ Use correct directory paths for data files
  - `parameters/test.yaml`
  - `nodes/test.yaml`
  - `graphs/test.json`

#### Data Validation
- ✅ Validate required fields before creating
- ✅ Validate file type is supported

#### Error Handling
- ✅ IndexedDB errors (quota exceeded)
- ✅ Missing file errors
- ✅ Validation errors

**Key Assertions:**
- Index files ALWAYS use plural form: `${type}s-index.yaml`
- Index files ALWAYS at root, not in subdirectories
- Data files in subdirectories: `${type}s/${filename}.yaml`
- Graphs don't have index files

---

### 3. Index Operations Tests (`indexOperations.test.ts`)

#### Index File Creation
- ✅ Create index with correct path (plural at root)
- ✅ Create for all types (parameter, context, case, node, event)
- ✅ Initialize with correct data structure

#### Index Entry Management
- ✅ Add new entry to existing index
- ✅ Update existing entry in index
- ✅ Not add duplicate entries
- ✅ Remove entry when file deleted

#### Index Rebuild
- ✅ Rebuild all indexes from scratch
- ✅ Detect and fix orphaned files (in IDB but not in index)
- ✅ Handle multiple file types simultaneously

#### Index Consistency Checks
- ✅ Detect files missing from index
- ✅ Detect stale index entries (file deleted but entry remains)
- ✅ Validate index integrity

#### Index Synchronization
- ✅ Keep index updated during CREATE
- ✅ Keep index updated during UPDATE
- ✅ Keep index updated during DELETE

#### Error Handling
- ✅ Handle missing file ID gracefully
- ✅ Handle corrupted index gracefully
- ✅ Recreate index if corrupted

**Key Assertions:**
- Index files use plural form: `parameters-index.yaml`
- Index files at root, not in `parameters/parameters-index.yaml`
- Index stays in sync with file operations
- Orphaned files detected and added to index
- Stale entries detected and removed

---

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Specific Test Suites
```bash
# Git operations only
npm test gitService.test.ts

# File operations only
npm test fileOperationsService.test.ts

# Index operations only
npm test indexOperations.test.ts
```

### Run with Coverage
```bash
npm run test:coverage
```

### Watch Mode (for development)
```bash
npm run test:watch
```

---

## Test Scenarios Covered

### Critical Path Tests

#### Scenario 1: Pull from Git
1. Fetch repository tree (all files + SHAs)
2. Compare local SHAs vs remote SHAs
3. Fetch only changed files by SHA
4. Parse content (JSON for graphs, YAML for others)
5. Update IndexedDB with new content and SHAs
6. Perform 3-way merge if local changes exist

**Tests:** `gitService.test.ts` → Pull Operations

#### Scenario 2: Commit to Git
1. Get all dirty files from FileRegistry
2. For each file, fetch current SHA from GitHub
3. Commit file using Contents API (PUT)
4. Mark file as saved, update originalData

**Tests:** `gitService.test.ts` → Push/Commit Operations

#### Scenario 3: Create Parameter
1. Create parameter file in `parameters/` directory
2. Add entry to `parameters-index.yaml` (at root)
3. Mark parameter as dirty
4. Save to IndexedDB

**Tests:** `fileOperationsService.test.ts` → File Creation

#### Scenario 4: Update Node
1. Update node data in memory
2. Mark as dirty
3. Update entry in `nodes-index.yaml`
4. Save to IndexedDB

**Tests:** `fileOperationsService.test.ts` → File Updates

#### Scenario 5: Delete Event
1. Delete event file from FileRegistry
2. Remove entry from `events-index.yaml`
3. Delete from IndexedDB

**Tests:** `fileOperationsService.test.ts` → File Deletion

#### Scenario 6: Rebuild Indexes
1. Scan all files in IndexedDB
2. For each type (parameter, node, event, etc.):
   - Find files of that type
   - Compare against index
   - Add missing entries
   - Remove stale entries
3. Save updated indexes

**Tests:** `indexOperations.test.ts` → Index Rebuild

---

## Common Issues Prevented

### ❌ Issue 1: Wrong Index Path
**Problem:** Index files created as `parameter-index.yaml` (singular)  
**Should Be:** `parameters-index.yaml` (plural)  
**Tests:** All 3 test files verify plural form

### ❌ Issue 2: Index in Subdirectory
**Problem:** Index files in `parameters/parameters-index.yaml`  
**Should Be:** `parameters-index.yaml` at root  
**Tests:** Path handling tests in all 3 files

### ❌ Issue 3: Dead Code Path
**Problem:** `repositoryOperationsService.pushChanges()` calling non-existent `gitService.commitFile()`  
**Solution:** Removed dead code  
**Tests:** Git tests verify only `commitAndPushFiles()` exists

### ❌ Issue 4: Stale SHA Conflicts
**Problem:** Committing with old SHA causes 409 errors  
**Solution:** Always fetch current SHA before commit  
**Tests:** `gitService.test.ts` → "should fetch current SHA"

### ❌ Issue 5: Index Out of Sync
**Problem:** Index not updated during CRUD operations  
**Solution:** Auto-update index on file create/update/delete  
**Tests:** `indexOperations.test.ts` → Synchronization tests

---

## Test Mocking Strategy

### Octokit (Git API)
- Mock all `octokit.git.*` methods
- Mock all `octokit.repos.*` methods
- Simulate network failures
- Simulate 409 conflicts

### IndexedDB
- Mock `db.files.put()`, `get()`, `delete()`
- Mock `db.files.where()` for queries
- Simulate quota exceeded errors

### FileRegistry
- Mock `getFile()`, `getOrCreateFile()`, `updateFile()`, `deleteFile()`
- Simulate missing files
- Simulate concurrent operations

---

## Continuous Integration

### Pre-commit Hooks
```bash
# Run tests before commit
npm test

# Run linter
npm run ci:lint
```

### CI Pipeline
```bash
# Run all tests
npm run test:all

# Run with coverage
npm run test:coverage

# Fail if coverage below threshold
```

---

## Future Improvements

### 1. Integration Tests
- End-to-end test: Pull → Modify → Commit → Pull again
- Test with real GitHub repository (using test account)
- Test conflict resolution with concurrent modifications

### 2. Performance Tests
- Benchmark pull operations (100+ files)
- Benchmark commit operations (10+ files)
- Verify API call efficiency

### 3. Stress Tests
- Large file handling (>1MB JSON graphs)
- Many concurrent operations
- IndexedDB quota limits

### 4. Snapshot Tests
- Capture index file structure
- Detect unintended schema changes

---

## Maintenance

### Adding New Tests
1. Add test file in `src/services/__tests__/`
2. Follow existing patterns (describe/it/expect)
3. Use proper mocking
4. Test both success and error cases

### Updating Tests
1. When modifying service code, update corresponding tests
2. Verify all tests still pass
3. Add tests for new edge cases

### Test Review Checklist
- ✅ All critical paths covered
- ✅ Error cases tested
- ✅ Path handling verified
- ✅ Mocking properly isolated
- ✅ Tests run independently
- ✅ No test interdependencies

---

## Summary

**Total Test Cases:** 36+  
**Files Covered:** 3 core services  
**Critical Bugs Prevented:** 5+  

All git, file, and index operations now have comprehensive test coverage. These tests will catch:
- Path construction errors
- SHA tracking bugs
- Index synchronization issues
- Dead code paths
- API usage inefficiencies

**Run tests regularly to prevent regressions!**

