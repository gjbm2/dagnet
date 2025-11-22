# Node Image Upload Feature - Implementation Plan

**Status:** 🔵 Design Phase  
**Date:** 2025-11-21  
**Feature:** Allow users to upload and manage images (PNG, JPG) for graph nodes

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Schema Changes](#schema-changes)
3. [Storage Architecture](#storage-architecture)
4. [UI Implementation](#ui-implementation)
5. [Sync & State Management](#sync--state-management)
6. [UpdateManager Integration](#updatemanager-integration)
7. [Implementation Phases](#implementation-phases)
8. [Design Considerations & Open Issues](#design-considerations--open-issues)
9. [Testing Strategy](#testing-strategy)

---

## Executive Summary

### Feature Overview
Add capability for users to attach images to graph nodes with captions. Images are stored in the Git repository and synced alongside other node data. The feature follows established patterns for:
- Overridden flags for graph-level modifications
- File storage in Git repository
- CRUD operations in Properties Panel
- Visual display on node faces

### Key Design Principles
1. **Git-First Storage**: Images stored in repository at `/nodes/images/{image_id}.{ext}`
2. **Override Pattern**: Graph-level images follow standard `_overridden` pattern
3. **UpdateManager Integration**: All file operations go through UpdateManager
4. **Cascade Deletion**: Node deletion automatically removes associated images
5. **Simple CRUD**: Create (upload) and Delete operations only (no update/replace)

---

## Schema Changes

### 1. Node Schema (`node-schema.yaml`)

Add new `url` and `images` fields to node schema:

```yaml
# /graph-editor/public/param-schemas/node-schema.yaml

properties:
  # ... existing properties ...
  
  url:
    type: string
    format: uri
    description: External URL for this node (e.g., Notion page, documentation)
  
  images:
    type: array
    description: Images attached to this node
    items:
      type: object
      required:
        - image_id
        - caption
      properties:
        image_id:
          type: string
          pattern: ^[a-z0-9-]+$
          description: Unique identifier for the image (used as filename)
        caption:
          type: string
          maxLength: 256
          description: Caption/description for the image
        file_extension:
          type: string
          enum: [png, jpg, jpeg]
          description: Image file extension
        uploaded_at:
          type: string
          format: date-time
          description: When this image was uploaded
        uploaded_by:
          type: string
          description: User who uploaded the image
```

### 2. Graph Schema (`conversion-graph-1.0.0.json`)

Add `url` and `images` to Node definition with override pattern:

```json
{
  "$defs": {
    "Node": {
      "properties": {
        // ... existing properties ...
        
        "url": {
          "type": "string",
          "format": "uri",
          "description": "External URL for this node (can override registry node)"
        },
        "url_overridden": {
          "type": "boolean",
          "default": false,
          "description": "If true, URL was manually edited and should not auto-sync from registry"
        },
        
        "images": {
          "type": "array",
          "description": "Images attached to this node (can override registry node)",
          "items": {
            "type": "object",
            "required": ["image_id", "caption"],
            "properties": {
              "image_id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
              "caption": { "type": "string", "maxLength": 256 },
              "caption_overridden": { 
                "type": "boolean", 
                "default": false,
                "description": "If true, caption was manually edited at graph level"
              },
              "file_extension": { 
                "type": "string", 
                "enum": ["png", "jpg", "jpeg"] 
              }
            }
          }
        },
        "images_overridden": {
          "type": "boolean",
          "default": false,
          "description": "If true, images array was manually modified and should not auto-sync from registry"
        }
      }
    }
  }
}
```

### 3. TypeScript Interface (`types/index.ts`)

```typescript
export interface NodeImage {
  image_id: string;
  caption: string;
  caption_overridden?: boolean;  // Graph-level only
  file_extension: 'png' | 'jpg' | 'jpeg';
  uploaded_at?: string;  // Registry-level only
  uploaded_by?: string;  // Registry-level only
}

export interface GraphNode {
  // ... existing properties ...
  url?: string;
  url_overridden?: boolean;
  images?: NodeImage[];
  images_overridden?: boolean;
}

// For node registry files
export interface Node {
  // ... existing properties ...
  url?: string;
  images?: NodeImage[];
}
```

---

## Storage Architecture

### Directory Structure

```
/nodes/
  /images/
    {image_id}.png
    {image_id}.jpg
    checkout-started-diagram.png
    payment-flow-screenshot.jpg
```

### Image ID Generation

Use same pattern as other IDs in the system:

```typescript
// Generate image_id from caption or use timestamp
async function generateImageId(caption: string, nodeId: string): Promise<string> {
  const base = caption 
    ? generateIdFromLabel(caption)  // Existing utility
    : `${nodeId}-img-${Date.now()}`;
  
  // Get all existing image IDs from IDB
  const existingImageIds = await workspaceService.getAllImageIdsFromIDB();
  
  // Ensure uniqueness
  let id = base;
  let counter = 1;
  while (existingImageIds.includes(id)) {
    id = `${base}-${counter}`;
    counter++;
  }
  return id;
}
```

**WorkspaceService Helper**:

```typescript
// In workspaceService.ts
async getAllImageIdsFromIDB(): Promise<string[]> {
  const { db } = await import('../db/appDatabase');
  const imageFiles = await db.files
    .where('type')
    .equals('image')
    .toArray();
  
  return imageFiles.map(f => f.data?.image_id).filter(Boolean);
}
```

### File Storage Strategy

**Option A: Base64 in Graph (Rejected)**
- ❌ Makes graph files huge
- ❌ Poor Git performance (binary diffs)
- ❌ Not human-readable

**Option B: Separate Image Files in Git (RECOMMENDED)**
- ✅ Clean separation of concerns
- ✅ Git LFS compatible (future optimization)
- ✅ Standard web practice
- ✅ Easy to reference from multiple nodes (if needed)
- ⚠️ Requires multi-file commit operations

**Implementation**: Option B with multi-file commits

### Image Serving from IDB

**Storage**: Images pulled from Git into IDB on clone/pull (stored as `Uint8Array`)

**Serving**: `imageService` converts IDB binary data to blob URLs:

```typescript
// imageService.ts
class ImageService {
  private blobUrlCache = new Map<string, string>();
  
  async getImageUrl(imageId: string, ext: string): Promise<string> {
    const cacheKey = `${imageId}.${ext}`;
    
    // Check cache
    if (this.blobUrlCache.has(cacheKey)) {
      return this.blobUrlCache.get(cacheKey)!;
    }
    
    // Load from IDB via FileRegistry
    const imageFile = fileRegistry.getFile(`image-${imageId}`);
    if (!imageFile || !imageFile.data?.binaryData) {
      throw new Error(`Image not found: ${imageId}`);
    }
    
    // Create blob URL
    const blob = new Blob([imageFile.data.binaryData], {
      type: ext === 'png' ? 'image/png' : 'image/jpeg'
    });
    const blobUrl = URL.createObjectURL(blob);
    
    // Cache
    this.blobUrlCache.set(cacheKey, blobUrl);
    
    return blobUrl;
  }
  
  revokeImageUrl(imageId: string, ext: string): void {
    const cacheKey = `${imageId}.${ext}`;
    const blobUrl = this.blobUrlCache.get(cacheKey);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      this.blobUrlCache.delete(cacheKey);
    }
  }
}

export const imageService = new ImageService();
```

**React Usage**:

```tsx
function ImageThumbnail({ image }: { image: NodeImage }) {
  const [imageSrc, setImageSrc] = useState<string>('');
  
  useEffect(() => {
    imageService.getImageUrl(image.image_id, image.file_extension)
      .then(setImageSrc)
      .catch(console.error);
    
    return () => {
      imageService.revokeImageUrl(image.image_id, image.file_extension);
    };
  }, [image.image_id, image.file_extension]);
  
  return <img src={imageSrc} alt={image.caption} />;
}
```

---

## UI Implementation

### 1. Node Properties Panel - Basic Properties Card

**Location**: `PropertiesPanel.tsx`, in "Basic Properties" collapsible section, after existing fields

```tsx
{/* URL Field - above images */}
<div className="url-field" style={{ marginTop: '16px' }}>
  <label style={{ 
    display: 'block', 
    marginBottom: '4px',
    fontSize: '13px',
    fontWeight: 500 
  }}>
    URL
    {node.url_overridden && (
      <span className="overridden-indicator" title="Modified from node file" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <Zap size={12} strokeWidth={2} style={{ color: '#f59e0b' }} />
      </span>
    )}
  </label>
  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
    <input
      type="url"
      value={localNodeData.url || ''}
      onChange={(e) => setLocalNodeData({...localNodeData, url: e.target.value})}
      onBlur={handleUrlBlur}
      placeholder="https://..."
      style={{
        flex: 1,
        fontSize: '13px',
        padding: '6px 8px',
        border: '1px solid #cbd5e1',
        borderRadius: '6px',
        fontFamily: 'monospace'
      }}
    />
    {node.url && (
      <button
        onClick={() => window.open(node.url, '_blank')}
        style={{
          padding: '6px',
          fontSize: '13px',
          border: '1px solid #cbd5e1',
          borderRadius: '6px',
          background: '#f8fafc',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        title="Open URL"
      >
        <ExternalLink size={14} strokeWidth={2} style={{ color: '#64748b' }} />
      </button>
    )}
  </div>
</div>

{/* Images Section - below URL */}
<div className="images-section" style={{ marginTop: '16px' }}>
  <label style={{ 
    display: 'block', 
    marginBottom: '8px',
    fontSize: '13px',
    fontWeight: 500 
  }}>
    Images
    {node.images_overridden && (
      <span className="overridden-indicator" title="Modified from node file" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <Zap size={12} strokeWidth={2} style={{ color: '#f59e0b' }} />
      </span>
    )}
  </label>
  
  <div className="images-grid" style={{
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginBottom: '8px'
  }}>
    {node.images?.map((img, index) => (
      <ImageThumbnail
        key={img.image_id}
        image={img}
        onDelete={() => handleDeleteImage(img.image_id)}
        onCaptionEdit={(newCaption) => handleEditCaption(img.image_id, newCaption)}
        isOverridden={!!node.images_overridden}
      />
    ))}
    
    {/* Add New Image Button */}
    <button
      className="add-image-button"
      onClick={() => setShowUploadModal(true)}
      style={{
        width: '80px',
        height: '80px',
        border: '2px dashed #cbd5e1',
        borderRadius: '8px',
        background: '#f8fafc',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '32px',
        color: '#94a3b8',
        transition: 'all 0.2s'
      }}
      title="Upload new image"
    >
      +
    </button>
  </div>
</div>

{/* Upload Modal */}
{showUploadModal && (
  <ImageUploadModal
    onClose={() => setShowUploadModal(false)}
    onUpload={handleImageUpload}
  />
)}
```

**ImageUploadModal Component** (with 3 tabs):

```tsx
interface ImageUploadModalProps {
  onClose: () => void;
  onUpload: (imageData: Uint8Array, extension: string, source: string) => void;
}

function ImageUploadModal({ onClose, onUpload }: ImageUploadModalProps) {
  const [activeTab, setActiveTab] = useState<'local' | 'url' | 'clipboard'>('local');
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const handleLocalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Validate file
    const validation = await validateImage(file);
    if (!validation.valid) {
      setError(validation.error!);
      return;
    }
    
    // Compress image
    const compressed = await compressImage(file);
    
    // Read as Uint8Array
    const arrayBuffer = await compressed.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    
    onUpload(data, ext, 'local');
    onClose();
  };
  
  const handleUrlUpload = async () => {
    if (!url) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Fetch image from URL
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      
      // Check content type
      const contentType = response.headers.get('content-type');
      if (!contentType?.startsWith('image/')) {
        throw new Error('URL does not point to an image');
      }
      
      const blob = await response.blob();
      const file = new File([blob], 'downloaded-image.png', { type: blob.type });
      
      // Validate and compress
      const validation = await validateImage(file);
      if (!validation.valid) {
        throw new Error(validation.error!);
      }
      
      const compressed = await compressImage(file);
      const arrayBuffer = await compressed.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const ext = blob.type.split('/')[1] || 'png';
      
      onUpload(data, ext, 'url');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch image');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleClipboardPaste = async () => {
    try {
      const items = await navigator.clipboard.read();
      
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const file = new File([blob], 'pasted-image.png', { type });
            
            // Validate and compress
            const validation = await validateImage(file);
            if (!validation.valid) {
              throw new Error(validation.error!);
            }
            
            const compressed = await compressImage(file);
            const arrayBuffer = await compressed.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            const ext = type.split('/')[1] || 'png';
            
            onUpload(data, ext, 'clipboard');
            onClose();
            return;
          }
        }
      }
      
      setError('No image found in clipboard');
    } catch (err) {
      setError('Failed to read clipboard. Please use Ctrl+V or paste manually.');
    }
  };
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>Upload Image</h3>
        
        {/* Tabs */}
        <div className="tabs">
          <button 
            className={activeTab === 'local' ? 'active' : ''}
            onClick={() => setActiveTab('local')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <File size={16} /> Local File
          </button>
          <button 
            className={activeTab === 'url' ? 'active' : ''}
            onClick={() => setActiveTab('url')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Globe size={16} /> From URL
          </button>
          <button 
            className={activeTab === 'clipboard' ? 'active' : ''}
            onClick={() => setActiveTab('clipboard')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Clipboard size={16} /> Paste from Clipboard
          </button>
        </div>
        
        {/* Tab Content */}
        <div className="tab-content">
          {activeTab === 'local' && (
            <div>
              <input 
                type="file" 
                accept="image/png,image/jpeg,image/jpg"
                onChange={handleLocalFileUpload}
              />
              <p className="help-text">
                Select a PNG or JPG image. Max 5MB. Images will be compressed automatically.
              </p>
            </div>
          )}
          
          {activeTab === 'url' && (
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/image.png"
                onKeyDown={(e) => e.key === 'Enter' && handleUrlUpload()}
              />
              <button onClick={handleUrlUpload} disabled={!url || isLoading}>
                {isLoading ? 'Fetching...' : 'Upload'}
              </button>
              <p className="help-text">
                Enter a direct link to an image file.
              </p>
            </div>
          )}
          
          {activeTab === 'clipboard' && (
            <div>
              <button onClick={handleClipboardPaste} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Clipboard size={16} /> Paste from Clipboard
              </button>
              <p className="help-text">
                Or press Ctrl+V / Cmd+V after clicking this tab.
              </p>
            </div>
          )}
        </div>
        
        {error && (
          <div className="error-message">{error}</div>
        )}
        
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

**Image Compression Utility**:

```typescript
/**
 * Compress and scale image to reduce file size
 * Max resolution: 2048x2048 (2K) - we never need more
 * Target: < 1MB for most images, maintaining reasonable quality
 */
async function compressImage(file: File): Promise<File> {
  const MAX_WIDTH = 2048;   // 2K max - sufficient for all use cases
  const MAX_HEIGHT = 2048;  // 2K max - sufficient for all use cases
  const QUALITY = 0.85;
  
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      reject(new Error('Canvas not supported'));
      return;
    }
    
    img.onload = () => {
      let { width, height } = img;
      
      // Always scale down to max 2K (maintain aspect ratio)
      // This ensures we never store unnecessarily large images
      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
      }
      
      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress
      ctx.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Compression failed'));
            return;
          }
          
          // If compressed is larger than original, use original
          if (blob.size > file.size) {
            resolve(file);
          } else {
            const compressed = new File([blob], file.name, {
              type: file.type,
              lastModified: Date.now()
            });
            resolve(compressed);
          }
        },
        file.type,
        QUALITY
      );
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}
```

**ImageThumbnail Component**:

```tsx
interface ImageThumbnailProps {
  image: NodeImage;
  onDelete: () => void;
  onCaptionEdit: (newCaption: string) => void;
  isOverridden: boolean;
}

function ImageThumbnail({ image, onDelete, onCaptionEdit, isOverridden }: ImageThumbnailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [caption, setCaption] = useState(image.caption);
  
  const imagePath = `/nodes/images/${image.image_id}.${image.file_extension}`;
  
  return (
    <div className="image-thumbnail" style={{
      width: '80px',
      position: 'relative'
    }}>
      {/* Image Square */}
      <div style={{
        width: '80px',
        height: '80px',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid #e2e8f0',
        background: '#f8fafc',
        position: 'relative'
      }}>
        <img 
          src={imagePath} 
          alt={image.caption}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
        
        {/* Delete Button (top-right corner) */}
        <button
          onClick={onDelete}
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            color: 'white',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          title="Delete image"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      
      {/* Caption */}
      <div style={{ marginTop: '4px' }}>
        {isEditing ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              style={{
                fontSize: '11px',
                padding: '2px 4px',
                border: '1px solid #cbd5e1',
                borderRadius: '3px',
                width: '100%'
              }}
              autoFocus
            />
            <button 
              onClick={() => {
                onCaptionEdit(caption);
                setIsEditing(false);
              }}
              style={{ display: 'flex', alignItems: 'center', padding: '4px' }}
            >
              <Check size={14} strokeWidth={2} style={{ color: '#10b981' }} />
            </button>
            <button 
              onClick={() => {
                setCaption(image.caption);
                setIsEditing(false);
              }}
              style={{ display: 'flex', alignItems: 'center', padding: '4px' }}
            >
              <X size={14} strokeWidth={2} style={{ color: '#ef4444' }} />
            </button>
          </div>
        ) : (
          <div style={{
            fontSize: '11px',
            color: '#64748b',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}>
            <span>{caption}</span>
            <button
              onClick={() => setIsEditing(true)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0',
                display: 'flex',
                alignItems: 'center',
                color: '#94a3b8'
              }}
              title="Edit caption"
            >
              <Pencil size={11} strokeWidth={2} />
            </button>
            {image.caption_overridden && (
              <span className="overridden-indicator" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <Zap size={11} strokeWidth={2} style={{ color: '#f59e0b' }} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

### 2. Node Face Display - Bottom Right

**Location**: `ConversionNode.tsx`, add after the bottom-left icons section (around line 850)

```tsx
{/* Bottom-right URL icon and image preview */}
<div
  style={{
    position: 'absolute',
    right: data.useSankeyView ? 10 : 20,
    bottom: data.useSankeyView ? 10 : 20,
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    pointerEvents: 'auto'
  }}
>
  {/* URL icon (left of images) */}
  {node.url && (
    <Tooltip content={node.url} position="top" delay={200}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          window.open(node.url, '_blank');
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: 3,
          backgroundColor: '#f8fafc',
          border: '1px solid #94a3b8',
          cursor: 'pointer',
          padding: 0,
          transition: 'all 0.2s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#e2e8f0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#f8fafc';
        }}
        title={node.url}
      >
        <ExternalLink size={10} strokeWidth={2} style={{ color: '#64748b' }} />
      </button>
    </Tooltip>
  )}
  
  {/* Image preview (right of URL) */}
  {node.images && node.images.length > 0 && (
    <div
      style={{
        cursor: 'pointer'
      }}
      onClick={(e) => {
        e.stopPropagation();
        setShowImageLoupe(true);
      }}
      onMouseEnter={(e) => {
        e.stopPropagation();
        setShowImagePreview(true);
      }}
      onMouseLeave={(e) => {
        e.stopPropagation();
        setShowImagePreview(false);
      }}
    >
      {/* Image stack indicator */}
      <ImageStackIndicator images={node.images} />
    </div>
  )}
</div>

{/* Hover preview popup */}
{showImagePreview && node.images && node.images[0] && (
  <ImageHoverPreview
    image={node.images[0]}
    nodePosition={{ x: data.layout?.x || 0, y: data.layout?.y || 0 }}
  />
)}

{/* Full loupe view modal */}
{showImageLoupe && (
  <ImageLoupeView
    images={node.images || []}
    onClose={() => setShowImageLoupe(false)}
    onDelete={handleDeleteImageFromNode}
    onCaptionEdit={handleEditCaptionFromNode}
  />
)}
```

**ImageStackIndicator Component**:

```tsx
function ImageStackIndicator({ images }: { images: NodeImage[] }) {
  const firstImage = images[0];
  const hasMultiple = images.length > 1;
  
  return (
    <div style={{ position: 'relative' }}>
      {/* Stack effect - show 2-3 overlapping squares */}
      {hasMultiple && (
        <>
          <div style={{
            position: 'absolute',
            width: '16px',
            height: '16px',
            borderRadius: '3px',
            background: '#fff',
            border: '1px solid #cbd5e1',
            top: '-2px',
            left: '-2px',
            zIndex: 1
          }} />
          <div style={{
            position: 'absolute',
            width: '16px',
            height: '16px',
            borderRadius: '3px',
            background: '#fff',
            border: '1px solid #cbd5e1',
            top: '-1px',
            left: '-1px',
            zIndex: 2
          }} />
        </>
      )}
      
      {/* Front image */}
      <div style={{
        width: '16px',
        height: '16px',
        borderRadius: '3px',
        overflow: 'hidden',
        border: '1px solid #cbd5e1',
        background: '#fff',
        position: 'relative',
        zIndex: 3
      }}>
        <img
          src={`/nodes/images/${firstImage.image_id}.${firstImage.file_extension}`}
          alt={firstImage.caption}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
      </div>
      
      {hasMultiple && (
        <span style={{
          fontSize: '8px',
          color: '#64748b',
          marginLeft: '4px',
          fontWeight: 500
        }}>
          ...
        </span>
      )}
    </div>
  );
}
```

**ImageHoverPreview Component**:

```tsx
function ImageHoverPreview({ 
  image, 
  nodePosition 
}: { 
  image: NodeImage; 
  nodePosition: { x: number; y: number } 
}) {
  return (
    <div
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 9999,
        // Position relative to node (adjust as needed)
        transform: 'translate(-50%, -100%)',
        marginTop: '-10px',
        background: 'white',
        borderRadius: '8px',
        boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
        padding: '8px',
        border: '1px solid #e2e8f0'
      }}
    >
      <img
        src={`/nodes/images/${image.image_id}.${image.file_extension}`}
        alt={image.caption}
        style={{
          maxWidth: '200px',
          maxHeight: '200px',
          display: 'block',
          borderRadius: '4px'
        }}
      />
      <div style={{
        fontSize: '11px',
        color: '#64748b',
        marginTop: '4px',
        textAlign: 'center'
      }}>
        {image.caption}
      </div>
    </div>
  );
}
```

**ImageLoupeView Component** (Modal):

```tsx
function ImageLoupeView({
  images,
  onClose,
  onDelete,
  onCaptionEdit
}: {
  images: NodeImage[];
  onClose: () => void;
  onDelete: (imageId: string) => void;
  onCaptionEdit: (imageId: string, newCaption: string) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentImage = images[currentIndex];
  
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white',
          borderRadius: '12px',
          maxWidth: '800px',
          maxHeight: '90vh',
          overflow: 'auto',
          position: 'relative',
          padding: '24px'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button (top right) */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            width: '32px',
            height: '32px',
            borderRadius: '6px',
            background: '#f1f5f9',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <X size={18} strokeWidth={2} style={{ color: '#64748b' }} />
        </button>
        
        {/* Delete button (top right, below close) */}
        <button
          onClick={() => {
            onDelete(currentImage.image_id);
            if (images.length === 1) {
              onClose();
            } else if (currentIndex === images.length - 1) {
              setCurrentIndex(currentIndex - 1);
            }
          }}
          style={{
            position: 'absolute',
            top: '52px',
            right: '12px',
            padding: '6px 12px',
            borderRadius: '6px',
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            color: '#dc2626',
            cursor: 'pointer',
            fontSize: '13px'
          }}
        >
          Delete
        </button>
        
        {/* Image */}
        <img
          src={`/nodes/images/${currentImage.image_id}.${currentImage.file_extension}`}
          alt={currentImage.caption}
          style={{
            width: '100%',
            maxHeight: '60vh',
            objectFit: 'contain',
            borderRadius: '8px'
          }}
        />
        
        {/* Caption editing (same as in thumbnail) */}
        <div style={{ marginTop: '16px' }}>
          <ImageThumbnail
            image={currentImage}
            onDelete={() => {}}  // Handled by button above
            onCaptionEdit={(newCaption) => onCaptionEdit(currentImage.image_id, newCaption)}
            isOverridden={false}
          />
        </div>
        
        {/* Navigation (if multiple images) */}
        {images.length > 1 && (
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '12px',
            marginTop: '16px'
          }}>
            <button
              onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
              disabled={currentIndex === 0}
            >
              ← Previous
            </button>
            <span>{currentIndex + 1} / {images.length}</span>
            <button
              onClick={() => setCurrentIndex(Math.min(images.length - 1, currentIndex + 1))}
              disabled={currentIndex === images.length - 1}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Sync & State Management

### State Flow Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    USER ACTIONS                          │
├─────────────────────────────────────────────────────────┤
│ 1. Upload Image (Properties Panel)                      │
│ 2. Edit Caption (Properties Panel or Loupe View)        │
│ 3. Delete Image (Properties Panel or Loupe View)        │
│ 4. Link Node to Registry (pulls images from registry)   │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              LOCAL STATE (React)                         │
├─────────────────────────────────────────────────────────┤
│ • Graph context (GraphStore)                            │
│ • FileRegistry (IDB-backed)                             │
│ • Unsaved changes tracking                              │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              UPDATE MANAGER                              │
├─────────────────────────────────────────────────────────┤
│ • Validates image operations                            │
│ • Handles overridden flags                              │
│ • Coordinates graph ↔ file sync                         │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              GIT OPERATIONS                              │
├─────────────────────────────────────────────────────────┤
│ • Multi-file commits (graph + images)                   │
│ • File deletion on image delete                         │
│ • Pull operations sync both                             │
└─────────────────────────────────────────────────────────┘
```

### IDB → Git Sync Tracking

**How local changes are tracked for Git sync:**

1. **File Modifications** → `isDirty` flag
   - Any file edit calls `fileRegistry.updateFile()`
   - Sets `file.isDirty = true`
   - Commit modal collects via `getDirtyFiles()`

2. **Image Uploads** → `pendingImageOps` (type: 'upload')
   - Upload adds to `pendingImageOps[]`
   - Also marks graph file as dirty
   - Commit collects via `commitPendingImages()`

3. **Image Deletions** → `pendingImageOps` (type: 'delete')
   - Delete adds to `pendingImageOps[]`
   - Also marks graph file as dirty
   - Commit collects via `commitPendingImages()`

4. **File Deletions** → `pendingFileDeletions`
   - Delete adds to `pendingFileDeletions[]`
   - Emits `dagnet:pendingDeletionChanged` event
   - Commit modal shows in "Files to Delete" section
   - Commit collects via `commitPendingFileDeletions()`

**Commit Collection Flow**:

```typescript
// In AppShell.tsx onCommit handler
const allChanges = [
  ...dirtyFiles.map(f => ({...f, operation: 'update'})),  // Modified files
  ...await fileRegistry.commitPendingImages(),            // Image uploads/deletes
  ...await fileRegistry.commitPendingFileDeletions()      // File deletions
];

await gitService.commitAndPushFiles(allChanges, message, branch);
```

**Key Guarantees**:
- ✅ All IDB modifications tracked (isDirty flag per file)
- ✅ All IDB deletions tracked (pendingFileDeletions)
- ✅ All image operations tracked (pendingImageOps)
- ✅ Commit modal shows ALL pending changes (modified + deleted + images)
- ✅ Nothing reaches Git until user explicitly commits
- ✅ User can review/select what to commit
- ✅ User can unstage deletions before commit

**Complete Change Tracking Table**:

| Operation | IDB State | Tracking Mechanism | Commit Collection | Git Sync |
|-----------|-----------|-------------------|-------------------|----------|
| Edit file | Modified data | `isDirty = true` | `getDirtyFiles()` | Update/create |
| Delete file | Removed from IDB | `pendingFileDeletions[]` | `commitPendingFileDeletions()` | Delete API call |
| Upload image | Binary in memory | `pendingImageOps[]` (upload) | `commitPendingImages()` | Create w/ base64 |
| Delete image | Ref removed | `pendingImageOps[]` (delete) | `commitPendingImages()` | Delete API call |
| Edit caption | Graph data change | Graph `isDirty = true` | `getDirtyFiles()` | Update graph JSON |

### Image Upload Flow

**Step-by-Step Process**:

1. **User clicks "+" button** in Properties Panel
2. **File picker opens** (filtered to PNG/JPG)
3. **User selects image file**
4. **Generate image_id** from caption or timestamp
5. **Read file as base64** (for IDB storage)
6. **Update graph immediately**:
   ```typescript
   const nextGraph = structuredClone(graph);
   const node = nextGraph.nodes.find(n => n.uuid === nodeUuid);
   if (!node.images) node.images = [];
   node.images.push({
     image_id: imageId,
     caption: `Image ${node.images.length + 1}`,
     file_extension: extension,
   });
   node.images_overridden = true;
   setGraph(nextGraph);
   ```
7. **Store in IDB** (FileRegistry tracks pending image uploads)
8. **Mark graph as dirty**
9. **On commit**: Upload both graph JSON and image file(s)

### Image Delete Flow

**Step-by-Step Process**:

1. **User clicks delete button (X icon)** on image thumbnail or in loupe view
2. **Remove from graph immediately**:
   ```typescript
   const nextGraph = structuredClone(graph);
   const node = nextGraph.nodes.find(n => n.uuid === nodeUuid);
   node.images = node.images.filter(img => img.image_id !== imageId);
   if (node.images.length === 0) {
     delete node.images_overridden;  // Reset if all images removed
   }
   setGraph(nextGraph);
   ```
3. **Track deleted image** in FileRegistry
4. **Mark graph as dirty**
5. **On commit**: 
   - Commit updated graph JSON
   - Delete image file from Git (using GitHub API delete operation)

### Node Deletion from Graph vs. Node File Deletion

**Two Different Deletion Scenarios:**

#### Scenario A: Delete Node from Graph
- User deletes node from graph canvas
- Goes through `UpdateManager.deleteNode()`
- Check: Does node file exist?
  - If YES → Keep images (node file references them)
  - If NO → Stage images for deletion (graph-only images)

#### Scenario B: Delete Node File (from Navigator)
- User right-clicks node file in navigator → Delete
- Currently goes through `gitService.deleteFile()` (IMMEDIATE Git commit!)
- **PROBLEM 1**: Bypasses UpdateManager entirely
- **PROBLEM 2**: Deletes immediately without staging
- **PROBLEM 3**: Doesn't check if graphs still reference the images

### Smart Image Deletion Logic

For **Scenario A (Graph Node Deletion)**: Only delete image files if they're not referenced by node registry files.

**Data Flow Example**:
1. User uploads image → graph node has `image_id: "checkout-flow"`
2. User clicks "Put to Node File" → node file now also has `image_id: "checkout-flow"`
3. User deletes node from graph → **Don't delete image** (node file still references it)

**Alternative Flow**:
1. User uploads image → graph node has `image_id: "temp-diagram"`
2. User does NOT put to file (image only in graph)
3. User deletes node from graph → **Delete image** (no node file references it)

**Location**: `UpdateManager.deleteNode()` (line ~2533)

Add smart image cleanup:

```typescript
deleteNode(graph: any, nodeUuid: string): any {
  const nextGraph = structuredClone(graph);
  
  const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeUuid);
  if (nodeIndex < 0) {
    console.warn('[UpdateManager] deleteNode: Node not found:', nodeUuid);
    return graph;
  }
  
  const node = nextGraph.nodes[nodeIndex];
  const humanId = node.id;
  
  console.log('[UpdateManager] Deleting node:', {
    uuid: nodeUuid,
    humanId: humanId,
    label: node.label,
    hasImages: !!node.images?.length
  });
  
  // Smart image deletion: Only delete if no node file references them
  if (node.images && node.images.length > 0) {
    // Check if node file exists
    const nodeFile = fileRegistry.getFile(`node-${humanId}`);
    
    if (!nodeFile) {
      // No node file exists - images are graph-only, safe to delete
      const imagesToDelete = node.images.map(img => ({
        path: `/nodes/images/${img.image_id}.${img.file_extension}`,
        image_id: img.image_id
      }));
      
      console.log('[UpdateManager] Registering images for deletion (no node file):', {
        nodeId: humanId,
        imageCount: imagesToDelete.length
      });
      
      this.registerImageDeletions(imagesToDelete);
    } else {
      // Node file exists - images may be referenced by it
      // Don't delete images, they belong to the node registry
      console.log('[UpdateManager] Keeping images (node file exists):', {
        nodeId: humanId,
        imageCount: node.images.length
      });
    }
  }
  
  // Remove the node
  nextGraph.nodes = nextGraph.nodes.filter((n: any) => n.uuid !== nodeUuid);
  
  // Remove all edges connected to this node
  const edgesBefore = nextGraph.edges.length;
  nextGraph.edges = nextGraph.edges.filter((e: any) => 
    e.from !== nodeUuid && e.to !== nodeUuid &&
    e.from !== humanId && e.to !== humanId
  );
  const edgesAfter = nextGraph.edges.length;
  const edgesRemoved = edgesBefore - edgesAfter;
  
  console.log('[UpdateManager] Deleted node:', {
    uuid: nodeUuid,
    edgesRemoved: edgesRemoved
  });
  
  // Update metadata
  if (nextGraph.metadata) {
    nextGraph.metadata.updated_at = new Date().toISOString();
  }
  
  // Log audit trail
  this.auditLog.push({
    timestamp: new Date().toISOString(),
    operation: 'deleteNode',
    details: {
      nodeUuid: nodeUuid,
      humanId: humanId,
      edgesRemoved: edgesRemoved
    }
  });
  
  return nextGraph;
}

private registerImageDeletions(images: Array<{ path: string; image_id: string }>) {
  // Store in UpdateManager's pending deletions
  if (!this.pendingImageDeletions) {
    this.pendingImageDeletions = [];
  }
  this.pendingImageDeletions.push(...images);
}
```

**Key Logic**:
- Check if `node-{humanId}` file exists in FileRegistry
- **If node file exists**: Keep images (they're referenced by node file)
- **If node file doesn't exist**: Delete images (they were graph-only)

**Future Enhancement** (optional for v2):
For even more robust reference counting, could scan all node files to check if any reference these image_ids. This would handle edge cases like:
- Multiple node files referencing the same image
- Manual copying of image references between nodes

For v1, the "node file exists" check is sufficient and safe.

### Git Sync Strategy

#### Problem: Multi-File Commits

When user saves a graph with new images, we need to commit:
- The graph JSON file
- One or more image files
- Potentially delete some image files

**Current Commit Flow** (from `gitService.ts`, line ~419):

```typescript
async commitAndPushFiles(
  files: Array<{ path: string; content: string; sha?: string }>,
  message: string,
  branch: string = this.config.branch
): Promise<GitOperationResult>
```

**Enhancement Needed**: Support binary file uploads

```typescript
interface GitFileToCommit {
  path: string;
  content?: string;        // For text files (JSON, YAML)
  binaryContent?: Uint8Array;  // For binary files (images)
  encoding?: 'utf-8' | 'base64';
  sha?: string;
}

async commitAndPushFiles(
  files: Array<GitFileToCommit>,
  message: string,
  branch: string = this.config.branch
): Promise<GitOperationResult> {
  // ... existing code ...
  
  for (const file of files) {
    let content: string;
    let encoding: 'utf-8' | 'base64' = 'utf-8';
    
    if (file.binaryContent) {
      // Convert Uint8Array to base64
      content = btoa(String.fromCharCode(...file.binaryContent));
      encoding = 'base64';
    } else {
      content = file.content!;
      encoding = 'utf-8';
    }
    
    // GitHub API call with encoding parameter
    const result = await this.createOrUpdateFile(
      file.path,
      content,
      message,
      branch,
      fileSha,
      encoding  // <-- Add encoding parameter
    );
    
    // ... rest of existing code ...
  }
}
```

**Enhancement for Deletions**:

```typescript
async commitAndPushFiles(
  files: Array<GitFileToCommit>,
  message: string,
  branch: string = this.config.branch
): Promise<GitOperationResult> {
  // ... existing code ...
  
  for (const file of files) {
    if (file.delete) {
      // Handle deletion via GitHub API
      const result = await this.deleteFile(file.path, message, branch);
      if (!result.success) {
        throw new Error(`Failed to delete ${file.path}: ${result.error}`);
      }
    } else {
      // Handle create/update (existing code)
      let content: string;
      let encoding: 'utf-8' | 'base64' = 'utf-8';
      
      if (file.binaryContent) {
        content = btoa(String.fromCharCode(...file.binaryContent));
        encoding = 'base64';
      } else {
        content = file.content!;
        encoding = 'utf-8';
      }
      
      const result = await this.createOrUpdateFile(
        file.path,
        content,
        message,
        branch,
        fileSha,
        encoding
      );
      
      // ... error handling ...
    }
  }
}
```

#### Git Pull: Syncing Images from Repository to IDB

**Location**: `workspaceService.pullLatest()` (line ~469)

When pulling changes from Git, must also fetch images:

```typescript
async pullLatest(repository: string, branch: string, gitCreds: any): Promise<PullResult> {
  // ... existing code to fetch YAML/JSON files ...
  
  // NEW: Fetch all files from /nodes/images/
  const imageFiles = await this.fetchAllImagesFromGit(repository, branch, gitCreds);
  
  // Store images in IDB
  for (const imageFile of imageFiles) {
    const imageId = imageFile.name.replace(/\.(png|jpg|jpeg)$/, '');
    const ext = imageFile.name.match(/\.(png|jpg|jpeg)$/)?.[1];
    
    await fileRegistry.storeImage({
      fileId: `image-${imageId}`,
      type: 'image',
      data: {
        image_id: imageId,
        file_extension: ext,
        binaryData: imageFile.binaryData
      },
      source: {
        repository,
        branch,
        path: `nodes/images/${imageFile.name}`
      }
    });
  }
  
  // ... rest of pull operation ...
}

async fetchAllImagesFromGit(
  repository: string, 
  branch: string, 
  gitCreds: any
): Promise<Array<{name: string; binaryData: Uint8Array}>> {
  // List all files in /nodes/images/ via GitHub API
  const response = await this.makeRequest(
    `/repos/${gitCreds.owner}/${gitCreds.repo}/contents/nodes/images?ref=${branch}`
  );
  
  if (!response.ok) {
    console.warn('No images directory found, skipping image sync');
    return [];
  }
  
  const files = await response.json();
  const imageFiles = files.filter(f => 
    f.type === 'file' && /\.(png|jpg|jpeg)$/.test(f.name)
  );
  
  // Fetch each image
  const results = await Promise.all(
    imageFiles.map(async (file) => {
      const fileResponse = await this.makeRequest(file.download_url);
      const arrayBuffer = await fileResponse.arrayBuffer();
      return {
        name: file.name,
        binaryData: new Uint8Array(arrayBuffer)
      };
    })
  );
  
  return results;
}
```

**On Clone** (`workspaceService.cloneWorkspace()`):
- Same logic as pull - fetch all images from `nodes/images/`
- Store in IDB with `type: 'image'`

#### IDB Storage During Edit

**FileRegistry Enhancement**:

```typescript
interface PendingImageOperation {
  type: 'upload' | 'delete';
  image_id: string;
  path: string;
  data?: Uint8Array;  // For uploads
}

interface PendingFileDeletion {
  fileId: string;
  path: string;
  type: string;  // 'node', 'parameter', etc.
}

class FileRegistry {
  private pendingImageOps: PendingImageOperation[] = [];
  private pendingFileDeletions: PendingFileDeletion[] = [];
  
  registerImageUpload(imageId: string, path: string, data: Uint8Array) {
    this.pendingImageOps.push({
      type: 'upload',
      image_id: imageId,
      path,
      data
    });
  }
  
  registerImageDelete(imageId: string, path: string) {
    // Remove any pending upload for this image
    this.pendingImageOps = this.pendingImageOps.filter(
      op => op.image_id !== imageId
    );
    
    // Add delete operation
    this.pendingImageOps.push({
      type: 'delete',
      image_id: imageId,
      path
    });
  }
  
  registerFileDeletion(fileId: string, path: string, type: string) {
    this.pendingFileDeletions.push({
      fileId,
      path,
      type
    });
    
    // Emit event for UI updates
    window.dispatchEvent(new CustomEvent('dagnet:pendingDeletionChanged'));
  }
  
  getPendingDeletions(): PendingFileDeletion[] {
    return [...this.pendingFileDeletions];
  }
  
  clearPendingDeletion(fileId: string) {
    this.pendingFileDeletions = this.pendingFileDeletions.filter(
      op => op.fileId !== fileId
    );
    window.dispatchEvent(new CustomEvent('dagnet:pendingDeletionChanged'));
  }
  
  async commitPendingImages(): Promise<GitFileToCommit[]> {
    const filesToCommit: GitFileToCommit[] = [];
    
    for (const op of this.pendingImageOps) {
      if (op.type === 'upload') {
        filesToCommit.push({
          path: op.path,
          binaryContent: op.data!,
          encoding: 'base64'
        });
      } else if (op.type === 'delete') {
        filesToCommit.push({
          path: op.path,
          content: '',  // Empty content = delete
          delete: true  // Flag for deletion
        });
      }
    }
    
    // Clear pending operations
    this.pendingImageOps = [];
    
    return filesToCommit;
  }
  
  async commitPendingFileDeletions(): Promise<GitFileToCommit[]> {
    const filesToCommit: GitFileToCommit[] = [];
    
    for (const op of this.pendingFileDeletions) {
      filesToCommit.push({
        path: op.path,
        content: '',
        delete: true
      });
    }
    
    // Clear pending deletions
    this.pendingFileDeletions = [];
    
    return filesToCommit;
  }
}
```

#### Commit Modal UI Enhancement

**Location**: `CommitModal.tsx`

Commit modal must show THREE categories of changes:

1. **Modified files** (existing `getDirtyFiles()`)
2. **Pending deletions** (new `getPendingDeletions()`)
3. **Pending images** (implicit, shown as count)

```typescript
export function CommitModal({ isOpen, onClose, onCommit }: CommitModalProps) {
  // Existing: Get dirty files
  const dirtyFiles = fileRegistry.getDirtyFiles();
  
  // NEW: Get pending deletions
  const pendingDeletions = fileRegistry.getPendingDeletions();
  
  // Listen for pending deletion changes
  useEffect(() => {
    const handlePendingChange = () => forceUpdate();
    window.addEventListener('dagnet:pendingDeletionChanged', handlePendingChange);
    return () => window.removeEventListener('dagnet:pendingDeletionChanged', handlePendingChange);
  }, []);
  
  return (
    <div className="commit-modal">
      <h2>Commit Changes</h2>
      
      {/* Modified Files Section */}
      {dirtyFiles.length > 0 && (
        <section>
          <h3>Modified Files ({dirtyFiles.length})</h3>
          {dirtyFiles.map(file => (
            <FileCheckbox key={file.fileId} file={file} />
          ))}
        </section>
      )}
      
      {/* Pending Deletions Section (NEW) */}
      {pendingDeletions.length > 0 && (
        <section className="deletions-section">
          <h3>Files to Delete ({pendingDeletions.length})</h3>
          {pendingDeletions.map(deletion => (
            <DeletionItem 
              key={deletion.fileId} 
              deletion={deletion}
              onUnstage={() => fileRegistry.clearPendingDeletion(deletion.fileId)}
            />
          ))}
        </section>
      )}
      
      {/* Commit Message Input */}
      <textarea 
        placeholder="Commit message"
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
      />
      
      {/* Actions */}
      <button onClick={handleCommit}>Commit</button>
      <button onClick={onClose}>Cancel</button>
    </div>
  );
}
```

#### Commit Modal Integration

**Location**: `AppShell.tsx`, line ~1414 (onCommit handler)

```typescript
onCommit={async (files, message, branch) => {
  // ... existing credential loading ...
  
  const filesToCommit = files.map(file => {
    // ... existing file mapping ...
  });
  
  // Add pending image operations (uploads + image deletions)
  const imageFiles = await fileRegistry.commitPendingImages();
  filesToCommit.push(...imageFiles);
  
  // Add pending file deletions (node files, etc.)
  const fileDeletions = await fileRegistry.commitPendingFileDeletions();
  filesToCommit.push(...fileDeletions);
  
  // Commit all files (including images and deletions)
  const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
  
  // ... existing success handling ...
}}
```

---

## UpdateManager Integration

### 1. Image Field Mapping

**Location**: `UpdateManager.ts` constructor (line ~131)

Add image mapping configuration:

```typescript
constructor() {
  // ... existing mappings ...
  
  // Node images (registry → graph, with override support)
  this.mappingConfigurations.set('node-images', {
    sourceType: 'node-file',
    targetType: 'graph-node',
    mapping: {
      'images': {
        target: 'images',
        transform: (images, options) => {
          // When syncing from registry to graph:
          // - Keep image_id, caption, file_extension
          // - Remove uploaded_at, uploaded_by (registry-only fields)
          // - Add caption_overridden: false
          return images?.map(img => ({
            image_id: img.image_id,
            caption: img.caption,
            file_extension: img.file_extension,
            caption_overridden: false
          }));
        },
        overrideField: 'images_overridden'
      }
    }
  });
}
```

### 2. File → Graph Sync (Get from File)

When user links node to registry file, images should sync.

**Location**: `dataOperationsService.ts`, `getNodeFromFile()` method

Ensure images are included in the sync:

```typescript
async getNodeFromFile(options: {
  nodeId: string;
  nodeUuid?: string;
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
}): Promise<void> {
  const { nodeId, nodeUuid, graph, setGraph } = options;
  
  // ... existing code to load node file ...
  
  // Use UpdateManager to sync file → graph
  const result = await updateManager.handleFileToGraph(
    nodeFile.data,    // source
    graphNode,        // target
    'UPDATE',         // operation
    'node',           // subDest
    {
      respectOverrides: true,  // Don't overwrite if images_overridden=true
      applyImmediately: false
    }
  );
  
  // Apply changes (including images)
  const nextGraph = structuredClone(graph);
  const node = nextGraph.nodes.find(n => n.uuid === nodeUuid);
  applyChanges(node, result.changes);
  setGraph(nextGraph);
  
  // ... rest of existing code ...
}
```

### 3. Graph → File Sync (Put to File)

**Same pattern as other node fields**: When user clicks "Put to Node File", images sync from graph to registry.

**Location**: `dataOperationsService.putNodeToFile()` (line 1565)

**What gets synced**:
- Image IDs (`image_id`)
- Captions
- File extensions

**What stays in `/nodes/images/`**:
- The actual image files (not moved or duplicated)

**UpdateManager Integration**:

```typescript
// In UpdateManager.initializeMappings()

// Flow D.UPDATE: Graph → File/Node (UPDATE registry entry)
this.addMapping('graph_to_file', 'UPDATE', 'node', [
  { sourceField: 'id', targetField: 'id' },
  { sourceField: 'label', targetField: 'name', overrideField: 'label_overridden' },
  { sourceField: 'description', targetField: 'description', overrideField: 'description_overridden' },
  { sourceField: 'event_id', targetField: 'event_id', overrideField: 'event_id_overridden' },
  { sourceField: 'url', targetField: 'url', overrideField: 'url_overridden' },  // NEW
  { 
    sourceField: 'images', 
    targetField: 'images',
    overrideField: 'images_overridden',
    transform: (images) => {
      // When syncing graph → registry:
      // - Keep image_id, caption, file_extension
      // - Remove caption_overridden (graph-only field)
      // - Keep or add uploaded_at, uploaded_by (registry fields)
      return images?.map(img => ({
        image_id: img.image_id,
        caption: img.caption,
        file_extension: img.file_extension,
        uploaded_at: img.uploaded_at || new Date().toISOString(),
        uploaded_by: img.uploaded_by || 'unknown'
      }));
    }
  }
]);
```

**Use Case**:
User adds images at graph level, then clicks "Put to Node File" to save those image references to the node registry file for reuse across other graphs.

---

## Implementation Phases

### Phase 1: Schema & Data Model (2-3 hours)
**Files to modify**:
- `graph-editor/public/param-schemas/node-schema.yaml`
- `graph-editor/public/schemas/conversion-graph-1.0.0.json`
- `graph-editor/src/types/index.ts`
- `graph-editor/api/lib/graph_types.py` (if Python validation needed)

**Tasks**:
1. ✅ Add `url` field to node schema
2. ✅ Add `images` array to node schema
3. ✅ Add `url`, `url_overridden`, `images`, `images_overridden` to graph node schema
4. ✅ Create `NodeImage` TypeScript interface
5. ✅ Update `GraphNode` interface with url and images
6. ✅ Update Python types (if needed)
7. ✅ Test schema validation

### Phase 2: File Storage & Serving Infrastructure (4-5 hours)
**Files to modify**:
- `graph-editor/src/services/gitService.ts`
- `graph-editor/src/services/workspaceService.ts`
- `graph-editor/src/contexts/TabContext.tsx` (FileRegistry)

**New files to create**:
- `graph-editor/src/services/imageService.ts`

**Tasks**:
1. ✅ Add `encoding` parameter to `createOrUpdateFile()`
2. ✅ Enhance `commitAndPushFiles()` to handle binary data and deletions
3. ✅ Add `fetchAllImagesFromGit()` to workspaceService
4. ✅ Update `pullLatest()` to fetch and store images in IDB
5. ✅ Update `cloneWorkspace()` to fetch and store images in IDB
6. ✅ Add `storeImage()` method to FileRegistry
7. ✅ Create `imageService` with `getImageUrl()` (blob URL generation from IDB)
8. ✅ Add blob URL caching and cleanup (`revokeImageUrl()`)
9. ✅ Extend FileRegistry with `PendingImageOperation` and `PendingFileDeletion` tracking
10. ✅ Add image methods: `registerImageUpload()`, `registerImageDelete()`, `commitPendingImages()`
11. ✅ Add deletion methods: `registerFileDeletion()`, `getPendingDeletions()`, `clearPendingDeletion()`, `commitPendingFileDeletions()`
12. ✅ Add `workspaceService.getAllNodeFilesFromIDB()`, `getAllGraphFilesFromIDB()`, and `getAllImageIdsFromIDB()`
13. ✅ Test image upload/download/delete via GitHub API
14. ✅ Test Git pull fetches all images into IDB

### Phase 3: Properties Panel UI (5-7 hours)
**Files to modify**:
- `graph-editor/src/components/PropertiesPanel.tsx`

**New files to create**:
- `graph-editor/src/components/ImageThumbnail.tsx`
- `graph-editor/src/components/ImageUploadModal.tsx`
- `graph-editor/src/utils/imageCompression.ts`

**Tasks**:
1. ✅ Add URL field to Basic Properties card (above images)
2. ✅ Implement URL field with override pattern
3. ✅ Add clickable link button for URL
4. ✅ Add images section to Basic Properties card
5. ✅ Create `ImageThumbnail` component
6. ✅ Create `ImageUploadModal` with 3 tabs:
   - Local file picker
   - URL input (fetch from web)
   - Clipboard paste
7. ✅ Implement image compression utility (max 2048×2048, 85% quality)
8. ✅ Implement delete handler
9. ✅ Implement caption editing (inline)
10. ✅ Add override indicator styling
11. ✅ Wire up to graph state (UpdateManager)
12. ✅ Test all CRUD operations

### Phase 4: Node Face Display (3-4 hours)
**Files to modify**:
- `graph-editor/src/components/nodes/ConversionNode.tsx`

**New files to create**:
- `graph-editor/src/components/ImageStackIndicator.tsx`
- `graph-editor/src/components/ImageHoverPreview.tsx`
- `graph-editor/src/components/ImageLoupeView.tsx`

**Tasks**:
1. ✅ Add URL icon to bottom-right (left of images)
2. ✅ Import ExternalLink icon from Lucide
3. ✅ Wire up URL click handler (open in new tab)
4. ✅ Add bottom-right image indicator (right of URL)
5. ✅ Create `ImageStackIndicator` component (stacked squares effect)
6. ✅ Create `ImageHoverPreview` component (on hover)
7. ✅ Create `ImageLoupeView` modal component (on click)
8. ✅ Wire up navigation (prev/next) in loupe view
9. ✅ Add delete/edit affordances in loupe view
10. ✅ Test interactions and positioning (URL + images)

### Phase 5: Deletion Operations Service (4-5 hours)
**New service needed**: `deleteOperationsService.ts`

**Files to create**:
- `graph-editor/src/services/deleteOperationsService.ts`

**Files to modify**:
- `graph-editor/src/components/NavigatorItemContextMenu.tsx`
- `graph-editor/src/services/fileOperationsService.ts`
- `graph-editor/src/contexts/TabContext.tsx` (FileRegistry)

**Tasks**:
1. ✅ Create `deleteOperationsService` to centralize deletion logic
2. ✅ Implement `deleteNodeFile()` with image reference checking
3. ✅ Add `scanAllFilesForImageReferences()` utility (scans ALL files from IDB)
4. ✅ Add staging for file deletions (not immediate)
5. ✅ Add `pendingFileDeletions` tracking in FileRegistry
6. ✅ Update navigator context menu to use new service
7. ✅ Fix: Make deletions stage-only (no immediate Git commits)
8. ✅ Update commit flow to handle pending deletions
9. ✅ Test node file deletion with image reference checking
10. ✅ Test that deletions don't affect Git until commit

### Phase 6: UpdateManager Integration (3-4 hours)
**Files to modify**:
- `graph-editor/src/services/UpdateManager.ts`
- `graph-editor/src/services/dataOperationsService.ts`

**Tasks**:
1. ✅ Add URL mapping configuration (get/put)
2. ✅ Add image mapping configuration (get/put with transform)
3. ✅ Enhance `deleteNode()` for graph node deletion (check node file exists)
4. ✅ Add `registerImageDeletions()` method
5. ✅ Add `getPendingImageDeletions()` accessor
6. ✅ Update `putNodeToFile()` to sync images to registry
7. ✅ Update `getNodeFromFile()` to sync images to graph
8. ✅ Test override pattern for URL and images
9. ✅ Test bidirectional sync (get/put)
10. ✅ Test cascade deletion from graph

### Phase 7: Commit Flow Integration (4-5 hours)
**Files to modify**:
- `graph-editor/src/components/CommitModal.tsx`
- `graph-editor/src/AppShell.tsx` (commit handler)
- `graph-editor/src/components/NavigatorItemContextMenu.tsx` (commit from navigator)

**Tasks**:
1. ✅ Add `getPendingDeletions()` to FileRegistry
2. ✅ Add `commitPendingFileDeletions()` to FileRegistry  
3. ✅ Add "Files to Delete" section to CommitModal UI
4. ✅ Add "unstage deletion" affordance in UI (`clearPendingDeletion()`)
5. ✅ Update commit handler to collect ALL three sources:
   - Dirty files (modified)
   - Pending file deletions
   - Pending image operations
6. ✅ Show "Modified Files" section in commit modal
7. ✅ Show "Files to Delete" section in commit modal (with unstage button)
8. ✅ Show pending image count (uploads + deletions)
9. ✅ Handle multi-file commits (modified + deleted + images)
10. ✅ Add error handling for failed operations
11. ✅ Emit `dagnet:pendingDeletionChanged` event for UI updates
12. ✅ Verify ALL IDB changes flow to Git (edits via isDirty, deletions via pending, images via pending)
13. ✅ Test full commit cycle (edits + deletions + images)

### Phase 8: Testing & Polish (3-4 hours)
**Tasks**:
1. ✅ Test image upload/delete/edit workflows
2. ✅ Test override pattern (registry sync)
3. ✅ Test node deletion cascade (both scenarios)
4. ✅ Test file deletion cascade with image GC
5. ✅ Test Git sync (upload, delete, pull)
6. ✅ **Verify IDB → Git tracking**: All IDB changes appear in commit modal
7. ✅ **Verify staging**: Nothing reaches Git without explicit commit
8. ✅ Test UI responsiveness and error states
9. ✅ Add loading states for image operations
10. ✅ Add proper error messages
11. ✅ Polish styling and animations

**Total Estimated Time**: 29-38 hours (includes URL field + upload modal + image serving + deletion service + commit flow)

---

## Design Considerations & Open Issues

### 1. Image Storage Location

**Current Proposal**: `/nodes/images/`

**Alternatives Considered**:
- `/nodes/{node-id}/images/` (one directory per node)
  - ❌ More complex directory structure
  - ❌ Harder to find images by ID
  - ✅ Better organization if many images per node
  
- `/images/` (flat structure)
  - ❌ Not clear these are node images
  - ✅ Simpler path

**Decision**: Stick with `/nodes/images/` as proposed.

### 2. Image Deduplication

**Issue**: Multiple nodes might reference the same screenshot (e.g., shared UI element)

**Current Implementation**: Each image has unique ID, stored once

**Future Enhancement**: Could add reference counting or manual linking

**Decision**: Out of scope for v1. Treat as separate images even if content is identical.

### 3. Image Size Limits & Automatic Scaling

**Considerations**:
- GitHub has file size limits (100MB per file, but practically should be much smaller)
- Large images slow down Git operations
- Browser memory constraints for base64 encoding
- **We never need more than 2K resolution** for node documentation images

**Implementation**:
- Max file size: 5MB per image (enforced on upload, before compression)
- **Max dimensions: Automatically scaled to 2048×2048 (2K) during compression**
- No need for dimension validation - compression handles it
- Users can upload any size, we'll scale it down automatically

**Simplified Validation** (dimension check removed - compression handles it):
```typescript
function validateImage(file: File): { valid: boolean; error?: string } {
  const MAX_SIZE = 5 * 1024 * 1024; // 5MB before compression
  
  if (file.size > MAX_SIZE) {
    return { 
      valid: false, 
      error: `Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 5MB before compression.` 
    };
  }
  
  // Check file type
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    return {
      valid: false,
      error: 'Only PNG and JPG images are supported.'
    };
  }
  
  return { valid: true };
}
```

**Note**: After compression, images will typically be:
- Max 2048×2048 pixels
- < 500KB for typical screenshots
- < 1MB even for complex images
- Original aspect ratio preserved

### 4. Image File Naming & ID Uniqueness

**Image ID Namespace**: Globally unique across entire repository

**Rationale**:
- Images stored in single flat directory `/nodes/images/`
- Must avoid filename collisions
- Allows image sharing across nodes/graphs if needed

**ID Generation Strategy**:
1. Generate base ID from caption (or fallback to `{nodeId}-img-{timestamp}`)
2. Query IDB for ALL existing image IDs via `workspaceService.getAllImageIdsFromIDB()`
3. If collision, append `-1`, `-2`, etc. until unique
4. This ensures global uniqueness across ~100 images

**Example**:
- Upload "Checkout Flow" → generates `checkout-flow`
- Upload another "Checkout Flow" → generates `checkout-flow-1`
- Upload to different node → still checks global namespace

**File Sharing** (automatic):
- If two nodes reference `image_id: "checkout-flow"`, they share the same file
- Deletion only occurs when NO references remain anywhere
- This is a feature, not a bug (reduces duplication)

### 5. Registry vs. Graph Images

**Question**: Should images in node registry files sync to graph instances?

**Current Design**: 
- Registry images flow to graph when node is linked
- Graph-level edits (caption changes, deletions, additions) set `images_overridden=true`
- Once overridden, registry updates don't affect graph images

**Alternative**: Always allow syncing, with per-image override flags

**Decision**: Use array-level override (simpler, follows existing pattern for case variants).

### 6. Image Refresh/Reload

**Issue**: If image file changes in Git but graph JSON doesn't, browser may cache old image

**Solutions**:
1. Add cache-busting query parameter: `?v={sha}` or `?v={timestamp}`
2. Force reload after Git pull
3. Use `Cache-Control` headers appropriately

**Proposed Implementation**:
```typescript
// When loading images, include version
const imageSrc = `/nodes/images/${image.image_id}.${image.file_extension}?v=${graph.metadata.updated_at}`;
```

### 7. Layout Considerations: URL + Images on Node Face

**Issue**: When both URL icon and images are present, need proper spacing

**Current Design**:
```
┌─────────────────────────────┐
│                             │
│         Node Label          │
│                             │
│    [Node content area]      │
│                             │
│                             │
│  [icons]        [URL][IMG] │  <- Bottom corners
└─────────────────────────────┘
   Bottom-left     Bottom-right
```

**Spacing**:
- Gap between URL icon and images: 4px
- Both have `pointerEvents: 'auto'` for clickability
- Separate click handlers (no interference)

**Edge Cases**:
- URL only: Shows just URL icon
- Images only: Shows just images
- Both: Shows URL left, images right with 4px gap

### 8. Image Viewing Performance

**Issue**: Large images in loupe view could be slow to load

**Solutions**:
1. Show loading spinner while image loads
2. Pre-generate thumbnails (out of scope for v1)
3. Use lazy loading for off-screen images

**Proposed for v1**:
```typescript
function ImageLoupeView({ images }) {
  const [loading, setLoading] = useState(true);
  
  return (
    <>
      {loading && <LoadingSpinner />}
      <img
        src={imageSrc}
        onLoad={() => setLoading(false)}
        style={{ display: loading ? 'none' : 'block' }}
      />
    </>
  );
}
```

### 9. Clipboard & URL Fallbacks

**Clipboard API Support**:

```typescript
// Check clipboard API availability
const clipboardSupported = navigator.clipboard && 
  typeof navigator.clipboard.read === 'function';

if (!clipboardSupported) {
  // Disable clipboard tab, show tooltip
  return (
    <button disabled title="Clipboard paste not supported in this browser">
      <Clipboard size={16} /> Paste from Clipboard
    </button>
  );
}
```

**URL Fetch Error Handling**:

```typescript
async handleUrlUpload() {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      throw new Error('URL does not point to an image');
    }
    
    // ... process image ...
  } catch (error) {
    if (error.name === 'TypeError') {
      // Network/CORS error
      setError('Cannot fetch image. Try downloading it first, or check CORS settings.');
    } else {
      setError(error.message);
    }
  }
}
```

**Note**: URL fetch is a convenience feature; users can always download + upload manually if CORS or network issues occur.

### 10. Undo/Redo Support

**Issue**: Graph canvas has undo/redo. Should image operations be undoable?

**Current Design**: Yes, because images are part of graph state

**Implementation**: Already handled by existing history system in `GraphCanvas.tsx`

**Note**: Image file uploads to Git are NOT undoable (would require Git history rewriting)

### 11. Mobile/Responsive Considerations

**Issue**: Touch interactions for hover preview don't work well

**Solutions**:
1. On mobile, tap once to preview, tap again to open loupe
2. Skip hover preview on touch devices, go straight to loupe
3. Use long-press for preview

**Proposed**: Skip hover, tap goes straight to loupe on touch devices

```typescript
const isTouchDevice = 'ontouchstart' in window;

onClick={(e) => {
  e.stopPropagation();
  if (isTouchDevice) {
    setShowImageLoupe(true);  // Skip hover, go straight to loupe
  } else {
    setShowImagePreview(true);
  }
}}
```

### 12. Image Reference Counting & Orphan Prevention

**Issue**: When should image files be deleted from `/nodes/images/`?

**Naive Approach** (incorrect):
- Delete images whenever node is deleted from graph
- **Problem**: If image was synced to node file, it's still referenced there

**Smart Approach** (implemented):
- On node deletion, check if node file exists
- If node file exists: Keep images (they belong to node registry)
- If node file doesn't exist: Delete images (they were graph-only)

**Data Flow Protection**:
```
Graph Node (upload) → [image files] ← Node File (put to file)
       ↓                                      ↓
   Delete node                         Still referenced
       ↓                                      ↓
Check: Does node file exist?
   YES → Keep images (referenced by file)
   NO  → Delete images (orphaned)
```

**Edge Cases**:
1. **Image uploaded but never synced**: Deleted when node removed (correct)
2. **Image synced to file, then node deleted**: Kept (correct)
3. **Multiple graphs using same node file**: Images shared, never deleted by graph operations (correct)

For **Scenario B (Node File Deletion)**: Need comprehensive reference checking across ALL graphs.

**Implementation Plan**:

```typescript
// In fileOperationsService.deleteFile() or new centralizeDeleteService

async deleteNodeFile(nodeId: string): Promise<void> {
  const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
  if (!nodeFile || !nodeFile.data.images || nodeFile.data.images.length === 0) {
    // No images to worry about, proceed with normal deletion
    return this.normalFileDelete(nodeId);
  }
  
  // Get all image IDs from this node file
  const imageIds = nodeFile.data.images.map(img => img.image_id);
  
  // Check if ANY files (node or graph) reference these images
  const referencedImages = await this.scanAllFilesForImageReferences(imageIds);
  
  // Determine which images to delete
  const imagesToDelete = imageIds.filter(id => !referencedImages.has(id));
  
  if (imagesToDelete.length > 0) {
    // Stage images for deletion (don't delete immediately)
    fileRegistry.registerImageDeletions(imagesToDelete.map(id => {
      const img = nodeFile.data.images.find(i => i.image_id === id);
      return {
        path: `/nodes/images/${id}.${img.file_extension}`,
        image_id: id
      };
    }));
  }
  
  // Stage node file deletion (don't delete immediately)
  fileRegistry.registerFileDeletion(`node-${nodeId}`, `nodes/${nodeId}.yaml`, 'node');
  
  console.log('[FileOperationsService] Staged deletions:', {
    nodeFile: `nodes/${nodeId}.yaml`,
    imagesToDelete: imagesToDelete.length,
    imagesKept: imageIds.length - imagesToDelete.length
  });
}

async scanAllFilesForImageReferences(imageIds: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  
  // 1) Scan ALL node files from IDB (not just loaded ones)
  const allNodeFiles = await workspaceService.getAllNodeFilesFromIDB();
  for (const nodeFile of allNodeFiles) {
    if (!nodeFile.data?.images) continue;
    for (const img of nodeFile.data.images) {
      if (imageIds.includes(img.image_id)) {
        referenced.add(img.image_id);
      }
    }
  }
  
  // 2) Scan ALL graph files from IDB (not just loaded ones)
  const allGraphFiles = await workspaceService.getAllGraphFilesFromIDB();
  for (const graphFile of allGraphFiles) {
    if (!graphFile.data?.nodes) continue;
    for (const node of graphFile.data.nodes) {
      if (!node.images) continue;
      for (const img of node.images) {
        if (imageIds.includes(img.image_id)) {
          referenced.add(img.image_id);
        }
      }
    }
  }
  
  return referenced;
}
```

**Critical Issues to Fix**:

1. **Staging vs. Immediate Deletion**:
   - Current: `gitService.deleteFile()` commits immediately
   - Should: Stage deletion, only commit when user explicitly commits
   - Same pattern as file edits (dirty flag → commit modal)

2. **Centralized Deletion Service**:
   - Create `deleteOperationsService` to handle both scenarios
   - All deletions go through one place
   - Consistent staging behavior
   - Proper image reference checking

3. **Deletion Flow Should Be**:
   ```
   User clicks Delete
      ↓
   deleteOperationsService
      ↓
   Check file type (node? parameter? graph?)
      ↓
   If node: Check image references across graphs
      ↓
   Stage file deletion + orphaned image deletions
      ↓
   Mark file as "pending deletion" (similar to dirty)
      ↓
   User commits → Actually delete from Git
   ```

**Decision**: This needs to be fixed as part of the image upload feature implementation, not deferred to v2. Otherwise we have a dangerous inconsistency where deleting node files immediately deletes images that graphs are still using.

### 13. Image Search/Filter

**Out of scope for v1, but noted for future**:
- Search images by caption
- Filter nodes by whether they have images
- Image gallery view across all nodes

---

## Testing Strategy

### Unit Tests (if applicable)

```typescript
describe('NodeImage', () => {
  it('generates unique image IDs', () => {
    const id1 = generateImageId('Checkout Flow', 'checkout', []);
    const id2 = generateImageId('Checkout Flow', 'checkout', [id1]);
    expect(id1).not.toBe(id2);
  });
  
  it('validates image file size', async () => {
    const largeFile = new File([new ArrayBuffer(10 * 1024 * 1024)], 'large.png');
    const result = await validateImage(largeFile);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too large');
  });
  
  it('applies caption override flag correctly', () => {
    const result = updateManager.handleFileToGraph(
      { images: [{ image_id: 'test', caption: 'Original' }] },
      { images: [{ image_id: 'test', caption: 'Modified', caption_overridden: true }] },
      'UPDATE',
      'node'
    );
    // Should NOT overwrite caption because caption_overridden=true
    expect(result.changes.find(c => c.path === 'images[0].caption')).toBeUndefined();
  });
});
```

### Manual Testing Checklist

#### URL Field
- [ ] URL field appears in Basic Properties (above images)
- [ ] Can enter URL in text field
- [ ] URL persists on blur/save
- [ ] Link button (🔗) appears when URL is set
- [ ] Clicking link opens URL in new tab
- [ ] URL syncs from registry when node linked (if not overridden)
- [ ] Editing URL sets `url_overridden=true`
- [ ] Override indicator (⚡) appears when overridden
- [ ] "Put to Node File" syncs URL to registry

#### Upload Flow
- [ ] Click "+" button opens upload modal
- [ ] Modal shows 3 tabs: Local File, From URL, Paste from Clipboard
- [ ] **Local File tab:**
  - [ ] File picker only shows PNG/JPG files
  - [ ] Uploading creates thumbnail in Properties Panel
  - [ ] Images are automatically scaled down to max 2048×2048
  - [ ] Images are compressed (85% quality)
  - [ ] Compression maintains reasonable quality
  - [ ] Aspect ratio preserved during scaling
- [ ] **From URL tab:**
  - [ ] Can enter image URL
  - [ ] Fetches and uploads image from URL
  - [ ] Shows loading state while fetching
  - [ ] Rejects non-image URLs with error
  - [ ] Fetched images also scaled to 2K max
- [ ] **Clipboard tab:**
  - [ ] "Paste from Clipboard" button works
  - [ ] Ctrl+V / Cmd+V works after selecting tab
  - [ ] Shows error if no image in clipboard
  - [ ] Pasted images also scaled to 2K max
- [ ] Default caption is "Image 1", "Image 2", etc.
- [ ] Image appears on node face (bottom right)
- [ ] Graph is marked dirty after upload
- [ ] Large images (>5MB before compression) are rejected with error message
- [ ] Invalid file types (e.g., GIF, PDF) are rejected
- [ ] Very large images (e.g., 8K resolution) are automatically scaled to 2K

#### Display
- [ ] URL icon appears on node face (bottom right) when URL is set
- [ ] URL icon is positioned LEFT of image preview
- [ ] Clicking URL icon opens URL in new tab
- [ ] Hovering over URL icon shows full URL in tooltip
- [ ] Tooltip appears with short delay (200ms)
- [ ] Image thumbnail shows correct image
- [ ] Image stack indicator shows on node face when >1 image
- [ ] Hover over node image shows preview popup
- [ ] Click on node image opens loupe view
- [ ] Loupe view shows full-size image
- [ ] Navigation works in loupe view (prev/next)
- [ ] URL icon and images are positioned correctly on node (don't overlap other elements)
- [ ] When both URL and images present, they appear side-by-side (URL left, images right)

#### Caption Editing
- [ ] Click pencil icon enters edit mode
- [ ] Typing updates caption locally
- [ ] Click checkmark commits caption change
- [ ] Click X cancels edit
- [ ] Graph is marked dirty after caption change
- [ ] Edited caption shows override indicator (⚡)

#### Deletion
- [ ] Click "×" on thumbnail removes image from Properties Panel
- [ ] Deleted image no longer appears on node face
- [ ] If all images deleted, node face indicator disappears
- [ ] Graph is marked dirty after deletion
- [ ] Deleting in loupe view also removes from Properties Panel

#### Git Sync (IDB → Git)
- [ ] **File modifications**: 
  - [ ] Edit file in IDB marks as dirty
  - [ ] Commit modal shows in "Modified Files"
  - [ ] Committing syncs to Git
- [ ] **File deletions**:
  - [ ] Delete file from navigator stages deletion
  - [ ] Commit modal shows in "Files to Delete" section
  - [ ] Committing removes from Git
  - [ ] Can unstage deletion before commit
- [ ] **Image uploads**:
  - [ ] Upload image stages in pendingImageOps
  - [ ] Commit modal shows/counts pending images
  - [ ] Committing uploads to Git at `/nodes/images/`
- [ ] **Image deletions**:
  - [ ] Delete image stages in pendingImageOps
  - [ ] Committing removes from Git
- [ ] **Multi-file commits work**: graph JSON + image files + deletions in single commit
- [ ] **Git pull**: Fetches modified files, new images, processes deletions
- [ ] **Verify nothing bypasses staging**: All IDB changes require explicit commit
- [ ] **Complete IDB → Git coverage**:
  - [ ] File edit in IDB → appears in commit modal "Modified Files"
  - [ ] File delete via navigator → appears in commit modal "Files to Delete"
  - [ ] Image upload → graph dirty + pending image tracked
  - [ ] Image delete → graph dirty + pending image tracked
  - [ ] After commit, ALL tracked changes appear in Git
  - [ ] No orphaned changes left in IDB after commit

#### Override Pattern
- [ ] Linking node to registry syncs images (if not overridden)
- [ ] Editing caption sets `caption_overridden=true`
- [ ] Adding/removing images sets `images_overridden=true`
- [ ] Once overridden, registry updates don't affect graph images
- [ ] Override indicator appears when images_overridden=true

#### Node Deletion (Smart Cascade)

**Scenario A: Delete Node from Graph**
- [ ] **A1: Graph-only images**
  - [ ] Upload image to node (no node file exists)
  - [ ] Delete node from graph
  - [ ] Images marked for deletion
  - [ ] Committing removes image files from Git
- [ ] **A2: Images synced to node file**
  - [ ] Upload image to node
  - [ ] "Put to Node File" (syncs images to registry)
  - [ ] Delete node from graph
  - [ ] Images NOT marked for deletion (node file still references them)
  - [ ] Image files remain in Git after commit
- [ ] **A3: Undo node deletion**
  - [ ] Delete node from graph
  - [ ] Undo operation
  - [ ] Node and images restored correctly

**Scenario B: Delete Node File from Navigator**
- [ ] **B1: File with images, no graphs reference them**
  - [ ] Node file has 3 images
  - [ ] No loaded graphs reference those image IDs
  - [ ] Delete node file from navigator
  - [ ] File deletion AND image deletions staged (not committed)
  - [ ] Verify Git not affected yet
  - [ ] Commit → file and images deleted from Git
- [ ] **B2: File with images, some graphs reference them**
  - [ ] Node file has 3 images (A, B, C)
  - [ ] Graph1 references images A and B
  - [ ] Delete node file from navigator
  - [ ] File deletion staged
  - [ ] Only image C staged for deletion (A and B kept)
  - [ ] Commit → file deleted, only C removed from Git
- [ ] **B3: File with images, all referenced by graphs**
  - [ ] Node file has 2 images
  - [ ] Multiple graphs reference both images
  - [ ] Delete node file from navigator
  - [ ] Only file deletion staged (no images)
  - [ ] Images remain in Git after commit
- [ ] **B4: Delete stages properly (no immediate Git changes)**
  - [ ] Delete any node file
  - [ ] Verify file still in Git (not committed yet)
  - [ ] Cancel/don't commit
  - [ ] File can be un-deleted from staging area

#### Error Handling
- [ ] Network error during upload shows error message
- [ ] Corrupt image file shows error message
- [ ] GitHub API error during commit shows error message
- [ ] Missing image file (after Git pull) shows placeholder or error

---

## Success Criteria

### Must Have (v1)
- ✅ Users can upload PNG/JPG images to nodes
- ✅ Images display on node face (bottom right)
- ✅ Click to view full-size in loupe view
- ✅ Edit captions inline
- ✅ Delete images
- ✅ Images stored in Git repository
- ✅ Images sync via Git pull/push
- ✅ Node deletion cascades to images
- ✅ Override pattern works correctly

### Nice to Have (Future)
- ⏳ Image thumbnails (pre-generated)
- ⏳ Drag-and-drop upload
- ⏳ Paste from clipboard
- ⏳ Image gallery view
- ⏳ Search by caption
- ⏳ Image deduplication/reference sharing
- ⏳ Git LFS support for large images
- ⏳ Image optimization on upload (auto-resize)

---

## Appendix: File Structure Summary

### New Files to Create
```
graph-editor/src/components/
  ├── ImageThumbnail.tsx           (100 lines)
  ├── ImageUploadModal.tsx         (200 lines - with 3 tabs)
  ├── ImageStackIndicator.tsx      (80 lines)
  ├── ImageHoverPreview.tsx        (50 lines)
  └── ImageLoupeView.tsx           (150 lines)

graph-editor/src/utils/
  └── imageCompression.ts          (80 lines)

Total: ~660 lines of new code
```

### Files to Modify
```
graph-editor/
  ├── public/param-schemas/
  │   └── node-schema.yaml         (+30 lines - url + images)
  ├── public/schemas/
  │   └── conversion-graph-1.0.0.json  (+45 lines - url + images)
  ├── src/
  │   ├── types/index.ts           (+20 lines)
  │   ├── components/
  │   │   ├── PropertiesPanel.tsx  (+80 lines - url field + images)
  │   │   └── nodes/ConversionNode.tsx  (+80 lines)
  │   ├── services/
  │   │   ├── UpdateManager.ts     (+80 lines - url + images mappings)
  │   │   ├── dataOperationsService.ts  (+30 lines)
  │   │   └── gitService.ts        (+40 lines)
  │   ├── contexts/
  │   │   └── TabContext.tsx       (+80 lines)
  │   └── AppShell.tsx             (+20 lines)

Total: ~505 lines modified
```

### Total Scope
- **New files**: 8 files, ~1,060 lines
  - `ImageThumbnail.tsx` (~100 lines)
  - `ImageUploadModal.tsx` (~200 lines)
  - `imageCompression.ts` (~80 lines)
  - `ImageStackIndicator.tsx` (~80 lines)
  - `ImageHoverPreview.tsx` (~50 lines)
  - `ImageLoupeView.tsx` (~150 lines)
  - **`imageService.ts`** (~100 lines)
  - **`deleteOperationsService.ts`** (~200 lines)
- **Modified files**: 15 files, ~835 lines
  - Schemas (node, graph)
  - Types
  - PropertiesPanel
  - ConversionNode
  - UpdateManager
  - dataOperationsService
  - **workspaceService** (getAllNodeFilesFromIDB, getAllGraphFilesFromIDB, getAllImageIdsFromIDB, fetchAllImagesFromGit, pullLatest, cloneWorkspace)
  - **fileOperationsService** (deletion staging)
  - **NavigatorItemContextMenu** (use new deletion service)
  - **TabContext/FileRegistry** (pending deletions tracking, image storage, storeImage)
  - **CommitModal** (show deletions section, unstage button)
  - gitService (binary support, deletion support)
  - AppShell (collect all pending operations)
- **Total new code**: ~1,995 lines
- **Estimated effort**: 29-38 hours

---

## System Architecture: IDB ↔ Git Sync Model

### Complete Sync Lifecycle

**On Clone/Pull** (Git → IDB):
```
Git Repository
  ├── graphs/*.json          → IDB (type: 'graph', isDirty: false)
  ├── nodes/*.yaml           → IDB (type: 'node', isDirty: false)
  ├── parameters/*.yaml      → IDB (type: 'parameter', isDirty: false)
  └── nodes/images/*.{png,jpg} → IDB (type: 'image', binaryData: Uint8Array)
```

**During Editing** (IDB staging):
```
User Action              IDB State                      Tracking
─────────────────────────────────────────────────────────────────
Edit file               file.data modified              isDirty = true
Delete file            file removed from IDB            pendingFileDeletions[]
Upload image           binary in memory                 pendingImageOps[] (upload)
Delete image           ref removed from graph           pendingImageOps[] (delete)
```

**On Commit** (IDB → Git):
```
Commit Modal collects:
  ├── getDirtyFiles()                    → Update JSON/YAML files
  ├── commitPendingFileDeletions()       → Delete files from Git
  └── commitPendingImages()              → Create/delete image files

→ gitService.commitAndPushFiles([...all])
  ├── Text files: PUT with encoding='utf-8'
  ├── Images: PUT with encoding='base64', binaryContent
  └── Deletions: DELETE API call with sha
```

**Guarantees**:
- ✅ **Every** IDB change tracked for Git sync
- ✅ **Nothing** reaches Git without explicit commit
- ✅ User reviews **all** changes in commit modal
- ✅ Failed commits leave IDB unchanged (retry possible)

---

## ⚠️ Critical Issues Discovered During Design

### Issue 1: File Deletion Bypasses Staging
**Problem**: Current implementation in `NavigatorItemContextMenu.handleDeleteFile()` (line 154) calls `gitService.deleteFile()` which **immediately commits deletion to Git**.

**Should be**: Stage deletion (like file edits), only commit when user explicitly commits.

**Impact**: 
- User cannot undo file deletion
- No chance to review what will be deleted
- Inconsistent with edit workflow (edit → dirty → stage → commit)

**Fix Required**: Create `deleteOperationsService` to handle staging.

### Issue 2: Node File Deletion Doesn't Check Image References
**Problem**: Deleting a node file from navigator doesn't check if any graphs are still using its images.

**Should be**: Scan ALL node and graph files from IDB, only delete images that are truly orphaned.

**Impact**:
- Deleting node file could break graphs that reference its images
- Images disappear from graphs that are still using them
- Data loss / broken graph state

**Fix Required**: Implement `scanAllFilesForImageReferences()` that scans ALL files from IDB before deleting images.

### Issue 3: Inconsistent Deletion Flows
**Current State**:
- Navigator context menu → `gitService.deleteFile()` (immediate Git commit)
- UpdateManager → Graph node deletion (no Git interaction)
- FileOperationsService → Local deletion only (no Git)

**Should be**: All deletions go through one service with consistent staging behavior.

**Fix Required**: Centralized `deleteOperationsService` that all deletion paths use.

---

## Confirmed Design Decisions

**✅ All confirmed by user:**

1. **Storage Location**: `/nodes/images/` ✓
2. **Image Size Limits**: 5MB max + **auto-compression on upload** ✓
3. **Override Granularity**: Array-level override (simple) ✓
4. **Sync Direction**: **Bidirectional** (same as other node fields) ✓
   - Get from file: registry → graph (respects `images_overridden`)
   - Put to file: graph → registry (syncs image_ids and captions)
5. **Caption Defaults**: "Image 1", "Image 2", etc. ✓
6. **Mobile Support**: Not a priority (skip for v1) ✓

**📝 Additional Requirements:**

### Upload Modal Enhancement
Upload modal should have **3 tabs** instead of single file picker:
1. **Local File** - Traditional file picker
2. **From URL** - Input web URL, fetch and upload
3. **Paste from Clipboard** - Paste image directly

### Node URL Field
Add new `url` field to nodes (separate from images):
- **Schema**: Add to both node schema and graph schema
- **Override**: `url_overridden` flag on graph
- **UI**: Show in Basic Properties card **above** images section
- **Interaction**: Editable string field + click to open URL
- **Use case**: Link to Notion pages, docs, etc. (more convenient than in description)

---

## Summary: Key Features

### Image Upload System
✅ **Multi-source upload modal** with 3 tabs:
- Local file picker
- Fetch from web URL
- Paste from clipboard

✅ **Automatic scaling & compression**:
- All images scaled to max 2048×2048 (2K) resolution
- 85% quality compression
- Target: <500KB for screenshots, <1MB for complex images
- Aspect ratio preserved
- Never store unnecessarily large images

✅ **Git-backed storage** at `/nodes/images/{image_id}.{ext}`

✅ **Bidirectional sync**:
- Get from file: registry → graph (respects `images_overridden`)
- Put to file: graph → registry (syncs image refs)

✅ **CRUD operations**:
- Create: Upload via modal
- Read: Display on node face + loupe view
- Update: Edit captions inline
- Delete: Remove from graph + smart cascade on node delete

✅ **Smart cascade deletion with full GC**:
- Deleting graph node: checks if node file exists
- Deleting node file: scans ALL node + graph files from IDB
- Only deletes images when zero references remain
- Performance: ~20 graphs × ~50 nodes = ~1000 checks (negligible)

✅ **UI affordances**:
- Thumbnail grid in Properties Panel
- Mini preview on node face (bottom right)
- Hover popup for quick view
- Full loupe modal for detailed view/editing

### Node URL Field
✅ **Simple URL field** on nodes:
- Stores external link (Notion, docs, etc.)
- Editable in Properties Panel (above images)
- Clickable link button in Properties Panel
- **Visual indicator on node face**: Small ExternalLink icon at bottom-right (left of images)
- Clicking icon on node opens URL in new tab
- **Hovering over icon shows full URL in tooltip**
- Icon only appears when URL is set
- Follows standard override pattern
- Syncs bidirectionally (get/put)

### Override Pattern
✅ Consistent with existing fields:
- `url_overridden` for URL field
- `images_overridden` for images array
- Respects overrides during sync operations

### IDB ↔ Git Sync Guarantees
✅ **Complete change tracking**:
- File edits → `isDirty` flag
- File deletions → `pendingFileDeletions[]`
- Image uploads → `pendingImageOps[]`
- Image deletions → `pendingImageOps[]`

✅ **Commit modal shows all pending changes**:
- Modified Files section (dirty files)
- Files to Delete section (pending deletions)
- Image operations (implicit, counted)

✅ **Nothing bypasses staging**:
- All operations update IDB state only
- Git changes only on explicit commit
- User reviews all changes before sync

### Implementation Effort
- **New code**: ~1,995 lines (8 new files, 15 modified files)
- **Estimated time**: 29-38 hours
- **Complexity**: Medium-High (multi-file Git commits, binary uploads, image GC, deletion staging)

---

**END OF DOCUMENT**

