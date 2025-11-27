import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
}

export interface TripleChoiceDialogOptions {
  title: string;
  message: string;
  primaryLabel: string;      // e.g., "Pull Now"
  secondaryLabel: string;    // e.g., "Proceed Anyway"
  cancelLabel?: string;      // e.g., "Cancel"
  primaryVariant?: 'danger' | 'primary';
  secondaryVariant?: 'danger' | 'primary';
}

export type TripleChoiceResult = 'primary' | 'secondary' | 'cancel';

interface DialogContextValue {
  showConfirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  showTripleChoice: (options: TripleChoiceDialogOptions) => Promise<TripleChoiceResult>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{
    options: ConfirmDialogOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const [tripleDialog, setTripleDialog] = useState<{
    options: TripleChoiceDialogOptions;
    resolve: (value: TripleChoiceResult) => void;
  } | null>(null);

  const showConfirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setDialog({ options, resolve });
    });
  }, []);

  const showTripleChoice = useCallback((options: TripleChoiceDialogOptions): Promise<TripleChoiceResult> => {
    return new Promise((resolve) => {
      setTripleDialog({ options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (dialog) {
      dialog.resolve(true);
      setDialog(null);
    }
  }, [dialog]);

  const handleCancel = useCallback(() => {
    if (dialog) {
      dialog.resolve(false);
      setDialog(null);
    }
  }, [dialog]);

  const handleTripleChoice = useCallback((result: TripleChoiceResult) => {
    if (tripleDialog) {
      tripleDialog.resolve(result);
      setTripleDialog(null);
    }
  }, [tripleDialog]);

  return (
    <DialogContext.Provider value={{ showConfirm, showTripleChoice }}>
      {children}
      {dialog && createPortal(
        <ConfirmDialog
          {...dialog.options}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />,
        document.body
      )}
      {tripleDialog && createPortal(
        <TripleChoiceDialog
          {...tripleDialog.options}
          onChoice={handleTripleChoice}
        />,
        document.body
      )}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialog must be used within DialogProvider');
  }
  return context;
}

interface ConfirmDialogProps extends ConfirmDialogOptions {
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  return (
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
        zIndex: 10001  // Higher than CommitModal (10000) to ensure this appears on top
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
          maxWidth: '480px',
          width: '90%',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid #e0e0e0'
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: '18px',
              fontWeight: 600,
              color: '#333'
            }}
          >
            {title}
          </h3>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '24px',
            fontSize: '14px',
            color: '#666',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap'
          }}
        >
          {message}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px'
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              border: '1px solid #d0d0d0',
              background: '#fff',
              color: '#666',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f5f5';
              e.currentTarget.style.borderColor = '#b0b0b0';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.borderColor = '#d0d0d0';
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              border: 'none',
              background: confirmVariant === 'danger' ? '#dc3545' : '#007bff',
              color: '#fff',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = confirmVariant === 'danger' ? '#c82333' : '#0056b3';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = confirmVariant === 'danger' ? '#dc3545' : '#007bff';
            }}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TripleChoiceDialogProps extends TripleChoiceDialogOptions {
  onChoice: (result: TripleChoiceResult) => void;
}

function TripleChoiceDialog({
  title,
  message,
  primaryLabel,
  secondaryLabel,
  cancelLabel = 'Cancel',
  primaryVariant = 'primary',
  secondaryVariant = 'primary',
  onChoice
}: TripleChoiceDialogProps) {
  const getButtonStyle = (variant: 'danger' | 'primary', isOutline: boolean = false) => {
    if (isOutline) {
      return {
        padding: '8px 16px',
        fontSize: '14px',
        fontWeight: 500 as const,
        border: `1px solid ${variant === 'danger' ? '#dc3545' : '#007bff'}`,
        background: '#fff',
        color: variant === 'danger' ? '#dc3545' : '#007bff',
        borderRadius: '6px',
        cursor: 'pointer' as const,
        transition: 'all 0.2s'
      };
    }
    return {
      padding: '8px 16px',
      fontSize: '14px',
      fontWeight: 500 as const,
      border: 'none',
      background: variant === 'danger' ? '#dc3545' : '#007bff',
      color: '#fff',
      borderRadius: '6px',
      cursor: 'pointer' as const,
      transition: 'all 0.2s'
    };
  };

  return (
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
        zIndex: 10001
      }}
      onClick={() => onChoice('cancel')}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
          maxWidth: '480px',
          width: '90%',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #e0e0e0' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: '#333' }}>
            {title}
          </h3>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', fontSize: '14px', color: '#666', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
          {message}
        </div>

        {/* Footer with 3 buttons */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px'
          }}
        >
          <button
            onClick={() => onChoice('cancel')}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              border: '1px solid #d0d0d0',
              background: '#fff',
              color: '#666',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => onChoice('secondary')}
            style={getButtonStyle(secondaryVariant, true)}
          >
            {secondaryLabel}
          </button>
          <button
            onClick={() => onChoice('primary')}
            style={getButtonStyle(primaryVariant)}
            autoFocus
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

