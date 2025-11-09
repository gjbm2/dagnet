import React, { useState, useEffect, useRef } from 'react';
import { EditorProps } from '../../types';
import { useFileState, useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import Form from '@rjsf/mui';
import validator from '@rjsf/validator-ajv8';
import { RJSFSchema, RegistryWidgetsType, UiSchema, TemplatesType } from '@rjsf/utils';
import { getFileTypeConfig, getSchemaFile, getUiSchemaFile } from '../../config/fileTypeRegistry';
import { GuardedOperationModal } from '../modals/GuardedOperationModal';
import { MonacoWidget, TabbedArrayWidget, AccordionObjectFieldTemplate } from '../widgets';

/**
 * Form Editor
 * 
 * Generic form editor for Parameters, Contexts, and Cases
 * Uses @rjsf/mui with Material Design styling
 * Schemas and file type metadata are centrally managed in fileTypeRegistry
 */
export function FormEditor({ fileId, tabId, readonly = false }: EditorProps & { tabId?: string }) {
  const { data, isDirty, updateData } = useFileState(fileId);
  const { operations: navOperations } = useNavigatorContext();
  const { activeTabId, operations: tabOperations } = useTabContext();
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [uiSchema, setUiSchema] = useState<UiSchema | null>(null);
  const [formData, setFormData] = useState<any>(null);
  const initialDataRef = useRef<string>('');
  const hasLoadedRef = useRef(false);
  const formLoadTimeRef = useRef<number>(0); // Track when form data was loaded
  
  // Undo/redo history
  const historyRef = useRef<any[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  
  // Guarded operation modal state (for Apply Settings)
  const [isGuardModalOpen, setIsGuardModalOpen] = useState(false);
  
  // Base64 encoder modal state
  const [isBase64ModalOpen, setIsBase64ModalOpen] = useState(false);

  // Determine object type from fileId
  // Handle index files specially (e.g., 'parameter-index' → 'parameter-index')
  const fileIdParts = fileId.split('-');
  const objectType = fileIdParts.length > 1 && fileIdParts[fileIdParts.length - 1] === 'index'
    ? fileId // Use full fileId for index files
    : fileIdParts[0]; // Use first part for regular files

  // Load schema based on object type (using central registry)
  useEffect(() => {
    const loadSchema = async () => {
      try {
        const schemaUrl = getSchemaFile(objectType);
        
        if (!schemaUrl) {
          throw new Error(`No schema configured for type: ${objectType}`);
        }
        
        console.log(`FormEditor: Loading schema from ${schemaUrl} for ${objectType}...`);
        
        // Fetch absolute URL directly
        const response = await fetch(schemaUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
        }
        
        const contentType = response.headers.get('content-type');
        let loadedSchema;
        
        if (contentType?.includes('yaml') || schemaUrl.endsWith('.yaml') || schemaUrl.endsWith('.yml')) {
          // Parse YAML
          const yaml = await import('js-yaml');
          const text = await response.text();
          loadedSchema = yaml.load(text);
        } else {
          // Parse JSON
          loadedSchema = await response.json();
        }
        
        console.log(`FormEditor: Loaded schema:`, loadedSchema);
        setSchema(loadedSchema as RJSFSchema);
      } catch (error) {
        console.warn(`No schema found for ${objectType}, using default:`, error);
        // Use a generic schema if specific one doesn't exist
        setSchema({
          type: 'object',
          properties: {},
          additionalProperties: true
        });
      }
    };
    loadSchema();
  }, [objectType]);

  // Load UI schema (optional, for custom widgets and layout)
  useEffect(() => {
    const loadUiSchema = async () => {
      try {
        const uiSchemaUrl = getUiSchemaFile(objectType);
        
        if (!uiSchemaUrl) {
          console.log(`FormEditor: No UI schema configured for ${objectType}, using defaults`);
          setUiSchema(null);
          return;
        }
        
        console.log(`FormEditor: Loading UI schema from ${uiSchemaUrl} for ${objectType}...`);
        
        const response = await fetch(uiSchemaUrl);
        if (!response.ok) {
          console.warn(`FormEditor: Failed to fetch UI schema: ${response.status}`);
          setUiSchema(null);
          return;
        }
        
        const loadedUiSchema = await response.json();
        console.log(`FormEditor: Loaded UI schema:`, loadedUiSchema);
        setUiSchema(loadedUiSchema as UiSchema);
      } catch (error) {
        console.warn(`FormEditor: Error loading UI schema for ${objectType}:`, error);
        setUiSchema(null);
      }
    };
    loadUiSchema();
  }, [objectType]);

  // Sync external data changes to form
  useEffect(() => {
    if (data) {
      const dataStr = JSON.stringify(data);
      const formDataStr = JSON.stringify(formData);
      
      // Only update form if data actually changed (not just a re-render)
      if (dataStr !== formDataStr) {
        console.log('FormEditor: External data changed, updating form');
        setFormData(data);
        
        // Store initial data snapshot on first load
        if (!hasLoadedRef.current) {
          initialDataRef.current = dataStr;
          hasLoadedRef.current = true;
          formLoadTimeRef.current = Date.now(); // Record when form data was loaded
          console.log('FormEditor: Stored initial data snapshot');
        } else {
          // After initial load, add external changes to history (like revert or JSON editor changes)
          console.log('FormEditor: External data changed after load, adding to history');
          addToHistory(data);
        }
      }
    }
  }, [data]);

  // Reset on file change
  useEffect(() => {
    hasLoadedRef.current = false;
    initialDataRef.current = '';
    formLoadTimeRef.current = 0;
    setFormData(null);
    historyRef.current = [];
    historyIndexRef.current = -1;
    setCanUndo(false);
    setCanRedo(false);
  }, [fileId]);

  const handleApplySettings = () => {
    // Show the modal to check for other dirty files
    // Credentials will be saved as part of the atomic "Apply and Reload" operation
    setIsGuardModalOpen(true);
  };

  const applyCredentialChanges = async () => {
    try {
      // ATOMIC OPERATION: Save credentials and reload
      // This happens AFTER user confirms in the modal (after other files are discarded)
      console.log('FormEditor: Starting atomic Apply and Reload operation...');
      
      // Step 1: Save credentials to IDB
      const credentialsFile = fileRegistry.getFile('credentials-credentials');
      console.log('FormEditor: Credentials file state before save:', {
        fileId: credentialsFile?.fileId,
        isDirty: credentialsFile?.isDirty,
        hasData: !!credentialsFile?.data
      });
      
      if (credentialsFile && credentialsFile.isDirty) {
        await fileRegistry.markSaved('credentials-credentials');
        console.log('FormEditor: Credentials saved to IDB and dirty flag cleared');
      }
      
      // Step 2: Reload with the new credentials
      console.log('FormEditor: Reloading with new credentials...');
      await navOperations.reloadCredentials();
      console.log('FormEditor: Credential reload complete');
    } catch (e) {
      console.error('Failed to apply and reload credentials', e);
      alert('Failed to apply credentials: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const renderContextualTopbar = () => {
    // Extensible: add cases for other object types in future
    if (objectType === 'credentials') {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 1
        }}>
          <button
            onClick={() => setIsBase64ModalOpen(true)}
            style={{
              background: '#6b7280',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '6px 12px',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Base64 Encoder
          </button>
          <button
            onClick={handleApplySettings}
            disabled={!isDirty}
            style={{
              background: isDirty ? '#2563eb' : '#d1d5db',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '6px 12px',
              fontSize: 13,
              cursor: isDirty ? 'pointer' : 'not-allowed',
              opacity: isDirty ? 1 : 0.6
            }}
          >
            Apply and Reload
          </button>
        </div>
      );
    }
    return null;
  };


  // Update undo/redo state
  const updateUndoRedoState = () => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  };

  // Add to history
  const addToHistory = (data: any) => {
    const dataStr = JSON.stringify(data);
    
    // Don't add duplicate entries
    if (historyIndexRef.current >= 0) {
      const currentStr = JSON.stringify(historyRef.current[historyIndexRef.current]);
      if (currentStr === dataStr) return;
    }
    
    // Truncate history after current index
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    
    // Add new entry
    historyRef.current.push(JSON.parse(dataStr)); // Deep clone
    historyIndexRef.current = historyRef.current.length - 1;
    
    // Limit history size
    if (historyRef.current.length > 50) {
      historyRef.current.shift();
      historyIndexRef.current--;
    }
    
    updateUndoRedoState();
  };

  // Undo
  const undo = () => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      const previousData = historyRef.current[historyIndexRef.current];
      setFormData(previousData);
      updateData(JSON.parse(JSON.stringify(previousData)));
      updateUndoRedoState();
      console.log('FormEditor: Undo to index', historyIndexRef.current);
    }
  };

  // Redo
  const redo = () => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      const nextData = historyRef.current[historyIndexRef.current];
      setFormData(nextData);
      updateData(JSON.parse(JSON.stringify(nextData)));
      updateUndoRedoState();
      console.log('FormEditor: Redo to index', historyIndexRef.current);
    }
  };

  // Listen for undo/redo keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // CRITICAL: Only process if THIS tab is the active tab
      if (activeTabId !== tabId) {
        return; // Not our tab, ignore all keyboard events
      }
      
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        redo();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, activeTabId, tabId]);

  // Expose undo/redo capability to Edit menu
  useEffect(() => {
    const handleUndoRedoQuery = (e: CustomEvent) => {
      if (e.detail?.fileId === fileId) {
        e.detail.canUndo = canUndo;
        e.detail.canRedo = canRedo;
        e.detail.undo = undo;
        e.detail.redo = redo;
      }
    };
    
    window.addEventListener('dagnet:queryUndoRedo' as any, handleUndoRedoQuery);
    return () => window.removeEventListener('dagnet:queryUndoRedo' as any, handleUndoRedoQuery);
  }, [fileId, canUndo, canRedo]);

  const handleFormChange = (form: any) => {
    const newFormData = form.formData;
    
    // Ignore onChange events that happen within 300ms of form load (RJSF initialization artifacts)
    // But respect ANY change after that window - those are real user edits
    const timeSinceLoad = Date.now() - formLoadTimeRef.current;
    if (hasLoadedRef.current && timeSinceLoad < 300) {
      console.log(`FormEditor: Ignoring onChange within initialization window (${timeSinceLoad}ms after load)`);
      setFormData(newFormData);
      return;
    }
    
    if (!readonly && hasLoadedRef.current) {
      const newDataStr = JSON.stringify(newFormData);
      const currentDataStr = JSON.stringify(data);
      
      console.log('FormEditor: handleFormChange - real user change check', {
        dataChanged: newDataStr !== currentDataStr
      });
      
      // Only update if data actually changed
      if (newDataStr !== currentDataStr) {
        console.log('FormEditor: Form changed, calling updateData (will mark dirty)');
        // Deep clone to ensure new references
        const clonedData = JSON.parse(newDataStr);
        updateData(clonedData);
        
        // Add to history
        addToHistory(clonedData);
      }
    }
    
    // Always update local form state for responsiveness
    setFormData(newFormData);
  };


  // Custom widgets registry for RJSF
  const customWidgets: RegistryWidgetsType = {
    MonacoWidget: MonacoWidget
  };

  // Custom templates registry for RJSF
  const customTemplates: Partial<TemplatesType> = {
    ArrayFieldTemplate: TabbedArrayWidget, // Conditionally renders as tabs when ui:options.tabField is set
    ObjectFieldTemplate: AccordionObjectFieldTemplate // Conditionally renders as accordion when ui:options.accordion = true
  };

  if (!data) {
    return (
      <div className="editor-loading" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        fontSize: '14px',
        color: '#666'
      }}>
        Loading...
      </div>
    );
  }

  return (
    <>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#fafafa',
        overflow: 'auto'
      }}>
        {renderContextualTopbar()}
        <div style={{
          padding: '24px',
          maxWidth: '100%',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box'
        }}>
          {schema && formData ? (
            <Form
              schema={schema}
              formData={formData}
              validator={validator}
              onChange={handleFormChange}
              disabled={readonly}
              liveValidate
              showErrorList={false}
              widgets={customWidgets}
              templates={customTemplates}
              uiSchema={{
                ...uiSchema,
                'ui:submitButtonOptions': {
                  norender: true
                }
              }}
            />
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '200px',
              color: '#666',
              fontSize: '14px'
            }}>
              Loading schema...
            </div>
          )}
        </div>
      </div>
      
      {/* Guarded operation modal for applying credential changes */}
      <GuardedOperationModal
        isOpen={isGuardModalOpen}
        onClose={() => setIsGuardModalOpen(false)}
        onProceed={applyCredentialChanges}
        title="Apply Credential Settings"
        description="Applying new credentials will re-clone the workspace from Git with the updated settings."
        proceedButtonText="Apply and Reload"
        warningMessage="Applying credentials will re-clone the workspace. Any uncommitted changes will be lost unless you commit them first."
        excludeFromDirtyCheck={['credentials-credentials']}
      />
      
      {/* Base64 encoder modal */}
      {isBase64ModalOpen && (
        <div style={{
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
        }}>
          <div style={{
            background: '#fff',
            borderRadius: 8,
            maxWidth: '800px',
            width: '90%',
            maxHeight: '80vh',
            overflow: 'auto',
            position: 'relative',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
          }}>
            <div style={{
              position: 'sticky',
              top: 0,
              background: '#fff',
              borderBottom: '1px solid #e5e7eb',
              padding: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              zIndex: 1
            }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Base64 Encoder</h2>
              <button
                onClick={() => setIsBase64ModalOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  padding: '0 8px',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>
            <Base64EncoderContent />
          </div>
        </div>
      )}
    </>
  );
}

// Inline Base64 Encoder Component (embedded in modal)
function Base64EncoderContent() {
  const [base64Output, setBase64Output] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError('');
    setBase64Output('');
    setCopied(false);

    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const base64 = btoa(content);
        setBase64Output(base64);
      } catch (err) {
        setError(`Failed to encode file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    reader.onerror = () => {
      setError('Failed to read file');
    };

    reader.readAsText(file);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(base64Output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ padding: '16px' }}>
      <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '16px' }}>
        Upload your service account JSON file to get its base64 encoding for credentials.yaml
      </p>

      <label style={{
        display: 'block',
        width: '100%',
        padding: '32px',
        border: '2px dashed #d1d5db',
        borderRadius: 8,
        textAlign: 'center',
        cursor: 'pointer',
        background: '#f9fafb',
        marginBottom: '16px',
        transition: 'all 0.2s'
      }}>
        <input
          type="file"
          hidden
          onChange={handleFileUpload}
          accept=".json,.txt,.yaml,.yml"
        />
        <div style={{ fontSize: '14px', color: '#6b7280' }}>
          Click to select file or drag and drop
        </div>
        <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
          JSON, YAML, or TXT files
        </div>
      </label>

      {fileName && (
        <div style={{
          padding: '12px',
          background: '#dbeafe',
          border: '1px solid #93c5fd',
          borderRadius: 4,
          marginBottom: '16px',
          fontSize: '14px',
          color: '#1e40af'
        }}>
          📄 {fileName}
        </div>
      )}

      {error && (
        <div style={{
          padding: '12px',
          background: '#fee2e2',
          border: '1px solid #fca5a5',
          borderRadius: 4,
          marginBottom: '16px',
          fontSize: '14px',
          color: '#991b1b'
        }}>
          ⚠️ {error}
        </div>
      )}

      {base64Output && (
        <>
          <textarea
            readOnly
            value={base64Output}
            style={{
              width: '100%',
              minHeight: '200px',
              fontFamily: 'monospace',
              fontSize: '12px',
              padding: '12px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              marginBottom: '16px',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
          
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? '#10b981' : '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                padding: '8px 16px',
                fontSize: '14px',
                cursor: 'pointer',
                fontWeight: 500
              }}
            >
              {copied ? '✓ Copied!' : 'Copy to Clipboard'}
            </button>
            
            <span style={{ fontSize: '12px', color: '#6b7280' }}>
              {base64Output.length.toLocaleString()} characters
            </span>
          </div>

          <div style={{
            marginTop: '16px',
            padding: '12px',
            background: '#f3f4f6',
            borderRadius: 4,
            fontSize: '12px',
            color: '#374151'
          }}>
            <strong>Next step:</strong> Paste into credentials.yaml under:<br />
            <code style={{
              background: '#fff',
              padding: '2px 6px',
              borderRadius: 3,
              fontFamily: 'monospace'
            }}>
              providers.google-sheets.service_account_json_b64
            </code>
          </div>
        </>
      )}
    </div>
  );
}

