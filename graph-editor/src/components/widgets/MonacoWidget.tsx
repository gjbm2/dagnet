import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { WidgetProps } from '@rjsf/utils';
import { Box, Typography } from '@mui/material';

/**
 * MonacoWidget for React JSON Schema Form
 * 
 * Rich code editor for JSON, YAML, JavaScript, and other code-like fields
 * Used in connections.yaml FormEditor for:
 * - body_template (JSON)
 * - connection_string_schema (JSON Schema)
 * - pre_request.script (JavaScript)
 * - response.extract.jmes (JMESPath)
 * - transform.jsonata (JSONata)
 */
export function MonacoWidget(props: WidgetProps) {
  const {
    id,
    value,
    onChange,
    onBlur,
    onFocus,
    options,
    disabled,
    readonly,
    label,
    schema
  } = props;

  // Extract options from ui:options or use defaults
  const height = (options?.height as string) || '200px';
  const language = (options?.language as string) || 'json';
  const minimap = (options?.minimap as boolean) !== false; // default true
  const lineNumbers = (options?.lineNumbers as string) || 'on';
  const wordWrap = (options?.wordWrap as string) || 'off';
  const fontSize = (options?.fontSize as number) || 14;
  const showLabel = (options?.showLabel as boolean) !== false; // default true

  const [editorValue, setEditorValue] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const editorRef = useRef<any>(null);
  const isUpdatingRef = useRef(false);

  // Initialize editor value from props
  useEffect(() => {
    if (value === undefined || value === null) {
      setEditorValue('');
      return;
    }

    // If value is already a string, use it directly
    if (typeof value === 'string') {
      setEditorValue(value);
      return;
    }

    // If value is an object, stringify it for JSON/YAML languages
    if (language === 'json' || language === 'yaml') {
      try {
        const stringified = JSON.stringify(value, null, 2);
        setEditorValue(stringified);
      } catch (error: any) {
        console.error('[MonacoWidget] Error stringifying value:', error);
        setParseError(error.message);
        setEditorValue(String(value));
      }
    } else {
      // For other languages, convert to string
      setEditorValue(String(value));
    }
  }, [value, language]);

  const handleEditorChange = (newValue: string | undefined) => {
    if (isUpdatingRef.current) return;

    const textValue = newValue || '';
    setEditorValue(textValue);
    setParseError(null);

    // For JSON/YAML, try to parse before calling onChange
    if (language === 'json' || language === 'yaml') {
      try {
        const parsed = language === 'json' 
          ? JSON.parse(textValue || '{}')
          : textValue; // For YAML, keep as string (FormEditor will handle parsing)
        
        isUpdatingRef.current = true;
        onChange(parsed);
        setTimeout(() => { isUpdatingRef.current = false; }, 50);
      } catch (error: any) {
        // Store parse error but don't call onChange with invalid data
        setParseError(error.message);
        console.warn('[MonacoWidget] Parse error:', error.message);
      }
    } else {
      // For other languages (JS, JMESPath, JSONata), pass string directly
      isUpdatingRef.current = true;
      onChange(textValue);
      setTimeout(() => { isUpdatingRef.current = false; }, 50);
    }
  };

  const handleEditorMount = (editor: any) => {
    editorRef.current = editor;
    
    // Add custom validation markers for JSON
    if (language === 'json' && parseError) {
      const model = editor.getModel();
      if (model) {
        // Monaco will show syntax errors automatically
        // We just store our error for display
      }
    }
  };

  const handleBlur = () => {
    if (onBlur) {
      onBlur(id, editorValue);
    }
  };

  const handleFocus = () => {
    if (onFocus) {
      onFocus(id, editorValue);
    }
  };

  return (
    <Box sx={{ mb: 2 }}>
      {showLabel && label && (
        <Typography
          variant="body2"
          sx={{
            mb: 0.5,
            fontWeight: 500,
            color: disabled || readonly ? 'text.disabled' : 'text.primary'
          }}
        >
          {label}
          {schema.description && (
            <Typography
              component="span"
              variant="caption"
              sx={{ ml: 1, color: 'text.secondary', fontStyle: 'italic' }}
            >
              {schema.description}
            </Typography>
          )}
        </Typography>
      )}
      
      <Box
        sx={{
          border: parseError ? '2px solid #d32f2f' : '1px solid #e0e0e0',
          borderRadius: 1,
          overflow: 'hidden',
          opacity: disabled || readonly ? 0.6 : 1
        }}
      >
        <Editor
          height={height}
          language={language}
          value={editorValue}
          onChange={handleEditorChange}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: minimap },
            lineNumbers: lineNumbers as any,
            readOnly: disabled || readonly,
            wordWrap: wordWrap as any,
            fontSize,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            insertSpaces: true,
            formatOnPaste: true,
            formatOnType: language === 'json' || language === 'yaml',
            // Additional Monaco options
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            parameterHints: { enabled: true },
            folding: true,
            glyphMargin: false,
            lineDecorationsWidth: 10,
            lineNumbersMinChars: 3,
            renderLineHighlight: 'line',
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              useShadows: false
            }
          }}
          theme="vs-light"
          loading={<Box sx={{ p: 2, textAlign: 'center' }}>Loading editor...</Box>}
        />
      </Box>
      
      {parseError && (
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 0.5,
            color: 'error.main',
            fontFamily: 'monospace',
            fontSize: '0.75rem'
          }}
        >
          ⚠️ {parseError}
        </Typography>
      )}
      
      {schema.description && !showLabel && (
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 0.5,
            color: 'text.secondary',
            fontStyle: 'italic'
          }}
        >
          {schema.description}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Monaco Widget Factory
 * Creates a widget instance with specific language/options pre-configured
 */
export function createMonacoWidget(defaultLanguage: string, defaultOptions?: any) {
  return function MonacoWidgetWithDefaults(props: WidgetProps) {
    const mergedOptions = {
      language: defaultLanguage,
      ...defaultOptions,
      ...props.options
    };
    
    return <MonacoWidget {...props} options={mergedOptions} />;
  };
}

// Convenience exports for common use cases
export const JsonMonacoWidget = createMonacoWidget('json', { height: '300px' });
export const YamlMonacoWidget = createMonacoWidget('yaml', { height: '300px' });
export const JavaScriptMonacoWidget = createMonacoWidget('javascript', { height: '400px' });
export const JMESPathMonacoWidget = createMonacoWidget('jmespath', { height: '150px' });
export const JSONataMonacoWidget = createMonacoWidget('jsonata', { height: '150px' });

