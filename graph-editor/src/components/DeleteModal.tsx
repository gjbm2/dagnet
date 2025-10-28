import React, { useState } from 'react';
import { createPortal } from 'react-dom';

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDelete: (message: string) => Promise<void>;
  fileName: string;
  fileType: string;
}

/**
 * Delete File Modal
 * Confirms deletion of a file from the repository
 */
export function DeleteModal({ isOpen, onClose, onDelete, fileName, fileType }: DeleteModalProps) {
  const [deleteMessage, setDeleteMessage] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleDelete = async () => {
    if (!deleteMessage.trim()) {
      setError('Please enter a deletion message');
      return;
    }

    setIsDeleting(true);
    setError(null);
    setSuccess(false);

    try {
      await onDelete(deleteMessage.trim());
      
      // Show success message
      setSuccess(true);
      setIsDeleting(false);
      
      // Close modal after a short delay
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to delete file');
      setIsDeleting(false);
      setSuccess(false);
    }
  };

  const handleCancel = () => {
    setDeleteMessage('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  if (!isOpen) return null;

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
          minWidth: '500px',
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
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
            color: '#d32f2f'
          }}>Delete from Repository</h3>
        </div>

        {/* Body */}
        <div style={{
          padding: '24px',
          overflowY: 'auto',
          flex: 1
        }}>
          {/* Warning */}
          <div style={{
            padding: '12px',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px',
            color: '#856404',
            fontSize: '14px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px'
          }}>
            <span style={{ fontSize: '18px', flexShrink: 0 }}>⚠️</span>
            <div>
              <strong>Warning: This action cannot be undone!</strong>
              <div style={{ marginTop: '4px' }}>
                You are about to permanently delete <strong>{fileName}</strong> ({fileType}) from the repository.
              </div>
            </div>
          </div>

          {/* Deletion message */}
          <div style={{ marginBottom: '20px' }}>
            <label htmlFor="delete-message" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
              Deletion Message:
            </label>
            <textarea
              id="delete-message"
              value={deleteMessage}
              onChange={(e) => setDeleteMessage(e.target.value)}
              placeholder={`Delete ${fileType}: ${fileName}`}
              rows={3}
              disabled={isDeleting || success}
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '14px',
                minHeight: '60px',
                resize: 'vertical'
              }}
            />
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

          {/* Success message */}
          {success && (
            <div style={{
              padding: '12px',
              backgroundColor: '#e8f5e9',
              border: '1px solid #a5d6a7',
              borderRadius: '4px',
              color: '#2e7d32',
              fontSize: '14px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span style={{ fontSize: '18px' }}>✓</span>
              <span>Successfully deleted {fileName} from repository</span>
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
            disabled={isDeleting || success}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isDeleting || success) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#f0f0f0',
              color: '#333',
              opacity: (isDeleting || success) ? 0.5 : 1
            }}
          >
            {success ? 'Closing...' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting || success || !deleteMessage.trim()}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isDeleting || success || !deleteMessage.trim()) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: success ? '#2e7d32' : '#d32f2f',
              color: 'white',
              opacity: (isDeleting || success || !deleteMessage.trim()) ? 0.5 : 1
            }}
          >
            {isDeleting ? 'Deleting...' : success ? 'Deleted ✓' : 'Delete from Repository'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

