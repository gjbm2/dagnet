/**
 * Image Stack Indicator
 * 
 * Displays a 12×12px preview of the first image with a "stack" effect
 * if there are multiple images.
 */

import React, { useState, useEffect } from 'react';
import { imageService } from '../services/imageService';
import type { NodeImage } from '../types';

interface ImageStackIndicatorProps {
  images: NodeImage[];
}

export function ImageStackIndicator({ images }: ImageStackIndicatorProps) {
  const [imageSrc, setImageSrc] = useState<string>('');
  const firstImage = images[0];
  const hasMultiple = images.length > 1;
  
  useEffect(() => {
    if (!firstImage) return;
    
    imageService.getImageUrl(firstImage.image_id, firstImage.file_extension)
      .then(setImageSrc)
      .catch(err => {
        console.error(`Failed to load image ${firstImage.image_id}:`, err);
      });
    
    return () => {
      if (firstImage) {
        imageService.revokeImageUrl(firstImage.image_id, firstImage.file_extension);
      }
    };
  }, [firstImage?.image_id, firstImage?.file_extension]);
  
  if (!firstImage) return null;
  
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '12px', height: '12px' }}>
      {/* Stack effect - show 2-3 overlapping squares */}
      {hasMultiple && (
        <>
          <div style={{
            position: 'absolute',
            width: '12px',
            height: '12px',
            borderRadius: '3px',
            background: '#fff',
            border: '1px solid #cbd5e1',
            top: '-2px',
            left: '-2px',
            zIndex: 1
          }} />
          <div style={{
            position: 'absolute',
            width: '12px',
            height: '12px',
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
        width: '12px',
        height: '12px',
        minWidth: '12px',
        minHeight: '12px',
        borderRadius: '3px',
        overflow: 'hidden',
        border: '1px solid #cbd5e1',
        background: '#fff',
        position: 'relative',
        zIndex: 3,
        flexShrink: 0
      }}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={firstImage.caption}
            style={{
              width: '12px',
              height: '12px',
              objectFit: 'cover',
              objectPosition: 'center',
              display: 'block',
              margin: 0,
              padding: 0
            }}
          />
        ) : (
          <div style={{
            width: '12px',
            height: '12px',
            background: '#f8fafc',
            display: 'block'
          }} />
        )}
      </div>
    </div>
  );
}

