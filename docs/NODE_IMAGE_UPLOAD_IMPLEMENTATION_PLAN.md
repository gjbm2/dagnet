# Node Image Upload Feature - Implementation Plan

**Design Reference**: [NODE_IMAGE_UPLOAD_FEATURE_PLAN.md](./NODE_IMAGE_UPLOAD_FEATURE_PLAN.md)  
**Estimated Effort**: 29-38 hours  
**Status**: Ready for implementation

---

## Phase 1: Schema Updates (2-3 hours)

### 1.1 Update Node Schema
**File**: `graph-editor/public/param-schemas/node-schema.yaml`
- [ ] Add `url` field (format: uri)
- [ ] Add `images` array with properties: `image_id`, `caption`, `file_extension`, `uploaded_at`, `uploaded_by`
- [ ] Test schema validation

**Design Ref**: Schema Changes § 1

### 1.2 Update Graph Schema
**File**: `graph-editor/public/schemas/conversion-graph-1.0.0.json`
- [ ] Add `url` and `url_overridden` to Node definition
- [ ] Add `images` array to Node definition (with `caption_overridden` per item)
- [ ] Add `images_overridden` to Node definition
- [ ] Test schema validation

**Design Ref**: Schema Changes § 2

### 1.3 Update TypeScript Types
**File**: `graph-editor/src/types/index.ts`
- [ ] Add `NodeImage` interface
- [ ] Add `url`, `url_overridden`, `images`, `images_overridden` to `GraphNode`
- [ ] Add `url`, `images` to `Node` (registry)

**Design Ref**: Schema Changes § 3

### 1.4 Update Python Types (if needed)
**File**: `graph-editor/api/lib/graph_types.py`
- [ ] Add image fields to Node class
- [ ] Test Python validation

---

## Phase 2: Image Storage & Serving Infrastructure (4-5 hours)

### 2.1 Create Image Service
**New File**: `graph-editor/src/services/imageService.ts`
- [ ] Implement `getImageUrl(imageId, ext)` - converts IDB binary to blob URL
- [ ] Implement blob URL caching
- [ ] Implement `revokeImageUrl()` cleanup
- [ ] Test blob URL generation

**Design Ref**: Storage Architecture § Image Serving from IDB

### 2.2 Enhance Git Service for Binary Files
**File**: `graph-editor/src/services/gitService.ts`
- [ ] Add `encoding` parameter to `createOrUpdateFile()`
- [ ] Update `commitAndPushFiles()` to handle `GitFileToCommit` with `binaryContent`
- [ ] Add base64 encoding for binary data
- [ ] Add deletion support (check `file.delete` flag, call DELETE API)
- [ ] Test binary upload/download via GitHub API

**Design Ref**: Git Sync Strategy § Enhancement Needed

### 2.3 Extend Workspace Service
**File**: `graph-editor/src/services/workspaceService.ts`
- [ ] Add `fetchAllImagesFromGit()` method
- [ ] Update `pullLatest()` to fetch images from `/nodes/images/`
- [ ] Update `cloneWorkspace()` to fetch images
- [ ] Add `getAllNodeFilesFromIDB()` helper
- [ ] Add `getAllGraphFilesFromIDB()` helper
- [ ] Add `getAllImageIdsFromIDB()` helper
- [ ] Test image fetching on clone/pull

**Design Ref**: Git Pull § Syncing Images from Repository to IDB

### 2.4 Extend File Registry
**File**: `graph-editor/src/contexts/TabContext.tsx`
- [ ] Add `pendingImageOps: PendingImageOperation[]`
- [ ] Add `pendingFileDeletions: PendingFileDeletion[]`
- [ ] Implement `registerImageUpload()`
- [ ] Implement `registerImageDelete()`
- [ ] Implement `commitPendingImages()`
- [ ] Implement `registerFileDeletion()`
- [ ] Implement `getPendingDeletions()`
- [ ] Implement `clearPendingDeletion()`
- [ ] Implement `commitPendingFileDeletions()`
- [ ] Implement `storeImage()` for IDB storage
- [ ] Emit `dagnet:pendingDeletionChanged` event
- [ ] Test pending operations tracking

**Design Ref**: IDB Storage During Edit § FileRegistry Enhancement

---

## Phase 3: Image Compression Utility (1-2 hours)

### 3.1 Create Compression Utility
**New File**: `graph-editor/src/utils/imageCompression.ts`
- [ ] Implement `compressImage(file)` function
- [ ] Scale to max 2048×2048 (maintain aspect ratio)
- [ ] Apply 85% quality compression
- [ ] Return compressed File
- [ ] Test with various image sizes (500KB, 2MB, 5MB)
- [ ] Verify output always ≤ 2K resolution

**Design Ref**: Image Compression Utility § compressImage

### 3.2 Create Validation Utility
**Same File**: `graph-editor/src/utils/imageCompression.ts`
- [ ] Implement `validateImage(file)` function
- [ ] Check max size 5MB (before compression)
- [ ] Check file type (PNG/JPG only)
- [ ] Return `{ valid, error? }`
- [ ] Test validation edge cases

**Design Ref**: Design Considerations § 3

---

## Phase 4: Upload Modal with 3 Sources (3-4 hours)

### 4.1 Create Upload Modal Component
**New File**: `graph-editor/src/components/ImageUploadModal.tsx`
- [ ] Create modal with 3 tabs: Local File, From URL, Paste from Clipboard
- [ ] Implement local file picker (filtered to PNG/JPG)
- [ ] Implement URL input with fetch + error handling (CORS, non-image URLs)
- [ ] Implement clipboard paste (check API support, disable if unavailable)
- [ ] Add validation before upload (call `validateImage`)
- [ ] Add compression after validation (call `compressImage`)
- [ ] Add loading states for URL fetch
- [ ] Add error messages for each tab
- [ ] Test all 3 upload sources

**Design Ref**: UI Implementation § ImageUploadModal Component

### 4.2 Handle Upload in Properties Panel
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [ ] Add state for `showUploadModal`
- [ ] Implement `handleImageUpload(imageData, extension, source)`
- [ ] Generate unique image_id (call `workspaceService.getAllImageIdsFromIDB()`)
- [ ] Update graph with new image
- [ ] Set `images_overridden = true`
- [ ] Call `fileRegistry.registerImageUpload()`
- [ ] Mark graph as dirty

---

## Phase 5: Properties Panel UI (3-4 hours)

### 5.1 Add URL Field
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [ ] Add URL input field (above images section)
- [ ] Add ExternalLink button with click handler
- [ ] Implement `handleUrlBlur()` to update graph
- [ ] Set `url_overridden = true` on edit
- [ ] Add override indicator (Zap icon)
- [ ] Test URL editing and click-to-open

**Design Ref**: UI Implementation § URL Field

### 5.2 Create Image Thumbnail Component
**New File**: `graph-editor/src/components/ImageThumbnail.tsx`
- [ ] Create 80×80px thumbnail with delete button (X icon)
- [ ] Add caption display with edit button (Pencil icon)
- [ ] Implement inline caption editing (Check/X icons)
- [ ] Set `caption_overridden = true` on edit
- [ ] Show override indicator for captions
- [ ] Use `imageService.getImageUrl()` for src
- [ ] Test delete and caption edit

**Design Ref**: UI Implementation § ImageThumbnail Component

### 5.3 Add Images Section to Properties Panel
**File**: `graph-editor/src/components/PropertiesPanel.tsx`
- [ ] Add images grid below URL field
- [ ] Render `ImageThumbnail` for each image
- [ ] Add "+" button to open upload modal
- [ ] Implement `handleDeleteImage()` - updates graph, registers deletion, marks dirty
- [ ] Implement `handleEditCaption()` - updates graph, sets override flag, marks dirty
- [ ] Show override indicator (Zap) for `images_overridden`
- [ ] Test grid layout with multiple images

**Design Ref**: UI Implementation § Images Section

---

## Phase 6: Node Face Display Components (3-4 hours)

### 6.1 Create Image Stack Indicator
**New File**: `graph-editor/src/components/ImageStackIndicator.tsx`
- [ ] Render 16×16px image thumbnail
- [ ] Add stack effect for multiple images (2-3 overlapping squares)
- [ ] Show "..." indicator if multiple images
- [ ] Use `imageService.getImageUrl()` for src

**Design Ref**: UI Implementation § ImageStackIndicator Component

### 6.2 Create Hover Preview
**New File**: `graph-editor/src/components/ImageHoverPreview.tsx`
- [ ] Create popup with 200×200px max image
- [ ] Position relative to node
- [ ] Show caption below image
- [ ] Use `imageService.getImageUrl()` for src

**Design Ref**: UI Implementation § ImageHoverPreview Component

### 6.3 Create Loupe View Modal
**New File**: `graph-editor/src/components/ImageLoupeView.tsx`
- [ ] Create full-screen modal overlay
- [ ] Show large image (max 800px width)
- [ ] Add close button (X icon, top right)
- [ ] Add delete button (below close)
- [ ] Add prev/next navigation for multiple images
- [ ] Integrate caption editing (reuse ImageThumbnail logic)
- [ ] Add loading state while image loads
- [ ] Test navigation and deletion from loupe

**Design Ref**: UI Implementation § ImageLoupeView Component

### 6.4 Update ConversionNode
**File**: `graph-editor/src/components/nodes/ConversionNode.tsx`
- [ ] Import ExternalLink icon from Lucide
- [ ] Add bottom-right container for URL + images
- [ ] Add URL icon (16×16px, left position) with click handler
- [ ] Add tooltip showing full URL on hover
- [ ] Add image stack indicator (right position)
- [ ] Add hover state for image preview
- [ ] Add click handler to open loupe view
- [ ] Add 4px gap between URL and images
- [ ] Test layout with: URL only, images only, both

**Design Ref**: UI Implementation § Node Face Display

---

## Phase 7: Deletion Operations Service (4-5 hours)

### 7.1 Create Deletion Service
**New File**: `graph-editor/src/services/deleteOperationsService.ts`
- [ ] Implement `deleteNodeFile(nodeId)` method
- [ ] Implement `scanAllFilesForImageReferences(imageIds)` method (SHARED utility)
- [ ] Check ALL node files from IDB for image refs
- [ ] Check ALL graph files from IDB for image refs
- [ ] Stage file deletion via `fileRegistry.registerFileDeletion()`
- [ ] Stage orphaned image deletions only
- [ ] Export `scanAllFilesForImageReferences` for use by UpdateManager
- [ ] Add logging for staged deletions

**Design Ref**: Node Deletion from Graph vs. Node File Deletion § Scenario B

**Note**: The `scanAllFilesForImageReferences()` utility is used by BOTH graph-node deletion (UpdateManager) and node-file deletion (this service) to ensure consistent GC behavior.

### 7.2 Update Navigator Context Menu
**File**: `graph-editor/src/components/NavigatorItemContextMenu.tsx`
- [ ] Replace direct `gitService.deleteFile()` call
- [ ] Use `deleteOperationsService.deleteNodeFile()` instead
- [ ] Remove immediate Git commit behavior
- [ ] Show toast: "Deletion staged for commit"
- [ ] Test deletion staging (verify no immediate Git changes)

**Design Ref**: Critical Issues § Issue 1

### 7.3 Update File Operations Service
**File**: `graph-editor/src/services/fileOperationsService.ts`
- [ ] Update `deleteFile()` to use staging for node files
- [ ] Keep existing behavior for non-node files (or generalize)
- [ ] Test file deletion staging

---

## Phase 8: UpdateManager Integration (3-4 hours)

### 8.1 Add URL Mapping
**File**: `graph-editor/src/services/UpdateManager.ts`
- [ ] Add URL mapping for file→graph sync
- [ ] Add URL mapping for graph→file sync
- [ ] Include `overrideField: 'url_overridden'`
- [ ] Test bidirectional sync

**Design Ref**: UpdateManager Integration § 1

### 8.2 Add Images Mapping
**File**: `graph-editor/src/services/UpdateManager.ts`
- [ ] Add images mapping for file→graph sync (transform: remove `uploaded_at`, add `caption_overridden: false`)
- [ ] Add images mapping for graph→file sync (transform: remove `caption_overridden`, add `uploaded_at`)
- [ ] Include `overrideField: 'images_overridden'`
- [ ] Test bidirectional sync

**Design Ref**: UpdateManager Integration § 1, § 3

### 8.3 Update Delete Node Method
**File**: `graph-editor/src/services/UpdateManager.ts`
- [ ] Enhance `deleteNode()` to use full reference scanning
- [ ] For each image on deleted node, call `scanAllFilesForImageReferences([image_id])`
- [ ] Only register image for deletion if zero references remain in ALL files (node + graph)
- [ ] Add `registerImageDeletions()` helper method
- [ ] Test scenarios: graph-only images (deleted) vs file-backed images (kept)

**Design Ref**: Node Deletion Cascade § Smart Image Deletion Logic

**Note**: This uses the same comprehensive GC logic as node-file deletion (Phase 7.1), ensuring images are never deleted while any file references them.

### 8.4 Update Data Operations Service
**File**: `graph-editor/src/services/dataOperationsService.ts`
- [ ] Verify `getNodeFromFile()` includes URL and images in sync
- [ ] Verify `putNodeToFile()` includes URL and images in sync
- [ ] Test get/put operations with new fields

### 8.5 Wire UpdateManager to Deletion Service
**File**: `graph-editor/src/services/UpdateManager.ts`
- [ ] Import `scanAllFilesForImageReferences` from deleteOperationsService
- [ ] Use shared scanning logic in `deleteNode()` method
- [ ] Ensure graph-node delete uses same GC as node-file delete

---

## Phase 9: Commit Flow Integration (4-5 hours)

### 9.1 Update Commit Modal UI
**File**: `graph-editor/src/components/CommitModal.tsx`
- [ ] Add "Files to Delete" section
- [ ] Call `fileRegistry.getPendingDeletions()` and display
- [ ] Add unstage button per deletion (calls `clearPendingDeletion()`)
- [ ] Show pending image operations count
- [ ] Listen to `dagnet:pendingDeletionChanged` event
- [ ] Test UI shows all 3 categories (modified, deleted, images)

**Design Ref**: Commit Modal UI Enhancement

### 9.2 Update Commit Handler
**File**: `graph-editor/src/AppShell.tsx`
- [ ] Update `onCommit` handler to collect dirty files
- [ ] Add call to `fileRegistry.commitPendingImages()`
- [ ] Add call to `fileRegistry.commitPendingFileDeletions()`
- [ ] Merge all three into `filesToCommit` array
- [ ] Pass to `gitService.commitAndPushFiles()`
- [ ] Test multi-file commits (modified + deleted + images)

**Design Ref**: Commit Modal Integration

### 9.3 Update Navigator Commit Handler
**File**: `graph-editor/src/components/NavigatorItemContextMenu.tsx`
- [ ] Update `handleCommitFiles` to include pending operations
- [ ] Test commit from navigator includes all changes

---

## Phase 10: Testing (3-4 hours)

### 10.1 Unit Tests
**New File**: `graph-editor/src/services/__tests__/imageOperations.test.ts`
- [ ] Test `generateImageId()` uniqueness
- [ ] Test `validateImage()` size/type checks
- [ ] Test `compressImage()` scaling and compression
- [ ] Test `scanAllFilesForImageReferences()` accuracy

### 10.2 Integration Tests
**New File**: `graph-editor/src/services/__tests__/imageSync.integration.test.ts`
- [ ] Test upload → IDB → commit → Git flow
- [ ] Test delete → staging → commit → Git flow
- [ ] Test override pattern (registry sync)
- [ ] Test graph-node deletion GC (scans all files, deletes only orphaned images)
- [ ] Test node-file deletion GC (scans all files, deletes only orphaned images)
- [ ] Test GC correctness: image shared by 2 nodes, delete 1 node → image kept
- [ ] Test Git pull fetches images into IDB

### 10.3 Manual Testing
**Checklist**: Follow testing checklist in design doc
- [ ] Complete all URL field tests
- [ ] Complete all upload flow tests (3 sources)
- [ ] Complete all display tests
- [ ] Complete all caption editing tests
- [ ] Complete all deletion tests
- [ ] Complete all Git sync tests
- [ ] Complete all override pattern tests
- [ ] Complete all node deletion cascade tests (scenarios A1-A3, B1-B4)
- [ ] Complete all error handling tests

**Design Ref**: Testing Strategy § Manual Testing Checklist

---

## Phase 11: Documentation Updates (2-3 hours)

### 11.1 Update State Management Documentation
**Files to update**:
- [ ] Find existing state management docs (search for "state management", "IDB", "Git sync")
- [ ] Add section on image storage and serving
- [ ] Add section on pending operations tracking
- [ ] Update commit flow diagram to include images and deletions
- [ ] Add examples of complete IDB → Git sync cycle

### 11.2 Update Architecture Documentation
**Files to update**:
- [ ] Document `imageService` as new service
- [ ] Document `deleteOperationsService` as new service
- [ ] Update FileRegistry documentation with new methods
- [ ] Update deletion flow documentation

### 11.3 Create User Guide
**New File**: `docs/features/NODE_IMAGES_USER_GUIDE.md` (optional)
- [ ] How to upload images (3 methods)
- [ ] How to edit captions
- [ ] How to delete images
- [ ] How images sync between registry and graphs
- [ ] Override behavior explanation

---

## Phase 12: Polish & Finalization (2-3 hours)

### 12.1 Add Loading States
- [ ] Image upload progress indicator
- [ ] URL fetch loading spinner
- [ ] Loupe view image loading state
- [ ] Commit operation loading state

### 12.2 Error Handling Review
- [ ] Consistent error messages for all operations
- [ ] Toast notifications for success/failure
- [ ] Graceful fallbacks for clipboard/URL failures
- [ ] Network error handling

### 12.3 Visual Polish
- [ ] Verify override indicator styling (Zap icon)
- [ ] Verify icon sizes and colors match design
- [ ] Test responsive layout in Properties Panel
- [ ] Test positioning on node faces
- [ ] Add hover states and transitions

### 12.4 Code Cleanup
- [ ] Remove any debug logging
- [ ] Add JSDoc comments to new services
- [ ] Verify all imports use Lucide icons (no Unicode)
- [ ] Run linter and fix issues

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

**Must Complete Before Merging**:
- ✅ All schema changes validated
- ✅ Images upload/download via 3 sources
- ✅ Images display on node faces and in Properties Panel
- ✅ Captions editable with override tracking
- ✅ Deletion GC works correctly (no orphaned images, no broken refs)
- ✅ Commit modal shows all pending changes
- ✅ IDB → Git sync verified for all operations
- ✅ All tests pass
- ✅ Documentation updated

---

**END OF IMPLEMENTATION PLAN**

