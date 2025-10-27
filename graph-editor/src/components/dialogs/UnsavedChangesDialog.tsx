import React from 'react';
import './Dialog.css';

/**
 * Unsaved Changes Dialog
 * 
 * Shown when user tries to close a tab with unsaved changes
 */
interface UnsavedChangesDialogProps {
  isOpen: boolean;
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  isOpen,
  fileName,
  onSave,
  onDiscard,
  onCancel
}: UnsavedChangesDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="dialog-overlay">
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 className="dialog-title">Unsaved Changes</h2>
        </div>

        <div className="dialog-body">
          <p>
            Do you want to save the changes you made to <strong>{fileName}</strong>?
          </p>
          <p className="dialog-subtitle">
            Your changes will be lost if you don't save them.
          </p>
        </div>

        <div className="dialog-footer">
          <button 
            className="dialog-button dialog-button-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>

          <button 
            className="dialog-button dialog-button-danger"
            onClick={onDiscard}
          >
            Don't Save
          </button>

          <button 
            className="dialog-button dialog-button-primary"
            onClick={onSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

