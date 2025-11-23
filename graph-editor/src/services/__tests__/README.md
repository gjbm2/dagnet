# Node Image Feature - Test Suite

This directory contains comprehensive tests for the Node Image Upload feature as documented in `/docs/NODE_IMAGE_UPLOAD_IMPLEMENTATION_PLAN.md`.

## Test File

**`nodeImageFeature.test.ts`** - Complete test suite covering all phases of the implementation plan

## Running Tests

```bash
# Run all tests
npm test

# Run only image feature tests
npm test nodeImageFeature.test.ts

# Run with coverage
npm test -- --coverage nodeImageFeature.test.ts

# Run in watch mode
npm test -- --watch nodeImageFeature.test.ts
```

## Test Coverage

### ✅ Implemented Tests

1. **Image Compression & Validation** (Phase 3)
   - File size validation (5MB limit)
   - File type validation (PNG/JPG only)
   - Image scaling (2048px max)
   - Quality compression

2. **Image Service - Blob URL Management** (Phase 2.1)
   - Blob URL creation from IDB binary data
   - Blob URL caching
   - Fallback to direct IDB access
   - URL revocation and cleanup

3. **Image Operations Service** (Phases 4-5)
   - Image upload with caption
   - Default caption generation
   - Unique image ID generation
   - Image deletion with cleanup
   - Caption editing with override flags
   - React array immutability

4. **Delete Operations Service - Garbage Collection** (Phase 7)
   - Scanning all files for image references
   - Finding references in node files
   - Finding references in graph files
   - Handling shared images across files
   - Orphaned image detection
   - Node file deletion with GC

5. **Error Handling**
   - IDB errors
   - Git API errors
   - Corrupt image data
   - Missing images

6. **Performance**
   - Large image handling
   - Blob URL caching efficiency
   - Many images per node
   - Large file set scanning

### ⚠️ Tests Marked TODO (Require Implementation)

These tests are defined but need implementation:

1. **Image Compression Details**
   - Canvas mocking for actual compression testing
   - Aspect ratio verification
   - Quality parameter testing

2. **Undo/Redo Integration** (BLOCKED BY BUG)
   - Undo after image upload
   - Undo after image deletion
   - Undo after caption edit
   - Complex undo/redo sequences
   - **Status**: Waiting for undo/redo fix (see TODO.md § Image Undo/Redo Broken)

3. **Git Sync Integration** (Phase 9)
   - Commit with images
   - Commit with deletions
   - Clone with images
   - Pull with images
   - Missing image handling

4. **UI Component Integration** (Phases 4-6)
   - ImageUploadModal rendering and validation
   - ImageThumbnail display and editing
   - ImageStackIndicator display and cleanup
   - ImageLoupeView navigation and editing

5. **UpdateManager Integration** (Phase 8)
   - URL field bidirectional sync
   - Images field bidirectional sync
   - Override flag handling
   - Node deletion with GC

## Known Issues

### Critical: Undo/Redo Broken for Image Operations

**Status**: Tests defined but blocked by bug (see `/TODO.md`)

**Problem**: History system only saves graph JSON structure, but image operations involve:
1. ✅ Graph references (`node.images[]`) - Tracked in history
2. ❌ Binary data in IndexedDB - NOT tracked
3. ❌ Pending operations (`FileRegistry.pendingImageOps`) - NOT tracked

**Impact on Tests**:
- All undo/redo tests are marked TODO
- Tests will fail until bug is fixed
- Manual testing required for undo/redo scenarios

**Resolution**: Implement Option 2 from TODO.md (recalculate pending operations from graph diff)

## Test Organization

Tests are organized to match the implementation plan phases:

```
Phase 1-2: Infrastructure (Image Service, Git, Workspace, FileRegistry)
Phase 3:   Compression & Validation
Phase 4-5: Upload Modal & Properties Panel
Phase 6:   Node Face Display Components
Phase 7:   Deletion Service & GC
Phase 8:   UpdateManager Integration
Phase 9:   Git Sync & Commit Flow
Phase 10:  Undo/Redo (BLOCKED)
```

## Test Patterns

### Mocking Dependencies

```typescript
import { vi } from 'vitest';
import { db } from '../../db/appDatabase';
import { fileRegistry } from '../../contexts/TabContext';

// Mock IDB
vi.mock('../../db/appDatabase');

// Mock specific methods
vi.spyOn(db.files, 'put').mockResolvedValue('file-id');
vi.spyOn(fileRegistry, 'getFile').mockReturnValue(mockFile);
```

### Testing Image Operations

```typescript
const mockGraph = {
  nodes: [{ uuid: 'node-1', id: 'test', images: [] }],
  edges: [],
  policies: {},
  metadata: { version: '1.0.0' }
};

const mockCallbacks = {
  onGraphUpdate: vi.fn(),
  onHistorySave: vi.fn(),
  getNodeId: vi.fn(() => 'node-1')
};

await imageOperationsService.uploadImage(
  mockGraph,
  imageData,
  'png',
  'local',
  mockCallbacks,
  'Test Caption'
);

expect(mockCallbacks.onGraphUpdate).toHaveBeenCalled();
const updatedGraph = mockCallbacks.onGraphUpdate.mock.calls[0][0];
expect(updatedGraph.nodes[0].images).toHaveLength(1);
```

### Testing Garbage Collection

```typescript
// Mock file system state
vi.spyOn(db.files, 'toArray').mockResolvedValue([
  {
    fileId: 'node-node-1',
    type: 'node',
    data: { images: [{ image_id: 'img-1' }] }
  },
  {
    fileId: 'graph-graph-1',
    type: 'graph',
    data: { nodes: [{ images: [{ image_id: 'img-1' }] }] }
  }
]);

// Test GC correctly identifies shared images
const result = await deleteOperationsService
  .scanAllFilesForImageReferences(['img-1', 'img-2']);

expect(result.has('img-1')).toBe(true);  // Referenced
expect(result.has('img-2')).toBe(false); // Orphaned
```

## Contributing

When adding new features or fixing bugs:

1. Add corresponding test cases to this file
2. Update TODO markers when tests are implemented
3. Keep test organization aligned with implementation plan
4. Update this README with any new test patterns

## References

- **Implementation Plan**: `/docs/NODE_IMAGE_UPLOAD_IMPLEMENTATION_PLAN.md`
- **Design Document**: `/docs/NODE_IMAGE_UPLOAD_FEATURE_PLAN.md`
- **State Management**: `/graph-editor/public/docs/STATE_MANAGEMENT_REFERENCE.md`
- **Known Issues**: `/TODO.md` § Image Undo/Redo Broken
