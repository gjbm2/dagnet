/**
 * DEPRECATED: This file has been replaced by the new tab-based editor system
 * 
 * The old full-page parameter editor has been deprecated in favor of:
 * - New tab-based AppShell (src/AppShell.tsx)
 * - FormEditor component (src/components/editors/FormEditor.tsx)
 * - Centralized file type registry (src/config/fileTypeRegistry.ts)
 * 
 * All parameter, context, and case editing now happens through the main
 * application interface with proper tab management, undo/redo, and file synchronization.
 * 
 * This file is kept for reference only and should not be used.
 * 
 * To edit parameters/contexts/cases:
 * 1. Open the main application (AppShell)
 * 2. Use the Navigator panel to browse files
 * 3. Click to open in Form Editor or JSON/YAML view
 * 
 * Date Deprecated: 2025-10-28
 */

export default function DeprecatedParamsPage() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      flexDirection: 'column',
      gap: '20px',
      fontFamily: 'system-ui, sans-serif',
      padding: '20px',
      textAlign: 'center'
    }}>
      <h1 style={{ fontSize: '24px', color: '#d32f2f' }}>
        ⚠️ This Page Has Been Deprecated
      </h1>
      <p style={{ fontSize: '16px', color: '#666', maxWidth: '600px' }}>
        The old parameter editor has been replaced with a new tab-based editing system
        that provides better file management, undo/redo, and multi-view support.
      </p>
      <p style={{ fontSize: '14px', color: '#999', maxWidth: '600px' }}>
        Please use the main application to edit parameters, contexts, and cases.
        All files are now accessible through the Navigator panel with support for
        both form-based editing and raw JSON/YAML views.
      </p>
      <a 
        href="/"
        style={{
          padding: '12px 24px',
          background: '#2196f3',
          color: 'white',
          textDecoration: 'none',
          borderRadius: '4px',
          fontSize: '14px',
          fontWeight: 500
        }}
      >
        Go to Main Application
      </a>
    </div>
  );
}

