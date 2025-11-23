/**
 * Image Upload Modal
 * 
 * Provides 3 upload sources:
 * - Local file picker
 * - Fetch from URL
 * - Paste from clipboard
 */

import * as React from 'react';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { File as FileIcon, Globe, Clipboard, X } from 'lucide-react';
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
  
  // Preview state
  const [previewData, setPreviewData] = useState<Uint8Array | null>(null);
  const [previewExtension, setPreviewExtension] = useState<string>('png');
  const [previewSource, setPreviewSource] = useState<string>('local');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  // Clipboard paste is always supported via paste event
  const clipboardSupported = true;
  
  // Handlers for preview actions
  const handleConfirmUpload = () => {
    if (!previewData) return;
    onUpload(previewData, previewExtension as 'png' | 'jpg' | 'jpeg', previewSource, caption.trim() || undefined);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    onClose();
  };
  
  const handleCancelPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewData(null);
    setPreviewExtension('png');
    setPreviewUrl(null);
    setError(null);
    setCaption('');
  };
  
  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  
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
      
      // Show preview instead of immediately uploading
      const blob = new Blob([data], { type: `image/${ext}` });
      const blobUrl = URL.createObjectURL(blob);
      
      setPreviewData(data);
      setPreviewExtension(ext);
      setPreviewSource('local');
      setPreviewUrl(blobUrl);
      setIsLoading(false);
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
      
      // Show preview instead of immediately uploading
      const previewBlob = new Blob([data], { type: `image/${ext}` });
      const blobUrl = URL.createObjectURL(previewBlob);
      
      setPreviewData(data);
      setPreviewExtension(ext);
      setPreviewSource('url');
      setPreviewUrl(blobUrl);
      setIsLoading(false);
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
  
  const handleClipboardPaste = async (e: ClipboardEvent) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const items = e.clipboardData?.items;
      if (!items) {
        throw new Error('No clipboard data available');
      }
      
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          
          // Validate and compress
          const validation = validateImage(blob);
          if (!validation.valid) {
            throw new Error(validation.error!);
          }
          
          const compressed = await compressImage(blob);
          const arrayBuffer = await compressed.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          const ext = item.type.split('/')[1] || 'png';
          
          // Show preview instead of immediately uploading
          const previewBlob = new Blob([data], { type: `image/${ext}` });
          const blobUrl = URL.createObjectURL(previewBlob);
          
          setPreviewData(data);
          setPreviewExtension(ext);
          setPreviewSource('clipboard');
          setPreviewUrl(blobUrl);
          setIsLoading(false);
          return;
        }
      }
      
      setError('No image found in clipboard. Copy an image first.');
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to paste image');
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
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
            {previewData ? 'Confirm Image' : 'Upload Image'}
          </h3>
          <button
            onClick={() => {
              if (previewUrl) URL.revokeObjectURL(previewUrl);
              onClose();
            }}
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
        
        {/* Show preview if image is loaded, otherwise show tabs */}
        {previewData && previewUrl ? (
          <>
            {/* Image Preview */}
            <div style={{
              width: '100%',
              marginBottom: '20px',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              overflow: 'hidden',
              background: '#f8fafc'
            }}>
              <img
                src={previewUrl}
                alt="Preview"
                style={{
                  width: '100%',
                  maxHeight: '400px',
                  objectFit: 'contain',
                  display: 'block'
                }}
              />
            </div>
            
            {/* Caption Input (below preview) */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '6px' }}>
                Caption (optional)
              </label>
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Image caption..."
                autoFocus
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
            
            {/* Ok/Cancel Buttons */}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelPreview}
                style={{
                  padding: '8px 16px',
                  background: 'white',
                  color: '#64748b',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 500
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmUpload}
                style={{
                  padding: '8px 16px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 500
                }}
              >
                Ok
              </button>
            </div>
          </>
        ) : (
          <>
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
            <FileIcon size={16} /> Local File
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
              <div
                tabIndex={0}
                onPaste={(e) => handleClipboardPaste(e.nativeEvent)}
                style={{
                  width: '100%',
                  minHeight: '120px',
                  border: '2px dashed #cbd5e1',
                  borderRadius: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '12px',
                  padding: '24px',
                  background: '#f8fafc',
                  cursor: 'text',
                  outline: 'none',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f1f5f9';
                  e.currentTarget.style.borderColor = '#94a3b8';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#f8fafc';
                  e.currentTarget.style.borderColor = '#cbd5e1';
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#3b82f6';
                  e.currentTarget.style.background = '#eff6ff';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = '#cbd5e1';
                  e.currentTarget.style.background = '#f8fafc';
                }}
              >
                <Clipboard size={32} style={{ color: '#94a3b8' }} />
                <p style={{ fontSize: '14px', color: '#64748b', textAlign: 'center', margin: 0 }}>
                  Click here and press <strong>Ctrl+V</strong> (or <strong>Cmd+V</strong>) to paste an image
                </p>
              </div>
              <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
                Copy an image (from browser, screenshot, etc.) then paste it here.
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
          </>
        )}
      </div>
    </div>
  );
  
  return createPortal(modalContent, document.body) as React.ReactElement;
}

