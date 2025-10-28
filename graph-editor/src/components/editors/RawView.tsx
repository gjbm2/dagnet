import React, { useState, useEffect } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import * as yaml from 'js-yaml';
import { EditorProps, ViewMode } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import './RawView.css';

/**
 * Raw View Editor
 * 
 * Monaco editor for viewing/editing raw JSON or YAML
 * Supports syntax highlighting, validation, and formatting
 */
export function RawView({ fileId, viewMode, readonly = false }: EditorProps) {
  const { data, isDirty, updateData } = useFileState(fileId);
  const [editorValue, setEditorValue] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lineWrap, setLineWrap] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [originalValue, setOriginalValue] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [lastValidData, setLastValidData] = useState<any>(null);

  const isYAML = viewMode === 'raw-yaml';
  const language = isYAML ? 'yaml' : 'json';

  // Convert data to string format - syncs when data changes from other views
  useEffect(() => {
    if (!data) {
      console.log(`RawView[${fileId}]: No data, skipping editor update`);
      return;
    }

    console.log(`RawView[${fileId}]: Data changed, updating editor value`);
    
    try {
      const newValue = isYAML 
        ? yaml.dump(data, { indent: 2, lineWidth: 120 })
        : JSON.stringify(data, null, 2);
      
      console.log(`RawView[${fileId}]: Setting editor value, length:`, newValue.length);
      setEditorValue(newValue);
      setOriginalValue(newValue); // Store original for diff
      setLastValidData(data); // Store last valid data
      setParseError(null);
      setIsValid(true);
    } catch (error: any) {
      console.error(`RawView[${fileId}]: Error formatting data:`, error);
      setParseError(error.message);
    }
  }, [data, isYAML, fileId]);

  const handleEditorChange = (value: string | undefined) => {
    if (!value || readonly) return;

    setEditorValue(value);

    // Try to parse and validate
    try {
      let parsedData;
      if (isYAML) {
        parsedData = yaml.load(value);
      } else {
        parsedData = JSON.parse(value);
      }

      // Validation passed - update data and clear errors
      setParseError(null);
      setIsValid(true);
      setLastValidData(parsedData);
      updateData(parsedData);
    } catch (error: any) {
      // Parse failed - show error but don't update data
      setParseError(error.message);
      setIsValid(false);
      console.warn(`RawView[${fileId}]: Invalid ${language} - other views may show errors:`, error.message);
    }
  };

  const handleRevertToLastValid = () => {
    if (lastValidData) {
      setEditorValue(isYAML ? yaml.dump(lastValidData, { indent: 2, lineWidth: 120 }) : JSON.stringify(lastValidData, null, 2));
      setParseError(null);
      setIsValid(true);
      updateData(lastValidData);
    }
  };

  const handleFormat = () => {
    if (readonly) return;

    try {
      let parsedData;
      if (isYAML) {
        parsedData = yaml.load(editorValue);
        setEditorValue(yaml.dump(parsedData, { indent: 2, lineWidth: 120 }));
      } else {
        parsedData = JSON.parse(editorValue);
        setEditorValue(JSON.stringify(parsedData, null, 2));
      }
      setParseError(null);
      updateData(parsedData);
    } catch (error: any) {
      setParseError(error.message);
    }
  };

  if (!data) {
    return (
      <div className="editor-loading">
        Loading...
      </div>
    );
  }

  return (
    <div className="raw-view-editor">
      <div className="raw-view-toolbar">
        <div className="raw-view-info">
          <span className="raw-view-language">{language.toUpperCase()}</span>
          {isDirty && <span className="raw-view-dirty">● Modified</span>}
          {!isValid && <span className="raw-view-invalid">⚠️ Invalid</span>}
          {readonly && <span className="raw-view-readonly">Read-only</span>}
        </div>

        <div className="raw-view-actions">
          <button 
            className={`raw-view-button ${lineWrap ? 'active' : ''}`}
            onClick={() => setLineWrap(!lineWrap)}
            title="Toggle Line Wrap"
          >
            {lineWrap ? '📄' : '📃'} Wrap
          </button>
          
          <button 
            className={`raw-view-button ${showDiff ? 'active' : ''}`}
            onClick={() => setShowDiff(!showDiff)}
            title="Show Diff Since Load"
          >
            {showDiff ? '👁️' : '👁️‍🗨️'} Diff
          </button>
          
          {!readonly && (
            <>
              <button 
                className="raw-view-button"
                onClick={handleFormat}
                title="Format Document"
              >
                Format
              </button>
              {!isValid && (
                <button 
                  className="raw-view-button raw-view-button-danger"
                  onClick={handleRevertToLastValid}
                  title="Revert to Last Valid State"
                >
                  🔄 Revert
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {parseError && (
        <div className="raw-view-error">
          <strong>Parse Error:</strong> {parseError}
        </div>
      )}

      <div className="raw-view-editor-container">
        {showDiff ? (
          <DiffEditor
            height="100%"
            language={language}
            original={originalValue}
            modified={editorValue}
            onChange={(value) => {
              if (value && !readonly) {
                setEditorValue(value);
                // Parse and update data
                try {
                  let parsedData;
                  if (isYAML) {
                    parsedData = yaml.load(value);
                  } else {
                    parsedData = JSON.parse(value);
                  }
                  setParseError(null);
                  updateData(parsedData);
                } catch (error: any) {
                  setParseError(error.message);
                }
              }
            }}
            theme="vs-light"
            options={{
              readOnly: readonly,
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: lineWrap ? 'on' : 'off',
              automaticLayout: true,
              fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'Courier New', monospace",
              fontLigatures: false,
              renderWhitespace: 'selection',
              // Diff-specific options
              enableSplitViewResizing: true,
              renderSideBySide: true,
              ignoreTrimWhitespace: false,
              renderIndicators: true,
              originalEditable: false
            }}
          />
        ) : (
          <Editor
            height="100%"
            language={language}
            value={editorValue}
            onChange={handleEditorChange}
            theme="vs-light"
            options={{
              readOnly: readonly,
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: lineWrap ? 'on' : 'off',
              tabSize: 2,
              automaticLayout: true,
              fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'Courier New', monospace",
              fontLigatures: false,
              renderWhitespace: 'selection'
            }}
          />
        )}
      </div>
    </div>
  );
}

