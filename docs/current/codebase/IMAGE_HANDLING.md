# Image Handling

How DagNet uploads, compresses, stores, and serves images attached to graph nodes.

## Upload Flow

1. Validate file (type check, size < 5MB)
2. Compress: scale to max 2048x2048, convert to JPEG (85% quality)
3. Store in IDB as binary Uint8Array with workspace-prefixed fileId
4. Add to FileRegistry memory cache (unprefixed)
5. Update graph with image metadata (image_id, caption, extension)
6. Mark graph dirty

## Serving

`imageService.getImageUrl()` creates blob URLs from IDB binary data. Caches blob URLs in memory. Handles both unprefixed (local) and workspace-prefixed (Git-loaded) fileIds with fallback logic.

## Compression

**Location**: `src/utils/imageCompression.ts`

Always outputs JPEG (PNG is lossless and much larger). Target file sizes 100-300KB for Git efficiency. Logs compression ratio.

## Caption Handling

Auto-numbered (`Image 1`, `Image 2`). Can be manually overridden with `caption_overridden` flag.

## Key Files

| File | Role |
|------|------|
| `src/services/imageOperationsService.ts` | Upload validation, graph metadata update |
| `src/services/imageService.ts` | Blob URL generation, IDB retrieval |
| `src/utils/imageCompression.ts` | Canvas-based JPEG compression |
