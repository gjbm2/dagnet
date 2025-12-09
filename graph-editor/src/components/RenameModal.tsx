import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRename: (newName: string) => Promise<boolean>;
  currentName: string;
  fileType: string;
  isRenaming?: boolean;
}

/**
 * Rename Modal
 * Prompts for new file name and handles the rename operation
 */
export function RenameModal({ 
  isOpen, 
  onClose, 
  onRename, 
  currentName, 
  fileType,
  isRenaming: externalIsRenaming = false 
}: RenameModalProps) {
  const [newName, setNewName] = useState(currentName);
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setNewName(currentName);
      setError(null);
      setIsRenaming(false);
    }
  }, [isOpen, currentName]);

  const handleRename = async () => {
    const trimmedName = newName.trim();
    
    if (!trimmedName) {
      setError('Name cannot be empty');
      return;
    }

    if (trimmedName === currentName) {
      onClose();
      return;
    }

    // Validate name (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      setError('Name can only contain letters, numbers, hyphens, and underscores');
      return;
    }

    setIsRenaming(true);
    setError(null);

    try {
      const success = await onRename(trimmedName);
      if (success) {
        onClose();
      } else {
        // Error will be shown via toast in the hook
        setIsRenaming(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename');
      setIsRenaming(false);
    }
  };

  const handleCancel = () => {
    setNewName(currentName);
    setError(null);
    setIsRenaming(false);
    onClose();
  };

  if (!isOpen) return null;

  const isSubmitting = isRenaming || externalIsRenaming;
  const hasChanges = newName.trim() !== currentName;
  const fileExtension = fileType === 'graph' ? '.json' : '.yaml';

  // Determine if this is a graph or parameter file for messaging
  const isGraph = fileType === 'graph';
  const fileTypeLabel = fileType.charAt(0).toUpperCase() + fileType.slice(1);

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
            Rename {fileTypeLabel}
          </h3>
        </div>

        {/* Body */}
        <div style={{
          padding: '24px'
        }}>
          {/* Info about what will be updated */}
          {!isGraph && (
            <div style={{
              padding: '12px',
              backgroundColor: '#f0f7ff',
              border: '1px solid #d0e3ff',
              borderRadius: '4px',
              fontSize: '13px',
              color: '#0055aa',
              marginBottom: '20px',
              lineHeight: 1.4
            }}>
              <strong>Note:</strong> Renaming will update the file's ID and all references 
              to it in other files (graphs, parameters, etc.) to maintain integrity.
            </div>
          )}

          {/* File name input */}
          <div style={{ marginBottom: '20px' }}>
            <label htmlFor="new-name" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
              New Name:
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="new-name"
                type="text"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSubmitting && hasChanges) {
                    handleRename();
                  } else if (e.key === 'Escape') {
                    handleCancel();
                  }
                }}
                placeholder={currentName}
                disabled={isSubmitting}
                autoFocus
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  paddingRight: '80px',
                  border: `1px solid ${error ? '#cc3333' : '#ccc'}`,
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
              fontSize: '14px'
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
            disabled={isSubmitting}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#f0f0f0',
              color: '#333',
              opacity: isSubmitting ? 0.5 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRename}
            disabled={isSubmitting || !hasChanges}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isSubmitting || !hasChanges) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#0066cc',
              color: 'white',
              opacity: (isSubmitting || !hasChanges) ? 0.5 : 1
            }}
          >
            {isSubmitting ? 'Renaming...' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}








