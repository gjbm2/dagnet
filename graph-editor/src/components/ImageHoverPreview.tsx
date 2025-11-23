/**
 * Image Hover Preview
 * 
 * Shows a popup with the first image when hovering over the node face indicator.
 * Max size 200×200px.
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { imageService } from '../services/imageService';
import type { NodeImage } from '../types';

interface ImageHoverPreviewProps {
  image: NodeImage;
  position: { x: number; y: number };
}

export function ImageHoverPreview({ image, position }: ImageHoverPreviewProps) {
  const [imageSrc, setImageSrc] = useState<string>('');
  
  useEffect(() => {
    imageService.getImageUrl(image.image_id, image.file_extension)
      .then(setImageSrc)
      .catch(err => {
        console.error(`Failed to load image ${image.image_id}:`, err);
      });
    
    return () => {
      imageService.revokeImageUrl(image.image_id, image.file_extension);
    };
  }, [image.image_id, image.file_extension]);
  
  if (!imageSrc || !position || (position.x === 0 && position.y === 0)) return null;
  
  const previewContent = (
    <div
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        pointerEvents: 'none',
        zIndex: 10001,
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
        src={imageSrc}
        alt={image.caption}
        style={{
          maxWidth: '200px',
          maxHeight: '200px',
          display: 'block',
          borderRadius: '4px',
          objectFit: 'contain'
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
  
  return createPortal(previewContent, document.body);
}

