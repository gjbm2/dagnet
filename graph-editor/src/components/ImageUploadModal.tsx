/**
 * Image Upload Modal
 * 
 * Provides 3 upload sources:
 * - Local file picker
 * - Fetch from URL
 * - Paste from clipboard
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { File, Globe, Clipboard, X } from 'lucide-react';
import { validateImage, compressImage } from '../utils/imageCompression';

interface ImageUploadModalProps {
  onClose: () => void;
  onUpload: (imageData: Uint8Array, extension: string, source: string, caption?: string) => void;
}

export function ImageUploadModal({ onClose, onUpload }: ImageUploadModalProps) {
  const [activeTab, setActiveTab] = useState<'local' | 'url' | 'clipboard'>('local');
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Check clipboard API support
  const clipboardSupported = typeof navigator !== 'undefined' && 
    navigator.clipboard && 
    typeof navigator.clipboard.read === 'function';
  
  const handleLocalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setError(null);
    setIsLoading(true);
    
    try {
      // Validate file
      const validation = validateImage(file);
      if (!validation.valid) {
        setError(validation.error!);
        setIsLoading(false);
        return;
      }
      
      // Compress image
      const compressed = await compressImage(file);
      
      // Read as Uint8Array
      const arrayBuffer = await compressed.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
      
      onUpload(data, ext as 'png' | 'jpg' | 'jpeg', 'local', caption.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process image');
      setIsLoading(false);
    }
  };
  
  const handleUrlUpload = async () => {
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }
    
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
      const validation = validateImage(file);
      if (!validation.valid) {
        throw new Error(validation.error!);
      }
      
      const compressed = await compressImage(file);
      const arrayBuffer = await compressed.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const ext = blob.type.split('/')[1] || 'png';
      
      onUpload(data, ext as 'png' | 'jpg' | 'jpeg', 'url', caption.trim() || undefined);
      onClose();
    } catch (err) {
      if (err instanceof TypeError) {
        // Network/CORS error
        setError('Cannot fetch image. Try downloading it first, or check CORS settings.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch image');
      }
      setIsLoading(false);
    }
  };
  
  const handleClipboardPaste = async () => {
    if (!clipboardSupported) {
      setError('Clipboard API not supported in this browser');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const items = await navigator.clipboard.read();
      
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const file = new File([blob], 'pasted-image.png', { type });
            
            // Validate and compress
            const validation = validateImage(file);
            if (!validation.valid) {
              throw new Error(validation.error!);
            }
            
            const compressed = await compressImage(file);
            const arrayBuffer = await compressed.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            const ext = type.split('/')[1] || 'png';
            
            onUpload(data, ext as 'png' | 'jpg' | 'jpeg', 'clipboard', caption.trim() || undefined);
            onClose();
            return;
          }
        }
      }
      
      setError('No image found in clipboard');
      setIsLoading(false);
    } catch (err) {
      setError('Failed to read clipboard. Please use Ctrl+V or paste manually.');
      setIsLoading(false);
    }
  };
  
  const modalContent = (
    <div 
      className="modal-overlay" 
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10001
      }}
    >
      <div 
        className="modal-content" 
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          minWidth: '500px',
          maxWidth: '600px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Upload Image</h3>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              color: '#64748b'
            }}
          >
            <X size={20} />
          </button>
        </div>
        
        {/* Tabs */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid #e2e8f0' }}>
          <button
            onClick={() => setActiveTab('local')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'local' ? '2px solid #3b82f6' : '2px solid transparent',
              cursor: 'pointer',
              color: activeTab === 'local' ? '#3b82f6' : '#64748b',
              fontWeight: activeTab === 'local' ? 600 : 400,
              transition: 'all 0.2s'
            }}
          >
            <File size={16} /> Local File
          </button>
          <button
            onClick={() => setActiveTab('url')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'url' ? '2px solid #3b82f6' : '2px solid transparent',
              cursor: 'pointer',
              color: activeTab === 'url' ? '#3b82f6' : '#64748b',
              fontWeight: activeTab === 'url' ? 600 : 400,
              transition: 'all 0.2s'
            }}
          >
            <Globe size={16} /> From URL
          </button>
          <button
            onClick={() => setActiveTab('clipboard')}
            disabled={!clipboardSupported}
            title={!clipboardSupported ? 'Clipboard paste not supported in this browser' : ''}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'clipboard' ? '2px solid #3b82f6' : '2px solid transparent',
              cursor: clipboardSupported ? 'pointer' : 'not-allowed',
              color: !clipboardSupported ? '#cbd5e1' : (activeTab === 'clipboard' ? '#3b82f6' : '#64748b'),
              fontWeight: activeTab === 'clipboard' ? 600 : 400,
              opacity: clipboardSupported ? 1 : 0.5,
              transition: 'all 0.2s'
            }}
          >
            <Clipboard size={16} /> Paste from Clipboard
          </button>
        </div>
        
        {/* Caption Input (common to all tabs) */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '6px' }}>
            Caption (optional)
          </label>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Image caption..."
            disabled={isLoading}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '14px',
              fontFamily: 'inherit'
            }}
          />
          <p style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
            Leave empty to use default caption (Image 1, Image 2, etc.)
          </p>
        </div>
        
        {/* Tab Content */}
        <div style={{ minHeight: '150px' }}>
          {activeTab === 'local' && (
            <div>
              <input 
                type="file" 
                accept="image/png,image/jpeg,image/jpg"
                onChange={handleLocalFileUpload}
                disabled={isLoading}
                style={{
                  padding: '8px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  width: '100%',
                  cursor: 'pointer'
                }}
              />
              <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
                Select a PNG or JPG image. Max 5MB. Images will be automatically scaled to 2048×2048 and compressed.
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
                onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleUrlUpload()}
                disabled={isLoading}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontFamily: 'monospace',
                  marginBottom: '12px'
                }}
              />
              <button 
                onClick={handleUrlUpload} 
                disabled={!url.trim() || isLoading}
                style={{
                  padding: '8px 16px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: !url.trim() || isLoading ? 'not-allowed' : 'pointer',
                  opacity: !url.trim() || isLoading ? 0.5 : 1,
                  fontWeight: 500
                }}
              >
                {isLoading ? 'Fetching...' : 'Upload'}
              </button>
              <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
                Enter a direct link to an image file. The image will be fetched and compressed.
              </p>
            </div>
          )}
          
          {activeTab === 'clipboard' && (
            <div>
              <button 
                onClick={handleClipboardPaste}
                disabled={isLoading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 20px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.5 : 1,
                  fontWeight: 500,
                  fontSize: '14px'
                }}
              >
                <Clipboard size={16} /> Paste from Clipboard
              </button>
              <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
                Click the button above or press Ctrl+V / Cmd+V to paste an image from your clipboard.
              </p>
            </div>
          )}
        </div>
        
        {/* Error Message */}
        {error && (
          <div style={{
            marginTop: '16px',
            padding: '12px',
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            borderRadius: '6px',
            color: '#dc2626',
            fontSize: '13px'
          }}>
            {error}
          </div>
        )}
        
        {/* Loading Indicator */}
        {isLoading && (
          <div style={{
            marginTop: '16px',
            padding: '12px',
            background: '#eff6ff',
            border: '1px solid #93c5fd',
            borderRadius: '6px',
            color: '#1e40af',
            fontSize: '13px'
          }}>
            Processing image...
          </div>
        )}
      </div>
    </div>
  );
  
  return createPortal(modalContent, document.body) as React.ReactElement;
}

