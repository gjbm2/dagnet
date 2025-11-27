/**
 * Image Compression and Validation Utilities
 * 
 * Handles image validation, compression, and scaling before upload.
 * All images are automatically converted to JPEG and scaled to max 2048×2048
 * to keep file sizes around 100-300KB for Git storage efficiency.
 */

const MAX_SIZE_BEFORE_COMPRESSION = 5 * 1024 * 1024; // 5MB
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 2048;
const COMPRESSION_QUALITY = 0.85; // JPEG quality

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate image file before processing
 * Checks file size and type only (dimensions handled by compression)
 */
export function validateImage(file: File): ValidationResult {
  // Check file size (before compression)
  if (file.size > MAX_SIZE_BEFORE_COMPRESSION) {
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

/**
 * Compress and scale image to reduce file size
 * 
 * - Scales to max 2048×2048 (maintains aspect ratio)
 * - Applies 85% quality compression
 * - Returns compressed File (or original if compression fails/larger)
 */
export async function compressImage(file: File): Promise<File> {
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
      
      // Always output JPEG for better compression (PNG is lossless and much larger)
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Compression failed'));
            return;
          }
          
          // Change filename extension to .jpg
          const jpegName = file.name.replace(/\.(png|jpeg|jpg)$/i, '.jpg');
          
          const compressed = new File([blob], jpegName, {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          console.log(`ImageCompression: Compressed to JPEG ${file.size} → ${compressed.size} bytes (${((1 - compressed.size / file.size) * 100).toFixed(1)}% reduction), dimensions: ${width}×${height}`);
          resolve(compressed);
        },
        'image/jpeg',
        COMPRESSION_QUALITY
      );
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

