/**
 * Image Thumbnail Component
 * 
 * Displays an 80×80px image thumbnail with:
 * - Delete button (X icon in top-right corner)
 * - Caption with inline editing (Pencil → Check/X icons)
 * - Override indicator for edited captions
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Pencil, Check, Zap } from 'lucide-react';
import { imageService } from '../services/imageService';
import type { NodeImage } from '../types';

interface ImageThumbnailProps {
  image: NodeImage;
  onDelete: () => void;
  onCaptionEdit: (newCaption: string) => void;
  isOverridden: boolean;
  onClick?: () => void;
}

export function ImageThumbnail({ image, onDelete, onCaptionEdit, isOverridden, onClick }: ImageThumbnailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [caption, setCaption] = useState(image.caption);
  const [imageSrc, setImageSrc] = useState<string>('');
  const captionRef = useRef<HTMLDivElement>(null);
  const [editPosition, setEditPosition] = useState<{ x: number; y: number; width: number } | null>(null);
  
  // Load image from IDB with retry logic
  useEffect(() => {
    let retryCount = 0;
    const maxRetries = 5;
    const retryDelay = 200; // ms
    
    const loadImage = async () => {
      try {
        const url = await imageService.getImageUrl(image.image_id, image.file_extension);
        setImageSrc(url);
      } catch (err) {
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`ImageThumbnail: Retrying load for ${image.image_id} (attempt ${retryCount}/${maxRetries})`);
          setTimeout(loadImage, retryDelay);
        } else {
          console.error(`Failed to load image ${image.image_id} after ${maxRetries} attempts:`, err);
          setImageSrc(''); // Fallback to empty
        }
      }
    };
    
    loadImage();
    
    return () => {
      // Cleanup: revoke blob URL when component unmounts
      if (imageSrc) {
        imageService.revokeImageUrl(image.image_id, image.file_extension);
      }
    };
  }, [image.image_id, image.file_extension]);
  
  // Update local caption when prop changes
  useEffect(() => {
    setCaption(image.caption);
  }, [image.caption]);
  
  // Update edit position when editing starts
  useEffect(() => {
    if (isEditing && captionRef.current) {
      const rect = captionRef.current.getBoundingClientRect();
      setEditPosition({
        x: rect.left,
        y: rect.top,
        width: Math.max(rect.width, 200)
      });
    } else {
      setEditPosition(null);
    }
  }, [isEditing]);
  
  const handleSaveCaption = () => {
    if (caption.trim() !== image.caption) {
      onCaptionEdit(caption.trim());
    }
    setIsEditing(false);
    setEditPosition(null);
  };
  
  const handleCancelEdit = () => {
    setCaption(image.caption);
    setIsEditing(false);
    setEditPosition(null);
  };
  
  const handleStartEdit = () => {
    setIsEditing(true);
  };
  
  return (
    <div className="image-thumbnail" style={{ width: '80px', minWidth: '80px' }}>
      {/* Image Square */}
      <div 
        onClick={onClick}
        style={{
          width: '80px',
          height: '80px',
          borderRadius: '8px',
          overflow: 'hidden',
          border: '1px solid #e2e8f0',
          background: '#f8fafc',
          position: 'relative',
          cursor: onClick ? 'pointer' : 'default'
        }}
      >
        {imageSrc ? (
          <img 
            src={imageSrc} 
            alt={image.caption}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover'
            }}
          />
        ) : (
          <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#cbd5e1',
            fontSize: '12px'
          }}>
            Loading...
          </div>
        )}
        
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
            justifyContent: 'center',
            transition: 'background 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.8)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.6)'}
          title="Delete image"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      
      {/* Caption */}
      <div ref={captionRef} style={{ marginTop: '4px', position: 'relative' }}>
        {!isEditing && (
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
            <span title={caption}>{caption}</span>
            <button
              onClick={handleStartEdit}
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
              <span 
                className="overridden-indicator" 
                style={{ display: 'inline-flex', alignItems: 'center' }}
                title="Caption overridden from node file"
              >
                <Zap size={11} strokeWidth={2} style={{ color: '#f59e0b' }} />
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Editing UI rendered via portal */}
      {isEditing && editPosition && createPortal(
        <div style={{ 
          position: 'fixed',
          left: `${editPosition.x}px`,
          top: `${editPosition.y}px`,
          display: 'flex', 
          gap: '4px', 
          alignItems: 'center',
          width: `${editPosition.width}px`,
          zIndex: 10001,
          backgroundColor: 'white',
          padding: '4px',
          borderRadius: '4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
        }}>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveCaption();
              if (e.key === 'Escape') handleCancelEdit();
            }}
            style={{
              fontSize: '11px',
              padding: '4px 6px',
              border: '1px solid #cbd5e1',
              borderRadius: '3px',
              minWidth: '120px',
              flex: 1,
              fontFamily: 'inherit',
              backgroundColor: 'white'
            }}
            autoFocus
          />
          <button 
            onClick={handleSaveCaption}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              padding: '4px 6px',
              background: 'white',
              border: '1px solid #cbd5e1',
              borderRadius: '3px',
              cursor: 'pointer',
              flexShrink: 0,
              minWidth: '28px',
              height: '24px'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f0fdf4'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
            title="Save"
          >
            <Check size={14} strokeWidth={2} style={{ color: '#10b981' }} />
          </button>
          <button 
            onClick={handleCancelEdit}
            style={{ 
              display: 'flex', 
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 6px',
              background: 'white',
              border: '1px solid #cbd5e1',
              borderRadius: '3px',
              cursor: 'pointer',
              flexShrink: 0,
              minWidth: '28px',
              height: '24px'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#fef2f2'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
            title="Cancel"
          >
            <X size={14} strokeWidth={2} style={{ color: '#ef4444' }} />
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

