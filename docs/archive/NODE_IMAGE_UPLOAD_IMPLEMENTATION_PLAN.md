    # Node Image Upload Feature - Implementation Plan

**Design Reference**: [NODE_IMAGE_UPLOAD_FEATURE_PLAN.md](./NODE_IMAGE_UPLOAD_FEATURE_PLAN.md)  
**Estimated Effort**: 29-38 hours  
**Status**: Ready for implementation

---

## Phase 1: Schema Updates (2-3 hours)

### 1.1 Update Node Schema
**File**: `graph-editor/public/param-schemas/node-schema.yaml`
- [x] Add `url` field (format: uri)
- [x] Add `images` array with properties: `image_id`, `caption`, `file_extension`, `uploaded_at`, `uploaded_by`
- [ ] Test schema validation (requires runtime testing)

**Design Ref**: Schema Changes § 1

### 1.2 Update Graph Schema
**File**: `graph-editor/public/schemas/conversion-graph-1.0.0.json`
- [x] Add `url` and `url_overridden` to Node definition
- [x] Add `images` array to Node definition (with `caption_overridden` per item)
- [x] Add `images_overridden` to Node definition
- [ ] Test schema validation (requires runtime testing)

**Design Ref**: Schema Changes § 2

### 1.3 Update TypeScript Types
**File**: `graph-editor/src/types/index.ts`
- [x] Add `NodeImage` interface
- [x] Add `url`, `url_overridden`, `images`, `images_overridden` to `GraphNode`
- [x] Add `url`, `images` to `Node` (registry - in paramRegistryService.ts)

**Design Ref**: Schema Changes § 3

### 1.4 Update Python Types (if needed)
**File**: `graph-editor/api/lib/graph_types.py`
- [ ] Add image fields to Node class (SKIPPED - not critical for initial implementation)
- [ ] Test Python validation (SKIPPED)

---

## Phase 2: Image Storage & Serving Infrastructure (4-5 hours)

### 2.1 Create Image Service
**New File**: `graph-editor/src/services/imageService.ts`
- [x] Implement `getImageUrl(imageId, ext)` - converts IDB binary to blob URL
- [x] Implement blob URL caching
- [x] Implement `revokeImageUrl()` cleanup
- [x] Implement `clearCache()` method
- [ ] Test blob URL generation (requires runtime testing)

**Design Ref**: Storage Architecture § Image Serving from IDB

### 2.2 Enhance Git Service for Binary Files
**File**: `graph-editor/src/services/gitService.ts`
- [x] Add `encoding` parameter to `createOrUpdateFile()`
- [x] Update `commitAndPushFiles()` to handle `GitFileToCommit` with `binaryContent`
- [x] Add base64 encoding for binary data
- [x] Add deletion support (check `file.delete` flag, call DELETE API)
- [ ] Test binary upload/download via GitHub API (requires runtime testing)

**Design Ref**: Git Sync Strategy § Enhancement Needed

### 2.3 Extend Workspace Service
**File**: `graph-editor/src/services/workspaceService.ts`
- [x] Add `fetchAllImagesFromGit()` method
- [x] Update `pullLatest()` to fetch images from `/nodes/images/`
- [x] Update `cloneWorkspace()` to fetch images
- [x] Add `getAllNodeFilesFromIDB()` helper
- [x] Add `getAllGraphFilesFromIDB()` helper
- [x] Add `getAllImageIdsFromIDB()` helper
- [ ] Test image fetching on clone/pull (requires runtime testing)

**Design Ref**: Git Pull § Syncing Images from Repository to IDB

### 2.4 Extend File Registry
**File**: `graph-editor/src/contexts/TabContext.tsx`
- [x] Add `pendingImageOps: PendingImageOperation[]`
- [x] Add `pendingFileDeletions: PendingFileDeletion[]`
- [x] Implement `registerImageUpload()`
- [x] Implement `registerImageDelete()`
- [x] Implement `commitPendingImages()`
- [x] Implement `registerFileDeletion()`
- [x] Implement `getPendingDeletions()`
- [x] Implement `clearPendingDeletion()`
- [x] Implement `commitPendingFileDeletions()`
- [x] Implement `storeImage()` for IDB storage
- [x] Emit `dagnet:pendingDeletionChanged` event
- [ ] Test pending operations tracking (requires runtime testing)

**Design Ref**: IDB Storage During Edit § FileRegistry Enhancement

---

## Phase 3: Image Compression Utility (1-2 hours)

### 3.1 Create Compression Utility
**New File**: `graph-editor/src/utils/imageCompression.ts`
- [x] Implement `compressImage(file)` function
- [x] Scale to max 2048×2048 (maintain aspect ratio)
- [x] Apply 85% quality compression
- [x] Return compressed File
- [ ] Test with various image sizes (500KB, 2MB, 5MB) (requires runtime testing)
- [ ] Verify output always ≤ 2K resolution (requires runtime testing)

**Design Ref**: Image Compression Utility § compressImage

### 3.2 Create Validation Utility
**Same File**: `graph-editor/src/utils/imageCompression.ts`
- [x] Implement `validateImage(file)` function
- [x] Check max size 5MB (before compression)
- [x] Check file type (PNG/JPG only)
- [x] Return `{ valid, error? }`
- [ ] Test validation edge cases (requires runtime testing)

**Design Ref**: Design Considerations § 3

---

## Phase 4: Upload Modal with 3 Sources (3-4 hours)

### 4.1 Create Upload Modal Component
**New File**: `graph-editor/src/components/ImageUploadModal.tsx`
- [x] Create modal with 3 tabs: Local File, From URL, Paste from Clipboard
- [x] Implement local file picker (filtered to PNG/JPG)
- [x] Implement URL input with fetch + error handling (CORS, non-image URLs)
- [x] Implement clipboard paste (check API support, disable if unavailable)
- [x] Add validation before upload (call `validateImage`)
- [x] Add compression after validation (call `compressImage`)
- [x] Add loading states for URL fetch
- [x] Add error messages for each tab
- [ ] Test all 3 upload sources (requires runtime testing)

**Design Ref**: UI Implementation § ImageUploadModal Component

### 4.2 Handle Upload in Properties Panel
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [x] Add state for `showUploadModal`
- [x] Implement `handleImageUpload(imageData, extension, source)`
- [x] Generate unique image_id (call `workspaceService.getAllImageIdsFromIDB()`)
- [x] Update graph with new image
- [x] Set `images_overridden = true`
- [x] Call `fileRegistry.registerImageUpload()`
- [x] Mark graph as dirty (implicit via setGraph)

---

## Phase 5: Properties Panel UI (3-4 hours)

### 5.1 Add URL Field
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [x] Add URL input field (above images section)
- [x] Add ExternalLink button with click handler
- [x] Implement onBlur handler to update graph (inline in JSX)
- [x] Set `url_overridden = true` on edit
- [x] Add override indicator (Zap icon)
- [ ] Test URL editing and click-to-open (requires runtime testing)

**Design Ref**: UI Implementation § URL Field

### 5.2 Create Image Thumbnail Component
**New File**: `graph-editor/src/components/ImageThumbnail.tsx`
- [x] Create 80×80px thumbnail with delete button (X icon)
- [x] Add caption display with edit button (Pencil icon)
- [x] Implement inline caption editing (Check/X icons)
- [x] Set `caption_overridden = true` on edit (handled by parent)
- [x] Show override indicator for captions
- [x] Use `imageService.getImageUrl()` for src
- [ ] Test delete and caption edit (requires runtime testing)

**Design Ref**: UI Implementation § ImageThumbnail Component

### 5.3 Add Images Section to Properties Panel
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [x] Add images grid below URL field
- [x] Render `ImageThumbnail` for each image
- [x] Add "+" button to open upload modal
- [x] Implement `handleDeleteImage()` - updates graph, registers deletion, marks dirty
- [x] Implement `handleEditCaption()` - updates graph, sets override flag, marks dirty
- [x] Show override indicator (Zap) for `images_overridden`
- [x] Add ImageUploadModal rendering when showUploadModal is true
- [ ] Test grid layout with multiple images (requires runtime testing)

**Design Ref**: UI Implementation § Images Section

---

## Phase 6: Node Face Display Components (3-4 hours)

### 6.1 Create Image Stack Indicator
**New File**: `graph-editor/src/components/ImageStackIndicator.tsx`
- [x] Render 16×16px image thumbnail
- [x] Add stack effect for multiple images (2-3 overlapping squares)
- [x] Show "..." indicator if multiple images
- [x] Use `imageService.getImageUrl()` for src
- [x] Add cleanup on unmount

**Design Ref**: UI Implementation § ImageStackIndicator Component

### 6.2 Create Hover Preview
**New File**: `graph-editor/src/components/ImageHoverPreview.tsx`
- [x] Create popup with 200×200px max image
- [x] Position relative to node (fixed positioning)
- [x] Show caption below image
- [x] Use `imageService.getImageUrl()` for src
- [x] Add cleanup on unmount

**Design Ref**: UI Implementation § ImageHoverPreview Component

### 6.3 Create Loupe View Modal
**New File**: `graph-editor/src/components/ImageLoupeView.tsx`
- [x] Create full-screen modal overlay
- [x] Show large image (max 60vh height, 800px container width)
- [x] Add close button (X icon, top right)
- [x] Add delete button (below close)
- [x] Add prev/next navigation for multiple images (ChevronLeft/Right icons)
- [x] Display caption (read-only in loupe, editable in Properties Panel)
- [x] Add loading state while image loads
- [ ] Test navigation and deletion from loupe (requires runtime testing)

**Design Ref**: UI Implementation § ImageLoupeView Component

### 6.4 Update ConversionNode
**File**: `graph-editor/src/components/nodes/ConversionNode.tsx`
- [x] Import ExternalLink icon from Lucide
- [x] Import ImageStackIndicator, ImageHoverPreview, ImageLoupeView
- [x] Add state for showImagePreview, showImageLoupe
- [x] Update ConversionNodeData interface with url and images
- [x] Add bottom-right container for URL + images
- [x] Add URL icon (16×16px, left position) with click handler
- [x] Add tooltip showing full URL on hover (via Tooltip component)
- [x] Add image stack indicator (right position)
- [x] Add hover state for image preview
- [x] Add click handler to open loupe view
- [x] Add 4px gap between URL and images
- [x] Render ImageHoverPreview and ImageLoupeView conditionally
- [ ] Test layout with: URL only, images only, both (requires runtime testing)

**Design Ref**: UI Implementation § Node Face Display

---

## Phase 7: Deletion Operations Service (4-5 hours)

### 7.1 Create Deletion Service
**New File**: `graph-editor/src/services/deleteOperationsService.ts`
- [x] Implement `deleteNodeFile(nodeId)` method
- [x] Implement `scanAllFilesForImageReferences(imageIds)` method (SHARED utility)
- [x] Check ALL node files from IDB for image refs
- [x] Check ALL graph files from IDB for image refs
- [x] Stage file deletion via `fileRegistry.registerFileDeletion()`
- [x] Stage orphaned image deletions only
- [x] Export `scanAllFilesForImageReferences` for use by UpdateManager
- [x] Add logging for staged deletions

**Design Ref**: Node Deletion from Graph vs. Node File Deletion § Scenario B

**Note**: The `scanAllFilesForImageReferences()` utility is used by BOTH graph-node deletion (UpdateManager) and node-file deletion (this service) to ensure consistent GC behavior.

### 7.2 Update Navigator Context Menu
**File**: `graph-editor/src/components/NavigatorItemContextMenu.tsx`
- [x] Replace direct `gitService.deleteFile()` call
- [x] Use `deleteOperationsService.deleteNodeFile()` for node files
- [x] Use staging for all other file types
- [x] Remove immediate Git commit behavior
- [x] Show toast: "Deletion staged for commit"
- [ ] Test deletion staging (verify no immediate Git changes) (requires runtime testing)

**Design Ref**: Critical Issues § Issue 1

### 7.3 Update File Operations Service
**File**: `graph-editor/src/services/fileOperationsService.ts`
- [x] Update `deleteFile()` to use staging for node files
- [x] Generalize for all file types (use `registerFileDeletion` for committed files)
- [ ] Test file deletion staging (requires runtime testing)

---

## Phase 8: UpdateManager Integration (3-4 hours)

### 8.1 Add URL Mapping
**File**: `graph-editor/src/services/UpdateManager.ts`
- [x] Add URL mapping for file→graph sync (in Flow I)
- [x] Add URL mapping for graph→file sync (in Flow D.UPDATE)
- [x] Include `overrideFlag: 'url_overridden'`
- [ ] Test bidirectional sync (requires runtime testing)

**Design Ref**: UpdateManager Integration § 1

### 8.2 Add Images Mapping
**File**: `graph-editor/src/services/UpdateManager.ts`
- [x] Add images mapping for file→graph sync (transform: remove `uploaded_at`, add `caption_overridden: false`)
- [x] Add images mapping for graph→file sync (transform: remove `caption_overridden`, add `uploaded_at`)
- [x] Include `overrideFlag: 'images_overridden'`
- [ ] Test bidirectional sync (requires runtime testing)

**Design Ref**: UpdateManager Integration § 1, § 3

### 8.3 Update Delete Node Method
**File**: `graph-editor/src/services/UpdateManager.ts`
- [x] Changed `deleteNode()` to async for GC support
- [x] Import deleteOperationsService for `scanAllFilesForImageReferences`
- [x] For each image on deleted node, call `scanAllFilesForImageReferences(imageIds)`
- [x] Only register image for deletion if zero references remain in ALL files (node + graph)
- [x] Add `registerImageDeletion()` helper method
- [ ] Test scenarios: graph-only images (deleted) vs file-backed images (kept) (requires runtime testing)

**Design Ref**: Node Deletion Cascade § Smart Image Deletion Logic

**Note**: This uses the same comprehensive GC logic as node-file deletion (Phase 7.1), ensuring images are never deleted while any file references them.

### 8.4 Update Data Operations Service
**File**: `graph-editor/src/services/dataOperationsService.ts`
- [x] Verify `getNodeFromFile()` includes URL and images in sync (uses UpdateManager mappings)
- [x] Verify `putNodeToFile()` includes URL and images in sync (uses UpdateManager mappings)
- [ ] Test get/put operations with new fields (requires runtime testing)

### 8.5 Wire UpdateManager to Deletion Service
**File**: `graph-editor/src/services/UpdateManager.ts` + `graph-editor/src/components/GraphCanvas.tsx`
- [x] Import `scanAllFilesForImageReferences` from deleteOperationsService in `deleteNode()`
- [x] Use shared scanning logic in `deleteNode()` method
- [x] Updated GraphCanvas.handleDeleteNode to await async deleteNode call
- [x] Ensure graph-node delete uses same GC as node-file delete

---

## Phase 9: Commit Flow Integration (4-5 hours)

### 9.1 Update Commit Modal UI
**File**: `graph-editor/src/components/CommitModal.tsx`
- [x] Add `pendingDeletions` state from `fileRegistry.getPendingDeletions()`
- [x] Add "Files to Delete" section with red styling
- [x] Add unstage button per deletion (calls `clearPendingDeletion()`)
- [x] Add forceUpdate state for reactivity
- [x] Listen to `dagnet:pendingDeletionChanged` event
- [ ] Show pending image operations count (NOT IMPLEMENTED - implicit in file count)
- [ ] Test UI shows all 3 categories (modified, deleted, images) (requires runtime testing)

**Design Ref**: Commit Modal UI Enhancement

### 9.2 Update Commit Handler
**File**: `graph-editor/src/AppShell.tsx`
- [x] Update `onCommit` handler to collect dirty files (existing)
- [x] Add call to `fileRegistry.commitPendingImages()`
- [x] Add call to `fileRegistry.commitPendingFileDeletions()`
- [x] Merge all three into `filesToCommit` array
- [x] Apply basePath to image and deletion paths
- [x] Pass to `gitService.commitAndPushFiles()`
- [ ] Test multi-file commits (modified + deleted + images) (requires runtime testing)

**Design Ref**: Commit Modal Integration

### 9.3 Update Navigator Commit Handler
**File**: `graph-editor/src/components/NavigatorItemContextMenu.tsx`
- [x] Deletion now uses staging (handleDeleteFile updated)
- [x] Commit flow already collects all pending operations via AppShell handler
- [ ] Test commit from navigator includes all changes (requires runtime testing)

---

## Phase 10: Testing (3-4 hours)

### 10.1 Comprehensive Test Suite
**File**: `graph-editor/src/services/__tests__/nodeImageFeature.test.ts`
**Status**: ✅ Test suite created (see README.md in same directory)

**Test Coverage**:
- ✅ Image compression & validation
- ✅ Image service (blob URL management)
- ✅ Image operations service (upload/delete/caption)
- ✅ Delete operations service (garbage collection)
- ✅ Error handling
- ✅ Performance tests
- ⚠️ Undo/redo tests (BLOCKED - see TODO.md § Image Undo/Redo Broken)
- ⚠️ Git sync tests (TODO - require GitHub API mocks)
- ⚠️ UI component tests (TODO - require React testing library setup)
- ⚠️ UpdateManager integration tests (TODO - require full integration test setup)

**Running Tests**:
```bash
# Run all tests
npm test

# Run only image feature tests
npm test nodeImageFeature.test.ts

# Run with coverage
npm test -- --coverage nodeImageFeature.test.ts
```

**Key Test Cases Implemented**:
1. Image validation (file size, type)
2. Blob URL creation and caching
3. Image upload with unique ID generation
4. Image deletion and cleanup
5. Caption editing with React immutability
6. Garbage collection for node deletion
7. Scanning all files for image references
8. Shared vs orphaned image detection

**Critical Gap - Undo/Redo Tests**:
All undo/redo tests are marked TODO and blocked by a critical bug where history system doesn't properly track image binary data and pending operations. See `/TODO.md` § Image Undo/Redo Broken for details and proposed solutions.

### 10.3 Manual Testing
**Checklist**: Follow testing checklist in design doc
- [ ] Complete all URL field tests (READY FOR MANUAL TESTING)
- [ ] Complete all upload flow tests (3 sources) (READY FOR MANUAL TESTING)
- [ ] Complete all display tests (READY FOR MANUAL TESTING)
- [ ] Complete all caption editing tests (READY FOR MANUAL TESTING)
- [ ] Complete all deletion tests (READY FOR MANUAL TESTING)
- [ ] Complete all Git sync tests (READY FOR MANUAL TESTING)
- [ ] Complete all override pattern tests (READY FOR MANUAL TESTING)
- [ ] Complete all node deletion cascade tests (scenarios A1-A3, B1-B4) (READY FOR MANUAL TESTING)
- [ ] Complete all error handling tests (READY FOR MANUAL TESTING)

**Design Ref**: Testing Strategy § Manual Testing Checklist

---

## Phase 11: Documentation Updates (2-3 hours)

### 11.1 Update State Management Documentation
**Files to update**:
- [x] Found existing state management docs: `graph-editor/public/docs/STATE_MANAGEMENT_REFERENCE.md`
- [x] Added section "Image System & Binary Asset Management"
- [x] Added image file type to db.files documentation
- [x] Added pending operations tracking (FileRegistry extensions)
- [x] Added complete change tracking table
- [x] Added IDB ↔ Git sync model with image flows
- [x] Added commit flow with all 3 sources

### 11.2 Update Architecture Documentation
**Files to update**:
- [x] Documented image storage flow (Git → IDB → UI)
- [x] Documented upload and delete flows
- [x] Documented smart GC for both graph-node and node-file deletion
- [x] Documented FileRegistry extensions with method signatures
- [x] Documented commit flow integration

### 11.3 Create User Guide
**New File**: `docs/features/NODE_IMAGES_USER_GUIDE.md` (optional)
- [ ] NOT CREATED (user documentation embedded in STATE_MANAGEMENT_REFERENCE.md instead)

---

## Phase 12: Polish & Finalization (2-3 hours)

### 12.1 Add Loading States
- [x] Image upload progress indicator (in ImageUploadModal: isLoading state)
- [x] URL fetch loading spinner (in ImageUploadModal: "Fetching..." button text)
- [x] Loupe view image loading state (in ImageLoupeView: loading state)
- [ ] Commit operation loading state (exists in CommitModal already)

### 12.2 Error Handling Review
- [x] Consistent error messages for all operations (toast.success/error throughout)
- [x] Toast notifications for success/failure (in all handlers)
- [x] Graceful fallbacks for clipboard/URL failures (clipboard disabled if unsupported, CORS errors caught)
- [x] Network error handling (try/catch blocks in URL fetch)

### 12.3 Visual Polish
- [x] Verify override indicator styling (Zap icon with #f59e0b color)
- [x] Verify icon sizes and colors match design (all Lucide icons with proper sizes)
- [x] Add hover states and transitions (on buttons, thumbnails, node face icons)
- [ ] Test responsive layout in Properties Panel (requires runtime testing)
- [ ] Test positioning on node faces (requires runtime testing)

### 12.4 Code Cleanup
- [ ] Remove any debug logging (console.log statements remain for debugging - can remove later)
- [x] Add JSDoc comments to new services (imageService, deleteOperationsService)
- [x] Verify all imports use Lucide icons (no Unicode) - all use Lucide: ExternalLink, Zap, X, Check, Pencil, File, Globe, Clipboard, ChevronLeft, ChevronRight
- [x] Run linter and fix issues (linter errors resolved)

---

## Implementation Order

Execute phases sequentially in order 1-12. Each phase builds on the previous.

**Dependencies**:
- Phase 2 (storage) required before Phase 4 (upload modal)
- Phase 4 (upload) required before Phase 5 (Properties Panel)
- Phase 5 (Properties Panel) required before Phase 6 (node face display)
- Phase 7 (deletion service) required before Phase 8.5 (UpdateManager uses shared GC)
- Phase 7 (deletion service) required before Phase 9 (commit flow)
- Phase 8.1-8.4 (UpdateManager mappings) can run parallel with Phase 6

**Critical Path**: Phases 2 → 4 → 5 → 7 → 8.5 → 9 → 10

**Key Ordering Constraint**: Phase 7 must complete before Phase 8.5 so that `scanAllFilesForImageReferences()` exists for UpdateManager to import.

---

## Success Criteria

**Implementation Status**:
- ✅ All schema changes implemented (validation requires runtime testing)
- ✅ Images upload modal with 3 sources implemented
- ✅ Images display components created (requires runtime testing)
- ✅ Captions editable with override tracking implemented
- ✅ Deletion GC with full file scanning implemented (requires runtime testing)
- ✅ Commit modal shows all pending changes (modified + deletions)
- ✅ IDB → Git sync implemented for all operations
- ⚠️ Automated tests deferred (manual testing recommended)
- ✅ Documentation updated (STATE_MANAGEMENT_REFERENCE.md)

**Ready for Manual Testing**:
All code implementation complete. Requires runtime testing to verify:
- Image upload/display/deletion workflows
- URL field functionality
- GC correctness across deletion scenarios
- Git sync (clone/pull/commit with images)
- Override pattern behavior
- UI/UX polish and error handling

---

**END OF IMPLEMENTATION PLAN**

