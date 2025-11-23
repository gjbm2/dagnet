/**
 * Image Loupe View
 * 
 * Full-screen modal for viewing images in detail.
 * Features:
 * - Large image display
 * - Navigation for multiple images
 * - Delete functionality
 * - Caption editing
 */

import * as React from 'react';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Pencil, Check, Plus } from 'lucide-react';
import { imageService } from '../services/imageService';
import { ImageThumbnail } from './ImageThumbnail';
import type { NodeImage } from '../types';
import '../components/modals/Modal.css';

interface ImageLoupeViewProps {
  images: NodeImage[];
  initialImageId?: string;
  onClose: () => void;
  onDelete: (imageId: string) => void;
  onCaptionEdit: (imageId: string, newCaption: string) => void;
  onAddImage?: () => void;
}

export function ImageLoupeView({
  images,
  initialImageId,
  onClose,
  onDelete,
  onCaptionEdit,
  onAddImage
}: ImageLoupeViewProps) {
  // Find initial index if initialImageId is provided
  const initialIndex = initialImageId 
    ? images.findIndex(img => img.image_id === initialImageId)
    : 0;
  const [currentIndex, setCurrentIndex] = useState(initialIndex >= 0 ? initialIndex : 0);
  const [imageSrc, setImageSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [isEditingCaption, setIsEditingCaption] = useState(false);
  const [caption, setCaption] = useState('');
  const [showPrevButton, setShowPrevButton] = useState(false);
  const [showNextButton, setShowNextButton] = useState(false);
  
  // Update index when initialImageId changes
  useEffect(() => {
    if (initialImageId) {
      const index = images.findIndex(img => img.image_id === initialImageId);
      if (index >= 0) {
        setCurrentIndex(index);
      }
    }
  }, [initialImageId, images]);
  
  const currentImage = images[currentIndex];
  
  // Update caption when current image changes
  useEffect(() => {
    if (currentImage) {
      setCaption(currentImage.caption);
      setIsEditingCaption(false);
    }
  }, [currentImage?.image_id, currentImage?.caption, images]);
  
  // Load current image
  useEffect(() => {
    if (!currentImage) return;
    
    setLoading(true);
    imageService.getImageUrl(currentImage.image_id, currentImage.file_extension)
      .then(src => {
        setImageSrc(src);
        setLoading(false);
      })
      .catch(err => {
        console.error(`Failed to load image ${currentImage.image_id}:`, err);
        setLoading(false);
      });
    
    return () => {
      if (currentImage) {
        imageService.revokeImageUrl(currentImage.image_id, currentImage.file_extension);
      }
    };
  }, [currentImage?.image_id, currentImage?.file_extension]);
  
  const handleDelete = () => {
    onDelete(currentImage.image_id);
    if (images.length === 1) {
      onClose();
    } else if (currentIndex === images.length - 1) {
      setCurrentIndex(currentIndex - 1);
    }
  };
  
  const handlePrevious = () => {
    setCurrentIndex(Math.max(0, currentIndex - 1));
  };
  
  const handleNext = () => {
    setCurrentIndex(Math.min(images.length - 1, currentIndex + 1));
  };
  
  const handleSaveCaption = () => {
    if (currentImage && caption.trim() !== currentImage.caption) {
      onCaptionEdit(currentImage.image_id, caption.trim());
    }
    setIsEditingCaption(false);
  };
  
  const handleCancelEdit = () => {
    if (currentImage) {
      setCaption(currentImage.caption);
    }
    setIsEditingCaption(false);
  };
  
  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isEditingCaption) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, isEditingCaption]);
  
  const modalContent = (
    <div className="modal-overlay" onClick={onClose} style={{ background: 'rgba(0,0,0,0.8)', zIndex: 10001 }}>
      <div
        className="modal-container"
        style={{
          maxWidth: '1200px',
          width: '90vw',
          maxHeight: '90vh',
          position: 'relative'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with close button */}
        <div className="modal-header" style={{ position: 'relative' }}>
          <h2 className="modal-title">Image Viewer</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {onAddImage && (
              <button
                onClick={onAddImage}
                className="modal-btn modal-btn-secondary"
                style={{ fontSize: '13px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <Plus size={14} strokeWidth={2} /> Add
              </button>
            )}
            <button
              onClick={handleDelete}
              className="modal-btn modal-btn-danger"
              style={{ fontSize: '13px', padding: '6px 12px' }}
            >
              Delete
            </button>
            <button className="modal-close-btn" onClick={onClose}>
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
        
        {/* Body */}
        <div className="modal-body" style={{ 
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          minHeight: 0
        }}>
          {/* Image with hover navigation buttons */}
          <div 
            style={{ 
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              minHeight: 0,
              position: 'relative'
            }}
            onMouseEnter={() => {
              if (images.length > 1) {
                setShowPrevButton(currentIndex > 0);
                setShowNextButton(currentIndex < images.length - 1);
              }
            }}
            onMouseLeave={() => {
              setShowPrevButton(false);
              setShowNextButton(false);
            }}
          >
            {/* Previous button (left side) */}
            {images.length > 1 && showPrevButton && currentIndex > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePrevious();
                }}
                style={{
                  position: 'absolute',
                  left: '0',
                  top: '0',
                  bottom: '0',
                  width: '120px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  paddingLeft: '20px',
                  zIndex: 10,
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  const icon = e.currentTarget.querySelector('div');
                  if (icon) {
                    icon.style.background = 'rgba(0, 0, 0, 0.8)';
                  }
                }}
                onMouseLeave={(e) => {
                  const icon = e.currentTarget.querySelector('div');
                  if (icon) {
                    icon.style.background = 'rgba(0, 0, 0, 0.6)';
                  }
                }}
              >
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s'
                }}>
                  <ChevronLeft size={24} strokeWidth={2} />
                </div>
              </button>
            )}
            
            {/* Next button (right side) */}
            {images.length > 1 && showNextButton && currentIndex < images.length - 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNext();
                }}
                style={{
                  position: 'absolute',
                  right: '0',
                  top: '0',
                  bottom: '0',
                  width: '120px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: '20px',
                  zIndex: 10,
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  const icon = e.currentTarget.querySelector('div');
                  if (icon) {
                    icon.style.background = 'rgba(0, 0, 0, 0.8)';
                  }
                }}
                onMouseLeave={(e) => {
                  const icon = e.currentTarget.querySelector('div');
                  if (icon) {
                    icon.style.background = 'rgba(0, 0, 0, 0.6)';
                  }
                }}
              >
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s'
                }}>
                  <ChevronRight size={24} strokeWidth={2} />
                </div>
              </button>
            )}
            
            {loading && (
              <div style={{
                width: '100%',
                height: '400px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                fontSize: '14px'
              }}>
                Loading...
              </div>
            )}
            {imageSrc && (
              <img
                src={imageSrc}
                alt={currentImage.caption}
                onLoad={() => setLoading(false)}
                style={{
                  maxWidth: '100%',
                  maxHeight: 'calc(90vh - 200px)',
                  objectFit: 'contain',
                  borderRadius: '8px',
                  display: loading ? 'none' : 'block'
                }}
              />
            )}
          </div>
          
          {/* Caption */}
          <div style={{ 
            marginTop: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}>
            {isEditingCaption ? (
              <>
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveCaption();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  style={{
                    fontSize: '14px',
                    padding: '6px 10px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '4px',
                    minWidth: '200px',
                    maxWidth: '500px',
                    width: '100%',
                    fontFamily: 'inherit',
                    textAlign: 'center'
                  }}
                  autoFocus
                />
                <button 
                  onClick={handleSaveCaption}
                  className="modal-btn modal-btn-primary"
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center',
                    padding: '6px 12px'
                  }}
                  title="Save"
                >
                  <Check size={16} strokeWidth={2} />
                </button>
                <button 
                  onClick={handleCancelEdit}
                  className="modal-btn modal-btn-secondary"
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center',
                    padding: '6px 12px'
                  }}
                  title="Cancel"
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </>
            ) : (
              <>
                <span style={{ 
                  fontSize: '14px', 
                  color: '#64748b',
                  fontWeight: 500
                }}>
                  {currentImage.caption}
                </span>
                <button
                  onClick={() => setIsEditingCaption(true)}
                  className="modal-btn modal-btn-secondary"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '4px 8px',
                    fontSize: '12px'
                  }}
                  title="Edit caption"
                >
                  <Pencil size={14} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        </div>
        
        {/* Footer with image dots indicator */}
        {images.length > 1 && (
          <div className="modal-footer" style={{ justifyContent: 'center', gap: '8px' }}>
            {images.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentIndex(index)}
                style={{
                  width: index === currentIndex ? '10px' : '6px',
                  height: '6px',
                  borderRadius: '50%',
                  border: 'none',
                  background: index === currentIndex ? '#0066cc' : '#cbd5e1',
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'all 0.2s'
                }}
                title={`Image ${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

