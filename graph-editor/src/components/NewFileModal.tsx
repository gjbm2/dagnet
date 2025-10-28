import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ObjectType } from '../types';

interface NewFileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: ObjectType) => Promise<void>;
  fileType?: ObjectType; // If provided, type selector is hidden and this type is used
  defaultName?: string; // For duplicate functionality
}

/**
 * New File Modal
 * Prompts for file name and type (if not pre-selected)
 */
export function NewFileModal({ isOpen, onClose, onCreate, fileType, defaultName = '' }: NewFileModalProps) {
  const [fileName, setFileName] = useState(defaultName);
  const [selectedType, setSelectedType] = useState<ObjectType>(fileType || 'graph');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmedName = fileName.trim();
    
    if (!trimmedName) {
      setError('Please enter a file name');
      return;
    }

    // Validate name (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      setError('File name can only contain letters, numbers, hyphens, and underscores');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const typeToUse = fileType || selectedType;
      await onCreate(trimmedName, typeToUse);
      
      // Success - close modal
      handleCancel();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create file');
      setIsCreating(false);
    }
  };

  const handleCancel = () => {
    setFileName(defaultName);
    setSelectedType(fileType || 'graph');
    setError(null);
    setIsCreating(false);
    onClose();
  };

  if (!isOpen) return null;

  const typeToUse = fileType || selectedType;
  const fileExtension = typeToUse === 'graph' ? '.json' : '.yaml';

  const modalContent = (
    <div 
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
        zIndex: 10000
      }}
      onClick={handleCancel}
    >
      <div 
        style={{
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
          minWidth: '400px',
          maxWidth: '500px',
          width: '90%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid #e0e0e0'
        }}>
          <h3 style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            color: '#333'
          }}>
            {defaultName ? 'Duplicate File' : 'New File'}
          </h3>
        </div>

        {/* Body */}
        <div style={{
          padding: '24px'
        }}>
          {/* File type selector (if not pre-selected) */}
          {!fileType && (
            <div style={{ marginBottom: '20px' }}>
              <label htmlFor="file-type" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                File Type:
              </label>
              <select
                id="file-type"
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value as ObjectType)}
                disabled={isCreating}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #ccc',
                  fontSize: '14px',
                  backgroundColor: '#fff',
                  cursor: isCreating ? 'not-allowed' : 'pointer'
                }}
              >
                <option value="graph">Graph</option>
                <option value="parameter">Parameter</option>
                <option value="context">Context</option>
                <option value="case">Case</option>
              </select>
            </div>
          )}

          {/* File name input */}
          <div style={{ marginBottom: '20px' }}>
            <label htmlFor="file-name" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
              File Name:
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="file-name"
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreate();
                  } else if (e.key === 'Escape') {
                    handleCancel();
                  }
                }}
                placeholder={`my-${typeToUse}`}
                disabled={isCreating}
                autoFocus
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  paddingRight: '80px',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              <span style={{
                position: 'absolute',
                right: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#888',
                fontSize: '14px',
                pointerEvents: 'none'
              }}>
                {fileExtension}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              Letters, numbers, hyphens, and underscores only
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div style={{
              padding: '12px',
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              borderRadius: '4px',
              color: '#c33',
              fontSize: '14px',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px'
        }}>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isCreating}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: isCreating ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#f0f0f0',
              color: '#333',
              opacity: isCreating ? 0.5 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating || !fileName.trim()}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isCreating || !fileName.trim()) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#0066cc',
              color: 'white',
              opacity: (isCreating || !fileName.trim()) ? 0.5 : 1
            }}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

