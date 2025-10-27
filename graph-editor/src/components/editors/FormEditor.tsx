import React, { useState, useEffect, useRef } from 'react';
import { EditorProps } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { RJSFSchema } from '@rjsf/utils';
import yaml from 'js-yaml';

/**
 * Form Editor
 * 
 * Generic form editor for Parameters, Contexts, and Cases
 * Uses @rjsf/core for JSON Schema forms
 */
export function FormEditor({ fileId, readonly = false }: EditorProps) {
  const { data, isDirty, updateData } = useFileState(fileId);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [viewMode, setViewMode] = useState<'form' | 'json' | 'yaml'>('form');
  const [jsonText, setJsonText] = useState('');
  const [yamlText, setYamlText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const isInitialMount = useRef(true);

  // Determine object type from fileId
  const objectType = fileId.split('-')[0] as 'parameter' | 'context' | 'case';

  // Load schema based on object type
  useEffect(() => {
    const loadSchema = async () => {
      try {
        // Try to load schema from paramRegistryService
        const { paramRegistryService } = await import('../../services/paramRegistryService');
        
        let schemaName = '';
        if (objectType === 'parameter') {
          schemaName = 'parameter-schema.yaml';
        } else if (objectType === 'context') {
          schemaName = 'context-schema.yaml';
        } else if (objectType === 'case') {
          schemaName = 'case-parameter-schema.yaml';
        }
        
        if (schemaName) {
          console.log(`FormEditor: Loading schema ${schemaName}...`);
          const loadedSchema = await paramRegistryService.loadSchema(schemaName);
          console.log(`FormEditor: Loaded schema:`, loadedSchema);
          setSchema(loadedSchema as RJSFSchema);
        } else {
          throw new Error('Unknown object type');
        }
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

  // Update JSON/YAML text when data changes
  useEffect(() => {
    if (data) {
      console.log('FormEditor: Data changed, updating text views');
      setJsonText(JSON.stringify(data, null, 2));
      try {
        setYamlText(yaml.dump(data, { indent: 2, lineWidth: -1 }));
      } catch (e) {
        console.error('Failed to convert to YAML:', e);
      }
    }
  }, [data]);

  // Reset initial mount flag when fileId changes (new file loaded)
  useEffect(() => {
    isInitialMount.current = true;
  }, [fileId]);

  const handleFormChange = (formData: any) => {
    // Skip first onChange call (happens on mount)
    if (isInitialMount.current) {
      console.log('FormEditor: Skipping initial form change (mount)');
      isInitialMount.current = false;
      return;
    }
    
    if (!readonly) {
      console.log('FormEditor: Form changed, updating data');
      updateData(formData.formData);
    }
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonText(e.target.value);
    setParseError(null);
    
    try {
      const parsed = JSON.parse(e.target.value);
      if (!readonly) {
        updateData(parsed);
      }
    } catch (error) {
      setParseError((error as Error).message);
    }
  };

  const handleYamlChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setYamlText(e.target.value);
    setParseError(null);
    
    try {
      const parsed = yaml.load(e.target.value);
      if (!readonly) {
        updateData(parsed);
      }
    } catch (error) {
      setParseError((error as Error).message);
    }
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
    <div className="form-editor" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#fff'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid #e0e0e0',
        background: '#f8f9fa'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#333' }}>
            {objectType.charAt(0).toUpperCase() + objectType.slice(1)} Editor
          </span>
          {isDirty && (
            <span style={{
              fontSize: '12px',
              color: '#ff9800',
              background: '#fff3e0',
              padding: '2px 8px',
              borderRadius: '4px'
            }}>
              Modified
            </span>
          )}
          {readonly && (
            <span style={{
              fontSize: '12px',
              color: '#666',
              background: '#e0e0e0',
              padding: '2px 8px',
              borderRadius: '4px'
            }}>
              Read-only
            </span>
          )}
        </div>

        {/* View mode toggle */}
        <div style={{
          display: 'flex',
          gap: '4px',
          background: '#fff',
          padding: '4px',
          borderRadius: '4px',
          border: '1px solid #e0e0e0'
        }}>
          {['form', 'json', 'yaml'].map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode as any)}
              style={{
                padding: '6px 12px',
                border: 'none',
                background: viewMode === mode ? '#1976d2' : 'transparent',
                color: viewMode === mode ? '#fff' : '#666',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
                transition: 'all 0.2s'
              }}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px'
      }}>
        {viewMode === 'form' && schema ? (
          <Form
            schema={schema}
            formData={data}
            validator={validator}
            onChange={handleFormChange}
            disabled={readonly}
            liveValidate
          />
        ) : viewMode === 'json' ? (
          <div>
            {parseError && (
              <div style={{
                padding: '8px 12px',
                background: '#ffebee',
                color: '#c62828',
                borderRadius: '4px',
                marginBottom: '12px',
                fontSize: '13px'
              }}>
                Parse Error: {parseError}
              </div>
            )}
            <textarea
              value={jsonText}
              onChange={handleJsonChange}
              readOnly={readonly}
              style={{
                width: '100%',
                height: 'calc(100% - 40px)',
                minHeight: '400px',
                fontFamily: 'Monaco, Consolas, monospace',
                fontSize: '13px',
                padding: '12px',
                border: '1px solid #e0e0e0',
                borderRadius: '4px',
                resize: 'vertical'
              }}
              spellCheck={false}
            />
          </div>
        ) : (
          <div>
            {parseError && (
              <div style={{
                padding: '8px 12px',
                background: '#ffebee',
                color: '#c62828',
                borderRadius: '4px',
                marginBottom: '12px',
                fontSize: '13px'
              }}>
                Parse Error: {parseError}
              </div>
            )}
            <textarea
              value={yamlText}
              onChange={handleYamlChange}
              readOnly={readonly}
              style={{
                width: '100%',
                height: 'calc(100% - 40px)',
                minHeight: '400px',
                fontFamily: 'Monaco, Consolas, monospace',
                fontSize: '13px',
                padding: '12px',
                border: '1px solid #e0e0e0',
                borderRadius: '4px',
                resize: 'vertical'
              }}
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

