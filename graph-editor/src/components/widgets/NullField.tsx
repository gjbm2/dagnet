import React, { useState, useRef, useCallback } from 'react';
import { FieldProps } from '@rjsf/utils';

/**
 * NullField — a custom RJSF *field* (not widget/template) that renders a
 * compact, collapsed summary instead of recursing into the full subtree.
 *
 * Use via `"ui:field": "NullField"` in a UI schema.  Unlike
 * `"ui:widget": "hidden"` (which still instantiates form controls for every
 * array element), NullField prevents RJSF from recursing at all — keeping
 * the initial render cost near zero.
 *
 * Clicking the summary expands an editable JSON textarea.  Changes are
 * parsed and committed to formData on blur.
 *
 * Data is preserved: RJSF keeps formData fields that aren't rendered unless
 * the `omitExtraData` prop is set (we don't set it).
 */
export function NullField(props: FieldProps) {
  const { formData, name, schema, onChange, readonly, disabled } = props;
  const [expanded, setExpanded] = useState(false);
  const [editText, setEditText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const label = name || schema.title || 'data';
  const summary = summarise(formData);
  const isReadonly = readonly || disabled;

  const handleExpand = useCallback(() => {
    if (!expanded) {
      setEditText(JSON.stringify(formData, null, 2));
      setParseError(null);
    }
    setExpanded(!expanded);
  }, [expanded, formData]);

  const handleBlur = useCallback(() => {
    if (isReadonly) return;
    try {
      const parsed = JSON.parse(editText);
      setParseError(null);
      onChange(parsed);
    } catch (e: any) {
      setParseError(e.message);
    }
  }, [editText, onChange, isReadonly]);

  return (
    <div style={{ margin: '2px 0' }}>
      <button
        type="button"
        onClick={handleExpand}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'monospace',
          color: 'var(--text-secondary, #888)',
          textAlign: 'left',
          width: '100%',
        }}
        title={expanded ? 'Collapse' : 'Click to inspect / edit raw data'}
      >
        <span style={{ marginRight: '4px', display: 'inline-block', width: '10px' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ opacity: 0.6 }}>{label}</span>
        {!expanded && (
          <span style={{ marginLeft: '8px', opacity: 0.4 }}>{summary}</span>
        )}
      </button>
      {expanded && (
        <div style={{ margin: '4px 0 4px 16px' }}>
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleBlur}
            readOnly={isReadonly}
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: '80px',
              maxHeight: '400px',
              padding: '8px',
              fontSize: '11px',
              fontFamily: 'monospace',
              background: isReadonly
                ? 'var(--bg-tertiary, #f5f5f5)'
                : 'var(--bg-primary, #fff)',
              color: 'var(--text-primary, #333)',
              border: `1px solid ${parseError ? '#e53e3e' : 'var(--border-primary, #e0e0e0)'}`,
              borderRadius: '4px',
              resize: 'vertical',
              whiteSpace: 'pre',
              tabSize: 2,
              boxSizing: 'border-box',
            }}
          />
          {parseError && (
            <div style={{
              fontSize: '11px',
              color: '#e53e3e',
              marginTop: '2px',
              fontFamily: 'monospace',
            }}>
              JSON error: {parseError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Produce a one-line summary like "[142 items]" or "{5 keys}" or "0.832" */
function summarise(data: unknown): string {
  if (data === null || data === undefined) return 'null';
  if (Array.isArray(data)) return `[${data.length} items]`;
  if (typeof data === 'object') return `{${Object.keys(data as object).length} keys}`;
  const s = String(data);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}
