import React, { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
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

  const isYAML = viewMode === 'raw-yaml';
  const language = isYAML ? 'yaml' : 'json';

  // Convert data to string format
  useEffect(() => {
    if (!data) return;

    try {
      if (isYAML) {
        setEditorValue(yaml.dump(data, { indent: 2, lineWidth: 120 }));
      } else {
        setEditorValue(JSON.stringify(data, null, 2));
      }
      setParseError(null);
    } catch (error: any) {
      setParseError(error.message);
    }
  }, [data, isYAML]);

  const handleEditorChange = (value: string | undefined) => {
    if (!value || readonly) return;

    setEditorValue(value);

    // Try to parse and update data
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
      // Don't update data if parse fails, but show error
      setParseError(error.message);
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
          {readonly && <span className="raw-view-readonly">Read-only</span>}
        </div>

        <div className="raw-view-actions">
          {!readonly && (
            <button 
              className="raw-view-button"
              onClick={handleFormat}
              title="Format Document"
            >
              Format
            </button>
          )}
        </div>
      </div>

      {parseError && (
        <div className="raw-view-error">
          <strong>Parse Error:</strong> {parseError}
        </div>
      )}

      <div className="raw-view-editor-container">
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
            wordWrap: 'off',
            tabSize: 2,
            automaticLayout: true,
            fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'Courier New', monospace",
            fontLigatures: false,
            renderWhitespace: 'selection'
          }}
        />
      </div>
    </div>
  );
}

