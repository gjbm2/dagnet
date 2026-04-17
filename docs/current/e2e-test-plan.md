# E2E Test Coverage Plan for Repository Operations

## Current State
Basic repository operations lack proper E2E test coverage, leading to fragile code that breaks easily.

## Priority E2E Tests Needed

### 1. Repository Switching (CRITICAL)
- Switch from repo A to repo B
- Verify ALL files from repo A are cleared from IDB
- Verify ONLY repo B files are present
- Verify FileRegistry only contains repo B files
- Verify integrity check only shows repo B files
- Verify Navigator items only show repo B

### 2. Credential Reload
- Update credentials.yaml (change repo, change token)
- Click "Apply and Reload"
- Verify old workspace is deleted
- Verify new workspace is cloned
- Verify app is functional with new credentials

### 3. Pull All
- Make remote changes
- File > Repository > Pull All
- Verify new files appear
- Verify changed files update
- Verify deleted files are removed

### 4. File > Clear
- Have dirty files open
- File > Clear
- Verify confirmation dialog
- Verify all files cleared except credentials/connections
- Verify tabs closed
- Verify Navigator empty

### 5. Force Full Reload
- Have a corrupted workspace state
- File > Repository > Force Full Reload
- Verify workspace deleted and re-cloned
- Verify app state is clean

### 6. Sample Data Initialisation
- Fresh app (no credentials)
- Click "Use sample data"
- Verify credentials created
- Verify dagnet repo cloned
- Verify read-only mode enabled

## Test Infrastructure Needed

1. **Browser E2E Framework**: Playwright or Cypress
2. **Mock Git Server**: For predictable responses
3. **IDB Inspection**: Tools to verify IndexedDB state
4. **FileRegistry Inspection**: Expose for testing

## Implementation Notes

- Tests should run against real IDB (not mocks)
- Tests should verify final state, not just API calls
- Tests should cover error cases (network failure, auth failure)
- Tests should be fast enough to run in CI

## Acceptance Criteria

- No regression in repo switching
- No stale files after repo change
- Integrity check always accurate
- All tests pass in CI

## Timeline

This is a medium-sized effort (~3-5 days) that should be prioritised before adding more features.

