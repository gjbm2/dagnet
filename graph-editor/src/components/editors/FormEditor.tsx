import React, { useState, useEffect, useRef } from 'react';
import { EditorProps } from '../../types';
import { useFileState, useTabContext, fileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import Form from '@rjsf/mui';
import validator from '@rjsf/validator-ajv8';
import { RJSFSchema } from '@rjsf/utils';
import { getFileTypeConfig, getSchemaFile } from '../../config/fileTypeRegistry';
import { GuardedOperationModal } from '../modals/GuardedOperationModal';

/**
 * Form Editor
 * 
 * Generic form editor for Parameters, Contexts, and Cases
 * Uses @rjsf/mui with Material Design styling
 * Schemas and file type metadata are centrally managed in fileTypeRegistry
 */
export function FormEditor({ fileId, readonly = false }: EditorProps) {
  const { data, isDirty, updateData } = useFileState(fileId);
  const { operations: navOperations } = useNavigatorContext();
  const { operations: tabOperations } = useTabContext();
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [formData, setFormData] = useState<any>(null);
  const initialDataRef = useRef<string>('');
  const hasLoadedRef = useRef(false);
  const firstChangeIgnoredRef = useRef(false); // Track if we've ignored the first spurious onChange
  
  // Undo/redo history
  const historyRef = useRef<any[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  
  // Guarded operation modal state (for Apply Settings)
  const [isGuardModalOpen, setIsGuardModalOpen] = useState(false);

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
    firstChangeIgnoredRef.current = false;
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
          justifyContent: 'flex-end',
          padding: '8px 16px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 10
        }}>
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
  }, [canUndo, canRedo]);

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
    
    // Ignore the very first onChange event from RJSF (it's always fired during initialization)
    if (!firstChangeIgnoredRef.current) {
      console.log('FormEditor: Ignoring first onChange (RJSF initialization artifact)');
      firstChangeIgnoredRef.current = true;
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
              uiSchema={{
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
    </>
  );
}

