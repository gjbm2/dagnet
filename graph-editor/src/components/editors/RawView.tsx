import React, { useState, useEffect, useRef } from 'react';
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
  const { data, isDirty, updateData, originalData } = useFileState(fileId);
  const [editorValue, setEditorValue] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lineWrap, setLineWrap] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [originalValue, setOriginalValue] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [lastValidData, setLastValidData] = useState<any>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const isEditorChangeRef = useRef(false);
  const parseDebounceRef = useRef<number | null>(null);
  const resetEditorFlagTimeoutRef = useRef<number | null>(null);

  const isYAML = viewMode === 'raw-yaml';
  const language = isYAML ? 'yaml' : 'json';

  // Convert data to string format - syncs when data changes from other views
  useEffect(() => {
    if (!data) {
      console.log(`RawView[${fileId}]: No data, skipping editor update`);
      return;
    }

    // Skip if this data change originated from the editor itself
    if (isEditorChangeRef.current) {
      console.log(`RawView[${fileId}]: Skipping editor update - change originated from editor`);
      // Don't reset the flag here - it will be reset after a delay
      return;
    }

    console.log(`RawView[${fileId}]: Data changed, updating editor value`);
    
    try {
      const newValue = isYAML 
        ? yaml.dump(data, { indent: 2, lineWidth: 120 })
        : JSON.stringify(data, null, 2);
      
      console.log(`RawView[${fileId}]: Setting editor value, length:`, newValue.length);
      setEditorValue(newValue);
      setLastValidData(data); // Store last valid data
      setParseError(null);
      setIsValid(true);
    } catch (error: any) {
      console.error(`RawView[${fileId}]: Error formatting data:`, error);
      setParseError(error.message);
    }
  }, [data, isYAML, fileId]);

  // Update original value for diff view when originalData changes
  useEffect(() => {
    if (!originalData) {
      console.log(`RawView[${fileId}]: No original data, skipping original value update`);
      return;
    }

    try {
      const originalValue = isYAML 
        ? yaml.dump(originalData, { indent: 2, lineWidth: 120 })
        : JSON.stringify(originalData, null, 2);
      
      setOriginalValue(originalValue);
    } catch (error: any) {
      console.error(`RawView[${fileId}]: Error formatting original data:`, error);
    }
  }, [originalData, isYAML, fileId]);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (parseDebounceRef.current !== null) {
        clearTimeout(parseDebounceRef.current);
      }
      if (resetEditorFlagTimeoutRef.current !== null) {
        clearTimeout(resetEditorFlagTimeoutRef.current);
      }
    };
  }, []);

  const handleEditorChange = (value: string | undefined) => {
    console.log(`RawView[${fileId}]: Editor change detected, value:`, value?.substring(0, 100), 'length:', value?.length);
    if (value === undefined || readonly) return;

    setEditorValue(value);

    // Clear any pending parse
    if (parseDebounceRef.current !== null) {
      clearTimeout(parseDebounceRef.current);
    }

    // Debounce parsing and data updates to avoid race conditions during fast typing
    parseDebounceRef.current = window.setTimeout(() => {
      console.log(`RawView[${fileId}]: Debounce fired, parsing and updating data`);
      
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
        
        // Mark that this change originated from the editor before updating
        isEditorChangeRef.current = true;
        updateData(parsedData);
        
        // Reset the flag after enough time for the round-trip (debounce + graph processing + sync back)
        if (resetEditorFlagTimeoutRef.current !== null) {
          clearTimeout(resetEditorFlagTimeoutRef.current);
        }
        resetEditorFlagTimeoutRef.current = window.setTimeout(() => {
          console.log(`RawView[${fileId}]: Resetting editor change flag`);
          isEditorChangeRef.current = false;
          resetEditorFlagTimeoutRef.current = null;
        }, 500); // Wait 500ms for the round-trip
      } catch (error: any) {
        // Parse failed - show error but don't update data
        setParseError(error.message);
        setIsValid(false);
        console.warn(`RawView[${fileId}]: Invalid ${language} - parsing failed:`, error.message);
      }
      
      parseDebounceRef.current = null;
    }, 300); // Wait 300ms after last keystroke
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

      <div className="raw-view-editor-container" ref={editorContainerRef}>
        {showDiff ? (
          <DiffEditor
            height="100%"
            language={language}
            original={originalValue}
            modified={editorValue}
            onMount={(editor, monaco) => {
              // Configure Monaco to be more permissive with JSON editing
              if (language === 'json') {
                // Disable JSON validation that might prevent editing
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                  validate: false,
                  allowComments: true,
                  schemas: []
                });
                
                // Configure both editors in the diff view
                const originalEditor = editor.getOriginalEditor();
                const modifiedEditor = editor.getModifiedEditor();
                
                [originalEditor, modifiedEditor].forEach(ed => {
                  ed.updateOptions({
                    readOnly: readonly,
                    // Disable any features that might interfere with editing
                    quickSuggestions: false,
                    suggestOnTriggerCharacters: false,
                    acceptSuggestionOnEnter: 'off',
                    tabCompletion: 'off',
                    wordBasedSuggestions: 'off'
                  });
                });
              }
              
              // Add debugging for key events in diff editor
              const modifiedEditor = editor.getModifiedEditor();
              modifiedEditor.onKeyDown((e) => {
                console.log(`RawView[${fileId}]: Diff editor key pressed:`, e.keyCode, e.code, 'ctrlKey:', e.ctrlKey, 'metaKey:', e.metaKey);
                if (e.keyCode === 32) {
                  console.log(`RawView[${fileId}]: DIFF EDITOR SPACE KEY DETECTED!`);
                }
              });
              
              // Listen for changes in the modified editor
              modifiedEditor.onDidChangeModelContent(() => {
                if (readonly) return;
                
                const value = modifiedEditor.getValue();
                setEditorValue(value);
                
                // Clear any pending parse
                if (parseDebounceRef.current !== null) {
                  clearTimeout(parseDebounceRef.current);
                }
                
                // Debounce parsing and data updates to avoid race conditions during fast typing
                parseDebounceRef.current = window.setTimeout(() => {
                  console.log(`RawView[${fileId}]: Diff editor debounce fired, parsing and updating data`);
                  
                  // Parse and update data
                  try {
                    let parsedData;
                    if (isYAML) {
                      parsedData = yaml.load(value);
                    } else {
                      parsedData = JSON.parse(value);
                    }
                    setParseError(null);
                    
                    // Mark that this change originated from the editor before updating
                    isEditorChangeRef.current = true;
                    updateData(parsedData);
                    
                    // Reset the flag after enough time for the round-trip
                    if (resetEditorFlagTimeoutRef.current !== null) {
                      clearTimeout(resetEditorFlagTimeoutRef.current);
                    }
                    resetEditorFlagTimeoutRef.current = window.setTimeout(() => {
                      console.log(`RawView[${fileId}]: Resetting editor change flag (diff editor)`);
                      isEditorChangeRef.current = false;
                      resetEditorFlagTimeoutRef.current = null;
                    }, 500); // Wait 500ms for the round-trip
                  } catch (error: any) {
                    setParseError(error.message);
                  }
                  
                  parseDebounceRef.current = null;
                }, 300); // Wait 300ms after last keystroke
              });
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
              // Ensure all editing is allowed
              selectOnLineNumbers: true,
              roundedSelection: false,
              cursorStyle: 'line',
              cursorBlinking: 'blink',
              contextmenu: true,
              mouseWheelZoom: false,
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
            onMount={(editor, monaco) => {
              // Configure Monaco to be more permissive with JSON editing
              if (language === 'json') {
                // Disable JSON validation that might prevent editing
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                  validate: false,
                  allowComments: true,
                  schemas: []
                });
                
                // Ensure the editor allows all editing operations
                editor.updateOptions({
                  readOnly: readonly,
                  // Disable any features that might interfere with editing
                  quickSuggestions: false,
                  suggestOnTriggerCharacters: false,
                  acceptSuggestionOnEnter: 'off',
                  tabCompletion: 'off',
                  wordBasedSuggestions: 'off'
                });
              }
              
              // Add debugging for key events
              editor.onKeyDown((e) => {
                console.log(`RawView[${fileId}]: Key pressed:`, e.keyCode, e.code, 'ctrlKey:', e.ctrlKey, 'metaKey:', e.metaKey);
                if (e.keyCode === 32) {
                  console.log(`RawView[${fileId}]: SPACE KEY DETECTED!`);
                }
              });
            }}
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
              renderWhitespace: 'selection',
              // Ensure all editing is allowed
              selectOnLineNumbers: true,
              roundedSelection: false,
              cursorStyle: 'line',
              cursorBlinking: 'blink',
              contextmenu: true,
              mouseWheelZoom: false,
              insertSpaces: true,
              detectIndentation: true,
              trimAutoWhitespace: false
            }}
          />
        )}
      </div>
    </div>
  );
}

